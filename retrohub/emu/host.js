/* RetroHub 9 – Emulatorbrücke (läuft auf dem Emulator-Ursprung, Port 8080/8443).
   Empfängt Spieldaten, BIOS und Spielstände per postMessage NUR von der RetroHub-App auf demselben Host
   und startet EmulatorJS mit lokal nachgeladenen Kernen. Kein Netzwerkzugriff nach außen (CSP). */
(function () {
  'use strict';
  var appOrigins = [location.protocol + '//' + location.hostname, location.protocol + '//' + location.hostname + (location.protocol === 'https:' ? ':443' : ':80')];
  var APP = appOrigins[0], started = false, booted = false, pendingSram = null, pendingState = null;
  // EmulatorJS fragt im Debug-Modus beim Hersteller nach Updates. Diese eine Abfrage lokal beantworten,
  // statt sie (von der CSP blockiert) mit Fehlermeldung scheitern zu lassen. Andere Anfragen bleiben unverändert.
  var realFetch = window.fetch.bind(window);
  window.fetch = function (u, o) { if (String(u && u.url || u).indexOf('https://cdn.emulatorjs.org/') === 0) return Promise.resolve(new Response('', { status: 404 })); return realFetch(u, o); };
  // Bildschirmsperre verhindern, wenn erlaubt; Ablehnung (z. B. Energiesparmodus) still behandeln.
  if (navigator.wakeLock && navigator.wakeLock.request) {
    var realLock = navigator.wakeLock.request.bind(navigator.wakeLock);
    var dummy = { released: true, release: function () { return Promise.resolve(); }, addEventListener: function () {}, removeEventListener: function () {} };
    try { navigator.wakeLock.request = function (t) { return realLock(t).catch(function () { return dummy; }); }; } catch (e) { /* nicht überschreibbar */ }
  }
  // Netplay-Bildtakt: EmulatorJS erwartet, dass Emscripten nach jedem Bild Module.postMainLoop aufruft.
  // Die Kerne von EmulatorJS 4.2.3 tun das nicht mehr – ohne Takt sendet der Gastgeber nichts und der Gast wartet.
  // RetroHub ruft die Netplay-Bildschleife daher selbst auf: einmal je neuem Bild (an der Bildnummer erkannt).
  var realRAF = window.requestAnimationFrame.bind(window), lastNetFrame = -1;
  window.requestAnimationFrame = function (cb) {
    return realRAF(function (ts) {
      cb(ts);
      var em = window.EJS_emulator;
      if (!em || !em.isNetplay || !em.Module || typeof em.Module.postMainLoop !== 'function' || !em.gameManager) return;
      var n; try { n = em.gameManager.getFrameNum(); } catch (e) { return; }
      if (n === lastNetFrame) return;
      lastNetFrame = n;
      try { em.Module.postMainLoop(); } catch (e) { /* Netplay-Schleife darf das Spiel nicht anhalten */ }
    });
  };
  function post(m, transfer) { parent.postMessage(m, APP, transfer || []); }
  function msg(t) { var el = document.getElementById('msg'); if (t) { el.textContent = t; el.hidden = false; } else el.hidden = true; }
  function gm() { return window.EJS_emulator && window.EJS_emulator.gameManager; }
  function getStateRetry(tries) {
    return new Promise(function (res, rej) {
      (function attempt(n) { try { res(gm().getState()); } catch (e) { if (n <= 1) rej(e); else setTimeout(function () { attempt(n - 1); }, 1000); } }(tries));
    });
  }
  function makeThumb(png) {
    return createImageBitmap(new Blob([png], { type: 'image/png' })).then(function (img) {
      var c = document.createElement('canvas'), w = 96, h = Math.max(1, Math.round(img.height * 96 / img.width));
      c.width = w; c.height = h; c.getContext('2d').drawImage(img, 0, 0, w, h); return c.toDataURL('image/jpeg', 0.75);
    });
  }
  function thumb() {
    // Das Vorschaubild entsteht nur bei laufender Emulation: kurz fortsetzen, danach Pausenzustand wiederherstellen.
    var em = window.EJS_emulator, wasPaused = em.paused; if (wasPaused) em.play();
    var shot = Promise.race([gm().screenshot(), new Promise(function (res) { setTimeout(function () { res(null); }, 2500); })]);
    return shot.then(function (png) { if (wasPaused) em.pause(); return png ? makeThumb(png).catch(function () { return null; }) : null; }, function () { if (wasPaused) em.pause(); return null; });
  }
  function writeSram(data) {
    try {
      var g = gm(), p = g.getSaveFilePath(), dir = p.substring(0, p.lastIndexOf('/'));
      try { g.FS.mkdirTree(dir); } catch (e) { /* vorhanden */ }
      g.FS.writeFile(p, new Uint8Array(data)); g.loadSaveFiles(); return true;
    } catch (e) { return false; }
  }
  function boot(m) {
    if (booted) return; booted = true;
    if (!/^[a-z0-9_]+$/.test(String(m.core || ''))) { post({ rh: 'error', message: 'Kern unbekannt' }); return; }
    if (m.threads && !self.crossOriginIsolated) { post({ rh: 'error', message: 'Dieses System braucht eine isolierte Seite (Cross-Origin-Isolation). Bitte neu laden.' }); return; }
    var url = URL.createObjectURL(new Blob([m.rom], { type: 'application/octet-stream' }));
    if (m.bios) window.EJS_biosUrl = URL.createObjectURL(new Blob([m.bios], { type: 'application/zip' }));
    pendingSram = m.sram || null; pendingState = m.state || null;
    window.EJS_player = '#game';
    window.EJS_core = m.core;
    window.EJS_gameUrl = url;
    // Dateiname mit Endung: EmulatorJS nutzt ihn bei blob-Adressen als Dateinamen (Arcade: Romset-Name)
    window.EJS_gameName = String(m.fileName || 'spiel').replace(/[#<$+%>!`&*'|{}/\\?"=@:^\r\n]/g, '_');
    window.EJS_gameID = Number(m.gameId) || 0;                 // Netplay verlangt eine Zahl
    window.EJS_netplayServer = location.origin + '/netplay';  // lokaler Netplay-Server (Name laut loader.js)
    window.EJS_pathtodata = '/_emu/ejs/';
    window.EJS_startOnLoaded = true;
    window.EJS_DEBUG_XX = true;            // unminifizierte Quellen aus dem npm-Paket verwenden
    window.EJS_threads = !!m.threads;      // PPSSPP und DOSBox Pure benötigen Threads (SharedArrayBuffer)
    window.EJS_disableDatabases = true;
    window.EJS_language = 'de-GER';
    window.EJS_color = '#7AA2D6';
    window.EJS_Buttons = { saveState: false, loadState: false, quickSave: false, quickLoad: false, saveSavFiles: false, loadSavFiles: false, netplay: !!m.netplay, cacheManager: false, exitEmulation: false, screenRecord: false };
    window.EJS_onGameStart = function () {
      started = true; msg('');
      if (pendingSram) writeSram(pendingSram);
      if (pendingState) { try { gm().loadState(new Uint8Array(pendingState)); } catch (e) { post({ rh: 'error', message: 'Spielstand konnte nicht geladen werden' }); } }
      post({ rh: 'started', crossOriginIsolated: !!self.crossOriginIsolated });
    };
    msg('Lade Emulator …');
    var s = document.createElement('script'); s.src = '/_emu/ejs/loader.js';
    s.onerror = function () { post({ rh: 'error', message: 'Emulator-Dateien fehlen – Admin: Emulatoren laden' }); msg('Emulator-Dateien fehlen.'); };
    document.body.appendChild(s);
    // Startfehler von EmulatorJS erkennen und an die App melden
    var watch = setInterval(function () {
      var em = window.EJS_emulator;
      if (started) { clearInterval(watch); return; }
      if (em && em.failedToStart) {
        clearInterval(watch);
        var t = document.querySelector('.ejs_loading_text');
        post({ rh: 'error', message: 'Das Spiel konnte nicht gestartet werden' + (t && t.innerText ? ': ' + t.innerText : '') });
      }
    }, 1000);
  }
  window.addEventListener('message', function (e) {
    if (appOrigins.indexOf(e.origin) === -1 || e.source !== parent) return; // nur die eigene App
    var m = e.data || {};
    if (m.rh === 'start') { boot(m); return; }
    if (!started) { if (m.id) post({ rh: 'reply', id: m.id, error: 'Spiel läuft noch nicht' }); return; }
    var g = gm();
    try {
      if (m.rh === 'save') {
        var state, sram;
        getStateRetry(5).then(function (st) { state = st; sram = g.getSaveFile(); return thumb(); }).then(function (t) {
          var out = { rh: 'reply', id: m.id, state: state.buffer, sram: sram ? new Uint8Array(sram).buffer : null, thumb: t };
          post(out, [state.buffer].concat(out.sram ? [out.sram] : []));
        }, function (err) { post({ rh: 'reply', id: m.id, error: 'Zustand nicht verfügbar: ' + (err && err.message || err) }); });
      } else if (m.rh === 'load') {
        g.loadState(new Uint8Array(m.state)); window.EJS_emulator.play(); post({ rh: 'reply', id: m.id, ok: true });
      } else if (m.rh === 'pad') {
        // Eingabe eines Handy-Controllers (Couch-Modus): Spieler = Slot, Taste = RetroArch-Joypad-Index
        g.simulateInput(Math.max(0, Math.min(3, Number(m.slot) || 0)), Number(m.button), Number(m.value));
      } else if (m.rh === 'pause') { window.EJS_emulator.pause(); post({ rh: 'reply', id: m.id, ok: true }); }
      else if (m.rh === 'resume') { window.EJS_emulator.play(); post({ rh: 'reply', id: m.id, ok: true }); }
    } catch (err) { if (m.id) post({ rh: 'reply', id: m.id, error: String(err && err.message || err) }); }
  });
  post({ rh: 'ready', crossOriginIsolated: !!self.crossOriginIsolated });
}());
