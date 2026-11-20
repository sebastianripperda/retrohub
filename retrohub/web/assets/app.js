/* RetroHub 9.1.1 – Oberfläche. Läuft im LAN ohne Internet. Daten und Echtzeit über den eigenen RetroHub-Server.
   Sicherheitsregeln: keine Inline-Handler, alle Fremdtexte über esc() bzw. textContent. */
(function () {
  'use strict';

  /* ---------- Hilfsfunktionen ---------- */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function icon(id) { return '<svg class="i" aria-hidden="true"><use href="#i-' + id + '"/></svg>'; }
  function fmtMin(sec) { var m = Math.round((sec || 0) / 60); return m < 60 ? m + ' Min.' : (m / 60).toFixed(1).replace('.', ',') + ' Std.'; }
  function fmtTime(ts) { var d = new Date(ts); return d.toLocaleDateString('de-DE') === new Date().toLocaleDateString('de-DE') ? d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  function fmtBytes(b) { return b > 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : (b / 1048576).toFixed(0) + ' MB'; }
  var COLORS = ['#FF7A66', '#3DD6C1', '#A99BFF', '#FFC94A', '#FF9F5A', '#6CB4FF', '#FF85BA', '#8BE09D'];
  function avatar(u, small) { var i = Math.max(0, COLORS.indexOf(u && u.color)); return '<span class="avatar av-' + i + (small ? ' small' : '') + '" aria-hidden="true">' + esc(((u && (u.display || u.name)) || '?').charAt(0).toUpperCase()) + '</span>'; }
  var local = {
    get: function (k, d) { try { var v = localStorage.getItem('rh.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('rh.' + k, JSON.stringify(v)); } catch (e) { /* nicht verfügbar */ } }
  };


  /* ---------- Spielebibliothek (Emulatoren) ---------- */
  var SYSTEMS = [], SYS = {}, GAMES = [], GAME = {};
  var SYS_ABBR = { nes: 'NES', snes: 'SNES', n64: 'N64', gb: 'GB', gba: 'GBA', nds: 'NDS', vb: 'VB', psx: 'PS1', psp: 'PSP', segaMS: 'SMS', segaMD: 'MD', segaGG: 'GG', segaCD: 'MCD', sega32x: '32X', segaSaturn: 'SAT', atari2600: '2600', atari5200: '5200', atari7800: '7800', lynx: 'LYNX', jaguar: 'JAG', pce: 'PCE', pcfx: 'PC-FX', ngp: 'NGP', ws: 'WS', coleco: 'CV', '3do': '3DO', arcade: 'FBN', mame: 'MAME', amiga: 'AMIGA', c64: 'C64', c128: 'C128', pet: 'PET', plus4: '+4', vic20: 'VIC', dos: 'DOS' };
  function rebuildCatalog(systems, games) {
    if (systems) { SYSTEMS = systems; SYS = {}; systems.forEach(function (s) { SYS[s.key] = s; }); }
    if (games) GAMES = games.map(function (g) { return { id: 'g' + g.id, gid: g.id, title: g.title, system: g.system, systemName: g.systemName, files: g.files, size: g.size, players: g.players, desc: g.desc, year: g.year, genre: g.genre, rating: g.rating, cover: g.cover, discs: g.discs, ready: g.ready, addedAt: g.addedAt, addedBy: g.addedBy }; });
    GAME = {}; GAMES.forEach(function (g) { GAME[g.id] = g; });
  }
  function playable(g) { return !!(g && g.ready); }
  function refreshCatalog() {
    return Promise.all([api('GET', '/api/systems'), api('GET', '/api/library')]).then(function (r) { rebuildCatalog(r[0].systems, r[1].games); state.importDir = r[0].importDir; return r; });
  }
  function makerOf(key) { return SYS[key] ? SYS[key].maker : ''; }
  function glyph(key) { return SYS_ABBR[key] || String(key).toUpperCase(); }
  function spine(key, g) {
    if (g && g.cover) return '<span class="cart-label has-cover" aria-hidden="true"><img src="/api/library/' + g.gid + '/cover?v=' + esc(g.cover) + '" alt="" loading="lazy" decoding="async"><span class="sys-abbr">' + esc(glyph(key)) + '</span></span>';
    return '<span class="cart-label" aria-hidden="true"><span class="sys-abbr">' + esc(glyph(key)) + '</span></span>';
  }
  function ratingText(r) { return r === null || r === undefined ? 'nicht eingestuft' : 'ab ' + r; }
  function sysName(key) { return SYS[key] ? SYS[key].name : key; }
  function notReadyReason(g) { var s = SYS[g.system]; if (!s) return 'System unbekannt'; if (!s.coreInstalled) return 'Emulator fehlt'; if (s.bios === 'required' && !s.biosInstalled) return 'BIOS fehlt'; return ''; }
  function fmtSize(b) { return b >= 1073741824 ? (b / 1073741824).toFixed(1).replace('.', ',') + ' GB' : b >= 1048576 ? (b / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
  // RetroArch-Joypad-Indizes (EmulatorJS simulateInput)
  var PAD = { B: 0, Y: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7, A: 8, X: 9, L: 10, R: 11 };

  /* ---------- Zustand ---------- */
  var state = {
    me: null, setupRequired: false, registration: 'closed',
    filters: { q: '', system: 'alle', maker: 'alle', players: 'Alle', playableOnly: false, sort: 'az' },
    data: { favorites: [], progress: { best: {}, time: {}, plays: {}, last: null }, stats: {} },
    rooms: [], couch: null, couchId: null, myCouch: null,
    friends: null, notifications: [], chat: {}, channel: 'allgemein', tournaments: null, tournamentId: null,
    theme: local.get('theme', 'system'), reduceMotion: local.get('reduceMotion', false), online: false
  };

  /* ---------- Server-API ---------- */
  function api(method, url, body) {
    var opt = { method: method, credentials: 'same-origin', headers: {} };
    if (method !== 'GET') { opt.headers['X-RetroHub'] = '1'; opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body || {}); }
    return fetch(url, opt).then(function (r) {
      return r.text().then(function (t) {
        var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = null; }
        if (!r.ok) {
          var err = new Error((j && j.error) || ('Serverfehler ' + r.status)); err.status = r.status;
          if (r.status === 401 && state.me) loggedOut('Deine Sitzung ist abgelaufen. Bitte neu anmelden.');
          throw err;
        }
        return j;
      });
    }, function () { var e = new Error('Server nicht erreichbar. Netzwerk prüfen.'); e.status = 0; throw e; });
  }
  function errToast(e) { toast(e && e.message ? e.message : 'Fehler'); }

  /* ---------- Echtzeit (WebSocket) ---------- */
  var RT = {
    ws: null, retry: 0, timer: null,
    connect: function () {
      if (!state.me || this.ws) return;
      var self = this, ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
      this.ws = ws;
      ws.onopen = function () { self.retry = 0; setConn(true); if (state.couchId) self.send({ t: 'couch.attach', id: state.couchId }); if (currentView === 'controller') setTimeout(pendingJoin, 200); };
      ws.onmessage = function (e) { var m; try { m = JSON.parse(e.data); } catch (x) { return; } onRealtime(m); };
      ws.onclose = function (e) {
        if (self.ws !== ws) return; self.ws = null; setConn(false);
        if (!state.me) return;
        if (e.code === 4001) { loggedOut('Du wurdest abgemeldet.'); return; }
        if (e.code === 4002) { loggedOut('Die Daten wurden wiederhergestellt. Bitte neu anmelden.'); return; }
        // Vor dem Wiederverbinden prüfen, ob die Sitzung noch gilt (abgelehnter Handshake ist im Browser nicht sichtbar)
        clearTimeout(self.timer);
        self.timer = setTimeout(function () {
          api('GET', '/api/session').then(function (s) { if (!s.user) { if (state.me) loggedOut('Deine Sitzung ist beendet. Bitte neu anmelden.'); } else self.connect(); }, function () { self.timer = setTimeout(function () { self.connect(); }, 3000); });
        }, Math.min(10000, 500 * Math.pow(2, self.retry++)));
      };
    },
    send: function (o) { if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(o)); return true; } toast('Keine Verbindung zum Server – wird wiederhergestellt'); return false; },
    close: function () { var w = this.ws; this.ws = null; clearTimeout(this.timer); if (w) w.close(); setConn(false); }
  };
  function setConn(on) {
    state.online = on;
    var c = $('#conn'); if (!c) return;
    c.classList.toggle('online', on);
    $('#conn-text').textContent = on ? 'Mit RetroHub verbunden' : (state.me ? 'Verbindung wird aufgebaut …' : 'Nicht angemeldet');
    $('#conn-user').textContent = state.me ? 'Angemeldet als ' + state.me.display : '';
  }

  /* ---------- Toast ---------- */
  var toastTimer;
  function toast(msg) { var t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 2800); }

  /* ---------- Farbschema ---------- */
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  function applyTheme() {
    var dark = state.theme === 'dark' || (state.theme === 'system' && !(mq && mq.matches));
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    var btn = $('#theme-toggle');
    btn.setAttribute('aria-label', dark ? 'Helles Farbschema verwenden' : 'Dunkles Farbschema verwenden');
    btn.innerHTML = icon(dark ? 'sun' : 'moon');
    var meta = $('meta[name="theme-color"]'); if (meta) meta.setAttribute('content', dark ? '#14171C' : '#F3F4F6');
    if (state.reduceMotion) document.documentElement.setAttribute('data-motion', 'reduce'); else document.documentElement.removeAttribute('data-motion');
  }
  if (mq && mq.addEventListener) mq.addEventListener('change', applyTheme);

  /* ---------- Favoriten & Fortschritt (serverseitig) ---------- */
  function isFav(id) { return state.data.favorites.indexOf(id) !== -1; }
  function toggleFav(id) {
    var before = state.data.favorites.slice();
    if (isFav(id)) state.data.favorites = state.data.favorites.filter(function (x) { return x !== id; }); else state.data.favorites.push(id);
    $$('[data-fav="' + id + '"]').forEach(function (b) { syncFavButton(b, id); });
    toast(isFav(id) ? GAME[id].title + ' ist jetzt ein Favorit' : GAME[id].title + ' aus Favoriten entfernt');
    api('PUT', '/api/me/favorites', { favorites: state.data.favorites }).catch(function (e) { state.data.favorites = before; $$('[data-fav="' + id + '"]').forEach(function (b) { syncFavButton(b, id); }); errToast(e); });
    if (currentView === 'favoriten') renderFavorites(true);
  }
  function syncFavButton(b, id) {
    b.setAttribute('aria-pressed', String(isFav(id)));
    if (b.classList.contains('fav-inline')) b.textContent = isFav(id) ? 'Aus Favoriten entfernen' : 'Zu Favoriten';
    else b.setAttribute('aria-label', (isFav(id) ? 'Aus Favoriten entfernen: ' : 'Zu Favoriten hinzufügen: ') + GAME[id].title);
  }
  function postProgress(body) {
    return api('POST', '/api/me/progress', body).then(function (r) { state.data.progress = r.progress; return r; }).catch(function (e) { if (e.status !== 401) toast('Spielstand konnte nicht gespeichert werden: ' + e.message); });
  }



  /* ---------- Karten ---------- */
  function playersText(g) { return g.players > 1 ? '1–' + g.players + ' Spieler' : '1 Spieler'; }
  function statusTag(g) { var r = notReadyReason(g); return r ? '<span class="tag warn">' + esc(r) + '</span>' : '<span class="tag ok">Bereit</span>'; }
  function cartHTML(g) {
    return '<li class="cart">' +
      '<button type="button" class="cart-open" data-open="' + esc(g.id) + '">' + spine(g.system, g) +
      '<span class="cart-title">' + esc(g.title) + '</span><span class="cart-cat">' + esc(sysName(g.system)) + '</span>' +
      '<span class="cart-meta"><span class="tag">' + esc(playersText(g)) + '</span>' + statusTag(g) + '</span></button>' +
      '<button type="button" class="fav" data-fav="' + esc(g.id) + '" aria-pressed="' + isFav(g.id) + '" aria-label="' + (isFav(g.id) ? 'Aus Favoriten entfernen: ' : 'Zu Favoriten hinzufügen: ') + esc(g.title) + '">' + icon('heart') + '</button></li>';
  }
  function shelf(list) { return '<ul class="shelf">' + list.map(cartHTML).join('') + '</ul>'; }

  /* ---------- Router ---------- */
  var VIEWS = {
    anmelden: 'Anmelden', home: 'Start', spiele: 'Spiele', favoriten: 'Favoriten', gemeinsam: 'Netplay', couch: 'Couch-Modus', controller: 'Controller',
    turniere: 'Turniere', freunde: 'Freunde', chat: 'Chat', mitteilungen: 'Mitteilungen', profil: 'Profil', einstellungen: 'Einstellungen', admin: 'Administration', mehr: 'Mehr'
  };
  var ADULT_ONLY = { freunde: 1, chat: 1 };
  var currentView = null;
  function route(fromUser) {
    var v = (location.hash || '#home').slice(1), jm = /^join-([A-Za-z2-9]{4})$/.exec(v);
    if (jm) { try { sessionStorage.setItem('rh.join', jm[1].toUpperCase()); } catch (e) { /* ohne Speicher */ } history.replaceState(null, '', '#controller'); v = 'controller'; }
    if (!Object.prototype.hasOwnProperty.call(VIEWS, v)) v = 'home';
    if (!state.me) v = 'anmelden';
    else if (v === 'anmelden') v = 'home';
    if (state.me && ADULT_ONLY[v] && state.me.role === 'child') v = 'home';
    if (state.me && v === 'admin' && state.me.role !== 'admin') v = 'home';
    currentView = v;
    document.body.classList.toggle('auth', v === 'anmelden');
    document.title = VIEWS[v] + ' – RetroHub';
    $$('.nav-link, .bottomnav a').forEach(function (a) {
      var target = a.getAttribute('href').slice(1);
      var active = target === v || (v === 'controller' && target === 'couch') ||
        (a.closest('.bottomnav') && target === 'mehr' && ['couch', 'controller', 'turniere', 'chat', 'profil', 'einstellungen', 'admin', 'mitteilungen', 'favoriten'].indexOf(v) !== -1);
      if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    RENDER[v]();
    if (fromUser) { var main = $('#main'); main.focus({ preventScroll: true }); window.scrollTo(0, 0); }
  }
  function go(v) { if (location.hash === '#' + v) route(true); else location.hash = v; }
  var RENDER = {};


  /* ---------- Anmeldung & Ersteinrichtung ---------- */
  var authMode = 'login';
  RENDER.anmelden = function () {
    var setup = state.setupRequired, reg = authMode === 'register' && state.registration === 'open';
    var title = setup ? 'RetroHub einrichten' : reg ? 'Konto erstellen' : 'Anmelden';
    $('#main').innerHTML = '<div class="auth-box panel stack"><h1>' + title + '</h1>' +
      (setup ? '<p>Lege das erste Konto an. Es wird Administrator. Den Einrichtungscode hat der Installer am Ende angezeigt (oder im Container: <b>retrohub-cli setup-code</b>).</p>' : '') +
      '<form id="auth-form" class="stack" novalidate>' +
      (setup ? '<label class="field" for="au-code">Einrichtungscode<input id="au-code" autocomplete="one-time-code" autocapitalize="characters" required placeholder="ABCD-EFGH"></label>' : '') +
      '<label class="field" for="au-name">Benutzername<input id="au-name" autocomplete="username" autocapitalize="none" required maxlength="24"></label>' +
      (setup || reg ? '<label class="field" for="au-display">Anzeigename<input id="au-display" maxlength="24" autocomplete="nickname"></label>' : '') +
      '<label class="field" for="au-pw">Passwort<input id="au-pw" type="password" autocomplete="' + (setup || reg ? 'new-password' : 'current-password') + '" required minlength="' + (setup || reg ? 8 : 1) + '"></label>' +
      (setup || reg ? '<p class="muted">Benutzername: 3–24 Zeichen (a–z, 0–9, . _ -). Passwort: mindestens 8 Zeichen.</p>' : '') +
      '<p class="status-line" id="auth-msg" role="alert"></p>' +
      '<button class="btn" type="submit">' + (setup ? 'Einrichten und anmelden' : reg ? 'Konto erstellen' : 'Anmelden') + '</button></form>' +
      (!setup ? (state.registration === 'open' ? '<p class="auth-switch"><button class="btn secondary small" type="button" data-action="auth-switch">' + (reg ? 'Ich habe schon ein Konto' : 'Neues Konto erstellen') + '</button></p>' : '<p class="muted auth-switch">Noch kein Konto? Ein Admin kann eines für dich anlegen.</p>') : '') +
      '</div>';
    var first = $('#au-code') || $('#au-name'); if (first) first.focus();
  };
  function submitAuth() {
    var setup = state.setupRequired, reg = authMode === 'register';
    var body = { name: $('#au-name').value.trim(), password: $('#au-pw').value };
    if (setup) body.setupCode = $('#au-code').value.trim();
    if (setup || reg) body.display = $('#au-display').value.trim();
    var msg = $('#auth-msg'); msg.textContent = '';
    if (!body.name || !body.password) { msg.textContent = 'Bitte Benutzername und Passwort eingeben.'; return; }
    api('POST', setup || reg ? '/api/register' : '/api/login', body).then(function (r) { authMode = 'login'; loggedIn(r.user); }, function (e) { msg.textContent = e.message; $('#au-pw').focus(); });
  }
  function loadUserData() {
    return Promise.all([api('GET', '/api/me/data'), refreshCatalog(), api('GET', '/api/notifications').catch(function () { return { notifications: [] }; })]).then(function (r) {
      state.data = r[0]; state.notifications = r[2].notifications; updateBadge();
    });
  }
  function loggedIn(user) {
    state.me = user; state.setupRequired = false; applyProfile(); setConn(false);
    loadUserData().then(function () { RT.connect(); if (location.hash === '#anmelden' || !location.hash) go('home'); else route(true); }, errToast);
  }
  function loggedOut(msg) {
    RT.close(); state.me = null; state.couch = null; state.couchId = null; state.myCouch = null; state.friends = null; state.chat = {}; state.tournaments = null;
    applyProfile(); closeDialogs(); if (msg) toast(msg);
    api('GET', '/api/session').then(function (s) { state.setupRequired = s.setupRequired; state.registration = s.registration; route(false); }, function () { route(false); });
  }

  /* ---------- Startseite ---------- */
  function emptyLibraryHTML() {
    var admin = state.me.role === 'admin';
    return '<div class="empty"><h2>Noch keine Spiele</h2><p class="muted">RetroHub bringt bewusst keine Spiele mit. ' + (admin ? 'Füge eigene Spieldateien hinzu – per Upload, von einer URL oder aus einem eingebundenen Ordner (z. B. NAS).' : 'Ein Admin kann Spiele hinzufügen.') + '</p>' + (admin ? '<a class="btn" href="#admin" data-admin-tab="add">Spiele hinzufügen</a>' : '') + '</div>';
  }
  RENDER.home = function () {
    var p = state.data.progress, last = p.last && GAME[p.last.id] ? GAME[p.last.id] : null;
    var total = Object.keys(p.time).reduce(function (s2, k) { return s2 + p.time[k]; }, 0);
    var ready = GAMES.filter(playable), recent = GAMES.slice().sort(function (x, y) { return String(y.addedAt).localeCompare(String(x.addedAt)); }).slice(0, 10);
    var used = {}; GAMES.forEach(function (g) { used[g.system] = 1; });
    var html = '<header class="home-head"><div><h1 id="home-title">Guten Tag, ' + esc(state.me.display) + '</h1><p>Deine Sammlung im Heimnetz.</p></div>' +
      '<dl class="home-figures"><div><dt>Spiele</dt><dd>' + GAMES.length + '</dd></div><div><dt>spielbereit</dt><dd>' + ready.length + '</dd></div><div><dt>Systeme in der Sammlung</dt><dd>' + Object.keys(used).length + '</dd></div><div><dt>deine Spielzeit</dt><dd>' + fmtMin(total) + '</dd></div></dl></header>';
    if (last) html += '<section class="section" aria-labelledby="home-resume"><h2 id="home-resume" class="sr-only">Weiterspielen</h2><div class="resume">' + spine(last.system, last) + '<div class="grow"><h2>' + esc(last.title) + '</h2><p class="muted">' + esc(sysName(last.system)) + ', zuletzt am ' + esc(fmtTime(p.last.at)) + '</p></div>' +
      '<button class="btn" type="button" data-play="' + esc(last.id) + '"' + (playable(last) ? '' : ' disabled') + '>Weiterspielen</button></div></section>';
    html += GAMES.length ? '<section class="section" aria-labelledby="home-shelf"><div class="section-head"><h2 id="home-shelf">Zuletzt hinzugefügt</h2><a href="#spiele">Zur Bibliothek</a></div>' + shelf(recent) + '</section>' : '<section class="section">' + emptyLibraryHTML() + '</section>';
    html += '<section class="section home-split"><div class="panel"><h2>Couch-Modus</h2><p class="muted">Ein Bildschirm zeigt das Spiel, bis zu vier Handys dienen als Controller.</p><a class="btn secondary" href="#couch">Couch-Modus öffnen</a></div>' +
      '<div class="panel"><h2>Netplay <span class="tag exp">Experimentell</span></h2><p class="muted">Jede Person spielt am eigenen Gerät, abgeglichen über den RetroHub-Server im Heimnetz.</p><a class="btn secondary" href="#gemeinsam">Offene Räume</a></div></section>';
    $('#main').innerHTML = html;
  };

  /* ---------- Bibliothek ---------- */
  function filtered() {
    var f = state.filters, q = f.q.trim().toLowerCase();
    var list = GAMES.filter(function (g) {
      if (q && (g.title + ' ' + sysName(g.system) + ' ' + (g.desc || '') + ' ' + (g.genre || '') + ' ' + (g.year || '')).toLowerCase().indexOf(q) === -1) return false;
      if (f.system !== 'alle' && g.system !== f.system) return false;
      if (f.maker !== 'alle' && makerOf(g.system) !== f.maker) return false;
      if (f.playableOnly && !playable(g)) return false;
      if (f.players !== 'Alle' && g.players < Number(f.players)) return false;
      return true;
    });
    list.sort(function (a, b) {
      if (f.sort === 'system') return sysName(a.system).localeCompare(sysName(b.system), 'de') || a.title.localeCompare(b.title, 'de');
      if (f.sort === 'neu') return String(b.addedAt).localeCompare(String(a.addedAt));
      return a.title.localeCompare(b.title, 'de');
    });
    return list;
  }
  function activeFilterCount() { var f = state.filters; return (f.system !== 'alle') + (f.maker !== 'alle') + (f.players !== 'Alle') + (f.playableOnly ? 1 : 0); }
  function activeFilterText() { var n = activeFilterCount(); return n ? n + ' aktiv' : 'keine aktiv'; }
  RENDER.spiele = function () {
    var f = state.filters, used = {}, makers = {};
    GAMES.forEach(function (g) { used[g.system] = (used[g.system] || 0) + 1; makers[makerOf(g.system)] = 1; });
    var sysOpts = [['alle', 'Alle Systeme']].concat(SYSTEMS.filter(function (s) { return used[s.key]; }).map(function (s) { return [s.key, s.name + ' (' + used[s.key] + ')']; }));
    $('#main').innerHTML = '<h1>Spielebibliothek</h1>' +
      (GAMES.length ? '<details class="panel section filter-box"' + (window.innerWidth > 760 || activeFilterCount() ? ' open' : '') + '><summary><span>Filter</span><span class="tag" id="filter-count">' + activeFilterText() + '</span></summary><div class="filters">' +
        '<label class="field" for="f-system">System<select id="f-system" data-filter="system">' + sysOpts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (f.system === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></label>' +
        '<label class="field" for="f-players">Mindestens Spieler<select id="f-players" data-filter="players">' + [['Alle', 'Alle'], ['2', '2 oder mehr'], ['4', '4 oder mehr']].map(function (o) { return '<option value="' + o[0] + '"' + (f.players === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>' +
        '<label class="field" for="f-sort">Sortierung<select id="f-sort" data-filter="sort">' + [['az', 'Name A–Z'], ['system', 'System'], ['neu', 'Zuletzt hinzugefügt']].map(function (o) { return '<option value="' + o[0] + '"' + (f.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>' +
        '</div><div class="chips" role="group" aria-label="Hersteller"><button type="button" class="chip" data-maker="alle" aria-pressed="' + (f.maker === 'alle') + '">Alle Hersteller</button>' +
        Object.keys(makers).sort().map(function (m) { return '<button type="button" class="chip" data-maker="' + esc(m) + '" aria-pressed="' + (f.maker === m) + '">' + esc(m) + '</button>'; }).join('') + '</div>' +
        '<label class="check"><input type="checkbox" id="f-playable"' + (f.playableOnly ? ' checked' : '') + '> Nur spielbereite Spiele</label></details>' +
        '<div class="result-line"><h2 id="result-count" aria-live="polite"></h2><div class="row"><button class="btn secondary" type="button" id="reset-filters">Filter zurücksetzen</button><button class="btn" type="button" id="random-game">Zufallsspiel</button></div></div><div id="results"></div>'
        : emptyLibraryHTML());
    renderResults();
  };
  function renderResults() {
    var box = $('#results'); if (!box) return; var list = filtered();
    var fc = $('#filter-count'); if (fc) fc.textContent = activeFilterText();
    $('#result-count').textContent = list.length === 1 ? '1 Spiel' : list.length + ' Spiele';
    box.innerHTML = list.length ? shelf(list) : '<div class="empty"><h3>Kein Spiel passt zu diesen Filtern</h3><button class="btn" type="button" data-action="reset-filters">Filter zurücksetzen</button></div>';
  }
  function resetFilters() { state.filters = { q: '', system: 'alle', maker: 'alle', players: 'Alle', playableOnly: false, sort: 'az' }; $('#search').value = ''; RENDER.spiele(); toast('Filter zurückgesetzt'); }
  function renderFavorites(keepFocus) {
    var favs = GAMES.filter(function (g) { return isFav(g.id); });
    $('#main').innerHTML = '<h1>Favoriten</h1>' + (favs.length ? '<p class="muted">' + favs.length + ' gemerkte Spiele, auf allen deinen Geräten.</p>' + shelf(favs) :
      '<div class="empty"><h2>Noch keine Favoriten</h2><p class="muted">Tippe in der Bibliothek auf das Herz eines Spiels, um es hier zu sammeln.</p><a class="btn" href="#spiele">Zur Bibliothek</a></div>');
    if (keepFocus) { var first = $('#main .fav') || $('#main .btn'); if (first) first.focus(); }
  }
  RENDER.favoriten = function () { renderFavorites(false); };

  /* ---------- Netplay-Räume (experimentell) ---------- */
  var roomsTimer = null;
  function loadRooms() {
    api('GET', '/api/netplay/rooms').then(function (r) { state.rooms = r.rooms; renderRooms(); }, function () { return null; });
    clearTimeout(roomsTimer); if (currentView === 'gemeinsam') roomsTimer = setTimeout(loadRooms, 5000);
  }
  RENDER.gemeinsam = function () {
    var ready = GAMES.filter(playable);
    $('#main').innerHTML = '<h1>Netplay <span class="tag exp">Experimentell</span></h1><p class="muted">Beim Netplay läuft das Spiel auf jedem Gerät, die Eingaben werden über den RetroHub-Server im Heimnetz abgeglichen. Alle brauchen ein Konto.</p>' +
      '<div class="notice exp"><strong>Experimentell:</strong><span>Netplay läuft im Gleichschritt und wurde im Heimnetz getestet. Es braucht eine stabile Verbindung und auf allen Geräten genug Leistung; bei anspruchsvollen Systemen kann es ruckeln. Für gemeinsames Spielen an einem Bildschirm ist der Couch-Modus die robustere Wahl.</span></div>' +
      '<div class="grid-2 section"><section class="panel stack" aria-labelledby="np-open"><h2 id="np-open">Raum eröffnen</h2>' +
      (ready.length ? '<form id="room-open-form" class="stack"><label class="field" for="np-game">Spiel<select id="np-game">' + ready.map(function (g) { return '<option value="' + esc(g.id) + '">' + esc(g.title) + ' (' + esc(sysName(g.system)) + ')</option>'; }).join('') + '</select></label><button class="btn" type="submit">Spiel öffnen</button></form>' +
        '<ol class="steps"><li>Spiel öffnen.</li><li>In der Emulator-Leiste unten auf das Netplay-Symbol (Globus) tippen.</li><li>„Raum erstellen“ wählen – er erscheint hier für alle.</li></ol>' : '<p class="muted">Noch keine spielbereiten Spiele.</p>') +
      '</section><section class="panel" aria-labelledby="np-rooms"><div class="section-head"><h2 id="np-rooms">Offene Räume</h2><button class="btn small secondary" type="button" data-action="rooms-refresh">Aktualisieren</button></div><div id="room-list"><p class="muted">Lade …</p></div></section></div>';
    loadRooms();
  };
  function renderRooms() {
    var box = $('#room-list'); if (!box) return;
    box.innerHTML = state.rooms.length ? '<ul class="list">' + state.rooms.map(function (x) {
      var g = GAME['g' + x.gameId], full = x.players >= x.max;
      return '<li class="person"><span class="tag">' + esc(g ? glyph(g.system) : '–') + '</span><span class="grow"><b>' + esc(x.name) + '</b><br><span class="muted">' + esc(x.gameTitle) + ', ' + x.players + ' / ' + x.max + ', eröffnet von ' + esc(x.host) + (x.password ? ', mit Passwort' : '') + '</span></span>' +
        '<button class="btn small" type="button" data-room-join="' + esc('g' + x.gameId) + '" data-room-name="' + esc(x.name) + '"' + (full || !g || !playable(g) ? ' disabled' : '') + '>' + (full ? 'Voll' : 'Beitreten') + '</button></li>';
    }).join('') + '</ul>' : '<p class="muted">Gerade ist kein Raum offen.</p>';
  }

  /* ---------- Couch-Modus (Bildschirm) ---------- */
  RENDER.couch = function () {
    $('#main').innerHTML = '<h1>Couch-Modus</h1><p class="muted">Dieses Gerät zeigt das Spiel (Fernseher oder Laptop am TV). Bis zu 4 Handys werden zu Controllern: QR-Code scannen oder Code eingeben.</p><div id="couch-panel"></div>';
    renderCouchPanel();
  };
  function renderCouchPanel() {
    var box = $('#couch-panel'); if (!box) return; var c = state.couch, ready = GAMES.filter(playable);
    if (!c) {
      box.innerHTML = '<section class="panel stack"><h2>Session starten</h2>' + (ready.length ? '<form id="couch-form" class="inline-form"><label class="field" for="couch-game">Spiel<select id="couch-game">' + ready.map(function (g) { return '<option value="' + esc(g.gid) + '">' + esc(g.title) + ' (' + esc(sysName(g.system)) + ', bis ' + g.players + ' Spieler)</option>'; }).join('') + '</select></label><button class="btn" type="submit">Session starten</button></form>' : '<p class="muted">Noch keine spielbereiten Spiele.</p>') + '</section>';
      return;
    }
    var url = location.origin + location.pathname + '#join-' + c.code, qr = '';
    try { qr = window.RHQR.svg(url, 'QR-Code: Mit dem Handy scannen, um als Controller beizutreten'); } catch (e) { qr = ''; }
    box.innerHTML = '<section class="panel tv stack"><div class="section-head"><h2>' + esc(c.gameTitle) + '</h2><button class="btn secondary small" type="button" data-action="couch-close">Session beenden</button></div>' +
      '<div class="grid-2"><div class="stack couch-join"><div class="qr-box">' + qr + '</div><p>Mit der Handy-Kamera scannen oder unter „Controller“ diesen Code eingeben:</p><p class="code" aria-label="Code ' + esc(c.code.split('').join(' ')) + '">' + esc(c.code) + '</p></div>' +
      '<div><h3>Controller</h3>' + (c.players.length ? '<ul class="list">' + c.players.slice().sort(function (a, b) { return a.slot - b.slot; }).map(function (p) { return '<li class="person">' + avatar(p, true) + '<span class="grow"><b>Controller ' + (p.slot + 1) + '</b>: ' + esc(p.display) + '<br><span class="presence' + (p.online ? ' on' : '') + '" aria-hidden="true"></span><span class="muted">' + (p.online ? 'verbunden' : 'getrennt') + '</span></span></li>'; }).join('') + '</ul>' : '<p class="muted">Noch kein Handy verbunden.</p>') + '</div></div>' +
      '<button class="btn" type="button" data-action="couch-play">Spiel auf diesem Bildschirm starten</button></section>';
  }

  /* ---------- Controller (Handy) ---------- */
  RENDER.controller = function () { $('#main').innerHTML = '<h1>Controller</h1><div id="ctrl-panel"></div>'; renderControllerPanel(); pendingJoin(); };
  function renderControllerPanel() {
    var box = $('#ctrl-panel'); if (!box) return; var c = state.myCouch;
    if (!c) {
      box.innerHTML = '<section class="panel stack"><p>Gib den Code vom Fernseher ein. Dein Handy wird dann zum Controller.</p><form class="inline-form" id="ctrl-form"><label class="field" for="ctrl-code">Code<input id="ctrl-code" maxlength="4" autocapitalize="characters" inputmode="text" placeholder="A7K2"></label><button class="btn" type="submit">Verbinden</button></form><p class="status-line" id="ctrl-log" aria-live="polite"></p></section>';
      return;
    }
    var me = c.players.filter(function (p) { return p.id === state.me.id; })[0];
    var b = function (name, label, cls) { return '<button type="button" class="pad-btn ' + (cls || '') + '" data-pad="' + PAD[name] + '" aria-label="' + label + '">' + label.split(' ')[0] + '</button>'; };
    box.innerHTML = '<section class="gamepad" aria-label="Controller ' + (me ? me.slot + 1 : '') + ' für ' + esc(c.gameTitle) + '">' +
      '<div class="gp-head"><span><b>' + esc(c.gameTitle) + '</b><br><span class="muted">Controller ' + (me ? me.slot + 1 : '?') + '</span></span><button class="btn small secondary" type="button" data-action="couch-leave">Trennen</button></div>' +
      '<div class="gp-shoulders">' + b('L', 'L Schultertaste', 'sh') + b('R', 'R Schultertaste', 'sh') + '</div>' +
      '<div class="gp-main"><div class="gp-dpad">' + b('UP', '▲ Hoch', 'up') + b('LEFT', '◀ Links', 'left') + b('RIGHT', '▶ Rechts', 'right') + b('DOWN', '▼ Runter', 'down') + '</div>' +
      '<div class="gp-face">' + b('X', 'X', 'x') + b('Y', 'Y', 'y') + b('A', 'A', 'a') + b('B', 'B', 'b2') + '</div></div>' +
      '<div class="gp-meta">' + b('SELECT', 'Select', 'meta') + b('START', 'Start', 'meta') + '</div></section>';
  }
  var padHeld = {};
  function padSend(btn, val) { if (!state.myCouch) return; RT.send({ t: 'pad', button: btn, value: val }); }
  document.addEventListener('pointerdown', function (e) {
    var t = e.target.closest && e.target.closest('.gamepad [data-pad]'); if (!t) return;
    e.preventDefault(); try { t.setPointerCapture(e.pointerId); } catch (x) { /* nicht unterstützt */ }
    padHeld[e.pointerId] = t; t.classList.add('pressed'); padSend(Number(t.dataset.pad), 1);
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch (x) { /* nicht unterstützt */ } }
  });
  ['pointerup', 'pointercancel'].forEach(function (ev) {
    document.addEventListener(ev, function (e) { var t = padHeld[e.pointerId]; if (!t) return; delete padHeld[e.pointerId]; t.classList.remove('pressed'); padSend(Number(t.dataset.pad), 0); });
  });
  var KEYPAD = { ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', x: 'A', z: 'B', s: 'X', a: 'Y', q: 'L', w: 'R', Enter: 'START', Shift: 'SELECT' };
  ['keydown', 'keyup'].forEach(function (ev) {
    document.addEventListener(ev, function (e) {
      if (currentView !== 'controller' || !state.myCouch || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) || e.repeat) return;
      var k = KEYPAD[e.key]; if (!k) return; e.preventDefault(); padSend(PAD[k], ev === 'keydown' ? 1 : 0);
    });
  });

  /* ---------- Turniere, Freunde, Chat, Mitteilungen, Profil, Einstellungen ---------- */
  RENDER.turniere = function () {
    if (!state.tournaments) { $('#main').innerHTML = '<h1>Turniere</h1><p class="muted">Lade …</p>'; loadTournaments(); return; }
    var list = state.tournaments, t = list.filter(function (x) { return x.id === state.tournamentId; })[0] || list[0];
    var html = '<h1>Turniere</h1>';
    if (list.length > 1) html += '<div class="tabs" role="group" aria-label="Turnier wählen">' + list.map(function (x) { return '<button type="button" class="btn small' + (t && x.id === t.id ? '' : ' secondary') + '" data-tournament="' + esc(x.id) + '" aria-pressed="' + (t && x.id === t.id) + '">' + esc(x.name) + '</button>'; }).join('') + '</div>';
    if (t) {
      var can = t.createdBy === state.me.id || state.me.role === 'admin', names = ['Viertelfinale', 'Halbfinale', 'Finale'];
      html += '<section class="section" aria-labelledby="t-name"><div class="section-head"><h2 id="t-name">' + esc(t.name) + '</h2>' + (can ? '<button class="btn secondary small" type="button" data-action="t-delete" data-id="' + esc(t.id) + '">Turnier löschen</button>' : '') + '</div>' +
        (GAME[t.game] ? '<p class="t-game"><span class="muted">Gespielt wird:</span> <b>' + esc(GAME[t.game].title) + '</b> <span class="tag">' + esc(glyph(GAME[t.game].system)) + '</span></p>' : '') +
        '<p class="muted">' + (can ? 'Du leitest dieses Turnier: Wähle in jeder Begegnung, wer gewonnen hat. Alle sehen es sofort.' : 'Ergebnisse trägt die Turnierleitung ein.') + '</p><div class="bracket">';
      t.rounds.forEach(function (round, ri) {
        html += '<div class="round"><h3>' + names[ri] + '</h3>';
        round.forEach(function (winner, mi) {
          var ps = ri === 0 ? [t.players[mi * 2], t.players[mi * 2 + 1]] : [t.rounds[ri - 1][mi * 2], t.rounds[ri - 1][mi * 2 + 1]];
          html += '<div class="match" role="group" aria-label="' + names[ri] + ', Begegnung ' + (mi + 1) + '">' + ps.map(function (p) {
            return '<button type="button" data-win="' + ri + ':' + mi + '" data-tid="' + esc(t.id) + '" data-player="' + esc(p || '') + '" aria-pressed="' + (!!p && winner === p) + '"' + (p && can ? '' : ' disabled') + '>' + esc(p || 'offen') + (p && winner === p ? '<span aria-hidden="true">✓</span>' : '') + '</button>';
          }).join('') + '</div>';
        });
        html += '</div>';
      });
      html += '<div class="round"><h3>Sieger</h3><div class="champion" aria-live="polite">' + (t.rounds[2][0] ? esc(t.rounds[2][0]) : 'noch offen') + '</div></div></div></section>';
    } else html += '<div class="empty"><p class="muted">Noch kein Turnier. Lege eines an – alle im Netzwerk sehen den Turnierbaum.</p></div>';
    if (state.me.role !== 'child') {
      html += '<section class="panel section" aria-labelledby="t-new"><h2 id="t-new">Neues Turnier</h2><form id="t-form" class="stack"><div class="grid-2"><label class="field" for="t-title">Name<input id="t-title" maxlength="40" required value="Turnier am ' + new Date().toLocaleDateString('de-DE') + '"></label>' +
        '<label class="field" for="t-game">Spiel<select id="t-game">' + GAMES.filter(playable).map(function (g) { return '<option value="' + esc(g.id) + '">' + esc(g.title) + '</option>'; }).join('') + '</select></label></div>' +
        '<fieldset class="field"><legend>8 Teilnehmende</legend><div class="grid-2">' + [1, 2, 3, 4, 5, 6, 7, 8].map(function (i) { return '<label class="sr-only" for="t-p' + i + '">Teilnehmer ' + i + '</label><input id="t-p' + i + '" maxlength="24" required placeholder="Teilnehmer ' + i + '">'; }).join('') + '</div></fieldset>' +
        '<button class="btn" type="submit">Turnier anlegen</button></form></section>';
    }
    $('#main').innerHTML = html;
  };
  function loadTournaments() { return api('GET', '/api/tournaments').then(function (r) { state.tournaments = r.tournaments; if (currentView === 'turniere') RENDER.turniere(); }, errToast); }
  RENDER.freunde = function () {
    if (!state.friends) { $('#main').innerHTML = '<h1>Freunde</h1><p class="muted">Lade …</p>'; loadFriends(); return; }
    var f = state.friends, inLobby = false;
    var person = function (p, actions) { return '<li class="person">' + avatar(p) + '<span class="grow"><b>' + esc(p.display) + '</b> <span class="muted">@' + esc(p.name) + '</span><br><span class="presence' + (p.online ? ' on' : '') + '" aria-hidden="true"></span><span class="muted">' + (p.online ? (p.lobby ? 'online, in „' + esc(p.lobby) + '“' : 'online') : 'offline') + '</span></span><span class="row">' + actions + '</span></li>'; };
    $('#main').innerHTML = '<h1>Freunde</h1><div class="grid-2"><section class="panel stack" aria-labelledby="fr-add"><h2 id="fr-add">Freund hinzufügen</h2><form class="inline-form" id="friend-form"><label class="field" for="fr-name">Benutzername<input id="fr-name" autocapitalize="none" maxlength="24" required placeholder="z. B. jonas"></label><button class="btn" type="submit">Anfrage senden</button></form>' +
      (f.incoming.length ? '<h3>Anfragen an dich</h3><ul class="list">' + f.incoming.map(function (p) { return person(p, '<button class="btn small" type="button" data-friend-accept="' + esc(p.id) + '">Annehmen</button><button class="btn small secondary" type="button" data-friend-remove="' + esc(p.id) + '">Ablehnen</button>'); }).join('') + '</ul>' : '') +
      (f.outgoing.length ? '<h3>Gesendet</h3><ul class="list">' + f.outgoing.map(function (p) { return person(p, '<button class="btn small secondary" type="button" data-friend-remove="' + esc(p.id) + '">Zurückziehen</button>'); }).join('') + '</ul>' : '') + '</section>' +
      '<section class="panel" aria-labelledby="fr-list"><h2 id="fr-list">Deine Freunde (' + f.friends.length + ')</h2>' + (f.friends.length ? '<ul class="list">' + f.friends.sort(function (a, b) { return b.online - a.online; }).map(function (p) {
        return person(p, '<a class="btn small secondary" href="#chat" data-dm="' + esc(p.id) + '">Nachricht</a>' + (inLobby && p.online ? '<button class="btn small" type="button" data-invite="' + esc(p.id) + '">Einladen</button>' : '') + '<button class="btn small secondary" type="button" data-friend-remove="' + esc(p.id) + '" aria-label="' + esc(p.display) + ' entfernen">Entfernen</button>');
      }).join('') + '</ul>' : '<p class="muted">Noch keine Freunde. Sende eine Anfrage mit dem Benutzernamen.</p>') + '</section></div>';
  };
  function loadFriends() { return api('GET', '/api/friends').then(function (r) { state.friends = r; if (currentView === 'freunde') RENDER.freunde(); if (currentView === 'chat') renderChannels(); }, errToast); }
  function channelTitle(ch) { if (ch === 'allgemein') return '# Allgemein'; if (ch === 'couchabend') return '# Couch-Abend'; var id = ch.slice(3), fr = state.friends && state.friends.friends.filter(function (x) { return x.id === id; })[0]; return fr ? fr.display : 'Direktnachricht'; }
  RENDER.chat = function () {
    if (!state.friends) loadFriends();
    $('#main').innerHTML = '<h1>Chat</h1><div class="chat"><div class="channels" role="group" aria-label="Kanäle und Direktnachrichten" id="channels"></div><section class="panel" aria-labelledby="ch-title"><h2 id="ch-title">' + esc(channelTitle(state.channel)) + '</h2><ul class="messages" id="messages" aria-live="polite"><li class="muted">Lade …</li></ul>' +
      '<form class="compose" id="chat-form"><label class="sr-only" for="chat-input">Nachricht</label><input id="chat-input" maxlength="500" autocomplete="off" placeholder="Nachricht schreiben"><button class="btn" type="submit">Senden</button></form></section></div>';
    renderChannels(); loadChannel(state.channel);
  };
  function renderChannels() {
    var box = $('#channels'); if (!box) return;
    var list = [['allgemein', '# Allgemein'], ['couchabend', '# Couch-Abend']].concat((state.friends ? state.friends.friends : []).map(function (f) { return ['dm:' + f.id, (f.online ? '● ' : '○ ') + f.display]; }));
    box.innerHTML = list.map(function (c) { return '<button type="button" data-channel="' + esc(c[0]) + '" aria-current="' + (c[0] === state.channel) + '">' + esc(c[1]) + '</button>'; }).join('');
    var h = $('#ch-title'); if (h) h.textContent = channelTitle(state.channel);
  }
  function loadChannel(ch) {
    api('GET', '/api/chat/' + encodeURIComponent(ch)).then(function (r) { state.chat[ch] = r.messages; if (currentView === 'chat' && state.channel === ch) renderMessages(); }, function (e) { var ul = $('#messages'); if (ul) ul.innerHTML = '<li class="muted">' + esc(e.message) + '</li>'; });
  }
  function renderMessages() {
    var ul = $('#messages'); if (!ul) return; ul.innerHTML = '';
    var msgs = state.chat[state.channel] || [];
    if (!msgs.length) { ul.innerHTML = '<li class="muted">Noch keine Nachrichten. Schreib die erste!</li>'; return; }
    msgs.forEach(function (m) {
      var li = document.createElement('li'); li.className = 'msg' + (m.from === state.me.id ? ' me' : '');
      var b = document.createElement('b'); b.textContent = m.display + ' · ' + fmtTime(m.at); var p = document.createElement('div'); p.textContent = m.text;
      li.appendChild(b); li.appendChild(p); ul.appendChild(li);
    });
    ul.scrollTop = ul.scrollHeight;
  }
  function updateBadge() { var n = state.notifications.filter(function (x) { return !x.read; }).length, b = $('#badge'); b.hidden = !n; b.textContent = n > 9 ? '9+' : String(n); $('#bell').setAttribute('aria-label', n ? 'Mitteilungen, ' + n + ' ungelesen' : 'Mitteilungen'); }
  RENDER.mitteilungen = function () {
    var list = state.notifications;
    $('#main').innerHTML = '<h1>Mitteilungen</h1>' + (list.length ? '<ul class="list">' + list.map(function (n) {
      var act = n.type === 'invite' && n.data ? '<button class="btn small" type="button" data-join-code="' + esc(n.data.code) + '">Beitreten</button>' : n.type === 'friend-request' ? '<a class="btn small secondary" href="#freunde">Ansehen</a>' : n.type === 'dm' && n.data ? '<a class="btn small secondary" href="#chat" data-dm="' + esc(n.data.from) + '">Antworten</a>' : '';
      return '<li class="notif' + (n.read ? '' : ' unread') + '"><span class="grow">' + esc(n.text) + '<br><span class="muted">' + fmtTime(n.at) + '</span></span>' + act + '</li>';
    }).join('') + '</ul>' : '<div class="empty"><p class="muted">Keine Mitteilungen. Hier erscheinen Freundschaftsanfragen, Nachrichten und Einladungen.</p></div>');
    if (list.some(function (n) { return !n.read; })) api('POST', '/api/notifications/read', {}).then(function () { state.notifications.forEach(function (n) { n.read = true; }); updateBadge(); });
  };
  RENDER.profil = function () {
    var p = state.data.progress, s = state.data.stats || {}, me = state.me;
    var played = GAMES.filter(function (g) { return p.plays[g.id] || p.time[g.id]; });
    var total = Object.keys(p.time).reduce(function (a, k) { return a + p.time[k]; }, 0);
    var wins = Object.keys(s).reduce(function (a, k) { return a + s[k].w; }, 0);
    var xp = Object.keys(p.plays).reduce(function (a, k) { return a + p.plays[k] * 50; }, 0) + Math.round(total / 6) + wins * 100, level = 1 + Math.floor(xp / 500);
    var html = '<h1>Profil</h1><div class="grid-2"><section class="panel stack" aria-labelledby="pf-me"><div class="row">' + avatar(me) + '<h2 id="pf-me">' + esc(me.display) + '</h2><span class="tag">' + (me.role === 'admin' ? 'Administrator' : me.role === 'child' ? 'Kinderprofil' : 'Mitglied') + '</span></div>' +
      '<div class="stats"><div class="stat"><b>' + level + '</b>Level</div><div class="stat"><b>' + xp + '</b>XP</div><div class="stat"><b>' + fmtMin(total) + '</b>Spielzeit</div><div class="stat"><b>' + Object.keys(p.plays || {}).filter(function (k) { return GAME[k] && p.plays[k] > 0; }).length + '</b>Gespielte Spiele</div></div>' +
      '<p class="muted">' + (500 - xp % 500) + ' XP bis Level ' + (level + 1) + '. XP gibt es für Runden und Spielzeit.</p></section>' +
      '<section class="panel" aria-labelledby="pf-edit"><h2 id="pf-edit">Profil bearbeiten</h2><form id="profile-form" class="stack"><label class="field" for="pf-name">Anzeigename<input id="pf-name" required maxlength="24" value="' + esc(me.display) + '"></label>' +
      '<fieldset class="swatches"><legend class="sr-only">Farbe</legend>' + COLORS.map(function (c, i) { return '<label><input type="radio" name="color" value="' + c + '"' + (me.color === c ? ' checked' : '') + ' aria-label="Farbe ' + (i + 1) + '"><span class="avatar av-' + i + '" aria-hidden="true">' + esc(me.display.charAt(0).toUpperCase()) + '</span></label>'; }).join('') + '</fieldset>' +
      '<button class="btn" type="submit">Profil speichern</button></form></section></div>' +
      '<div class="grid-2 section"><section class="panel" aria-labelledby="pf-rec"><h2 id="pf-rec">Rekorde und Spielzeit</h2>' +
      (played.length ? '<ul class="list">' + played.map(function (g) { return '<li class="person cat-' + g.cat + '"><span aria-hidden="true">' + esc(g.glyph) + '</span><span class="grow"><b>' + esc(g.title) + '</b><br><span class="muted">' + (p.plays[g.id] || 0) + ((p.plays[g.id] || 0) === 1 ? ' Runde, ' : ' Runden, ') + fmtMin(p.time[g.id] || 0) + '</span></span><span>' + (p.best[g.id] !== undefined ? p.best[g.id] : '') + '</span></li>'; }).join('') + '</ul>' : '<p class="muted">Noch keine Runden gespielt.</p>') +
      (Object.keys(s).length ? '<h3 class="section">Netzwerkspiele</h3><ul class="list">' + Object.keys(s).map(function (k) { return '<li class="person"><span class="grow"><b>' + esc(GAME[k] ? GAME[k].title : k) + '</b></span><span>' + s[k].w + ' Siege, ' + s[k].l + ' Niederlagen' + (s[k].d ? ', ' + s[k].d + ' Unentschieden' : '') + '</span></li>'; }).join('') + '</ul>' : '') + '</section>' +
      '<section class="panel" aria-labelledby="pf-pw"><h2 id="pf-pw">Passwort ändern</h2><form id="pw-form" class="stack"><label class="field" for="pw-old">Aktuelles Passwort<input id="pw-old" type="password" autocomplete="current-password" required></label><label class="field" for="pw-new">Neues Passwort<input id="pw-new" type="password" autocomplete="new-password" required minlength="' + (me.role === 'child' ? 4 : 8) + '"></label><button class="btn" type="submit">Passwort ändern</button></form></section></div>';
    html += '<section class="panel section" aria-labelledby="pf-savehead"><h2 id="pf-savehead">Spielstände</h2><div id="pf-saves"><p class="muted">Lade …</p></div></section>';
    if (me.role !== 'child') html += '<section class="panel section" aria-labelledby="pf-kids"><h2 id="pf-kids">Kinderprofile</h2><p class="muted">Kinderprofile können spielen, Netplay und den Couch-Modus nutzen. Chat, Direktnachrichten und Freundschaften sind für sie gesperrt.</p><div id="kids"><p class="muted">Lade …</p></div>' +
      '<form id="kid-form" class="inline-form section"><label class="field" for="kid-name">Benutzername<input id="kid-name" autocapitalize="none" required maxlength="24"></label><label class="field" for="kid-display">Anzeigename<input id="kid-display" maxlength="24"></label><label class="field" for="kid-pw">PIN/Passwort (mind. 4)<input id="kid-pw" type="password" autocomplete="new-password" required minlength="4"></label><button class="btn" type="submit">Kinderprofil anlegen</button></form></section>';
    $('#main').innerHTML = html;
    loadSavesList();
    if (me.role !== 'child') loadKids();
  };
  function loadKids() {
    api('GET', '/api/children').then(function (r) {
      var box = $('#kids'); if (!box) return;
      box.innerHTML = r.children.length ? '<ul class="list">' + r.children.map(function (c) { return '<li class="person">' + avatar(c, true) + '<span class="grow"><b>' + esc(c.display) + '</b> <span class="muted">@' + esc(c.name) + '</span></span><label class="field kid-rating" for="kid-r-' + esc(c.id) + '"><span class="sr-only">Altersfreigabe für ' + esc(c.display) + '</span><select id="kid-r-' + esc(c.id) + '" data-kid-rating="' + esc(c.id) + '">' + [0, 6, 12, 16].map(function (r) { return '<option value="' + r + '"' + (c.maxRating === r ? ' selected' : '') + '>Spiele ab ' + r + '</option>'; }).join('') + '</select></label><span class="row"><button class="btn small secondary" type="button" data-kid-pw="' + esc(c.id) + '">PIN neu setzen</button><button class="btn small secondary" type="button" data-kid-del="' + esc(c.id) + '" aria-label="' + esc(c.display) + ' löschen">Löschen</button></span></li>'; }).join('') + '</ul>' : '<p class="muted">Noch keine Kinderprofile.</p>';
    }, errToast);
  }
  RENDER.einstellungen = function () {
    $('#main').innerHTML = '<h1>Einstellungen</h1><div class="grid-2"><section class="panel stack" aria-labelledby="st-look"><h2 id="st-look">Darstellung auf diesem Gerät</h2>' +
      '<fieldset class="field"><legend>Farbschema</legend>' + [['system', 'Wie das Gerät'], ['dark', 'Dunkel'], ['light', 'Hell']].map(function (o) { return '<label class="check"><input type="radio" name="theme" value="' + o[0] + '"' + (state.theme === o[0] ? ' checked' : '') + '> ' + o[1] + '</label>'; }).join('') + '</fieldset>' +
      '<label class="check"><input type="checkbox" id="st-motion"' + (state.reduceMotion ? ' checked' : '') + '> Bewegungen reduzieren</label></section>' +
      '<section class="panel stack" aria-labelledby="st-acc"><h2 id="st-acc">Konto</h2><p>Angemeldet als <b>' + esc(state.me.display) + '</b> (@' + esc(state.me.name) + ').</p><p class="muted">Favoriten, Spielstände und Nachrichten liegen auf dem RetroHub-Server und sind auf allen Geräten verfügbar.</p>' +
      '<button class="btn secondary" type="button" data-action="logout">' + icon('logout') + ' Abmelden</button></section></div>';
  };
  /* ---------- Administration ---------- */
  var gamesPoll = null, adminTab = 'add';
  function sysSelect(id, sel) {
    return '<select id="' + id + '">' + SYSTEMS.map(function (s) { return '<option value="' + esc(s.key) + '"' + (s.key === sel ? ' selected' : '') + '>' + esc(s.name) + (s.ready ? '' : ' – ' + (s.coreInstalled ? 'BIOS fehlt' : 'Emulator fehlt')) + '</option>'; }).join('') + '</select>';
  }
  RENDER.admin = function () {
    var rights = function (id) { return '<label class="check"><input type="checkbox" id="' + id + '"> Ich besitze die Rechte an diesen Dateien (eigene Sicherung, freie Lizenz oder Homebrew).</label>'; };
    $('#main').innerHTML = '<h1>Administration</h1>' +
      '<section class="panel" aria-labelledby="ad-add"><h2 id="ad-add">Spiele hinzufügen</h2><div class="tabs" role="tablist" aria-label="Quelle">' +
        [['add', 'Upload'], ['url', 'Von URL'], ['folder', 'Aus Ordner']].map(function (t) { return '<button type="button" role="tab" class="btn small' + (adminTab === t[0] ? '' : ' secondary') + '" aria-selected="' + (adminTab === t[0]) + '" data-admin-tab="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '</div>' +
        '<div id="ad-tab-add"' + (adminTab === 'add' ? '' : ' hidden') + '><form id="lib-upload-form" class="stack" novalidate><div class="grid-2"><label class="field" for="up-system">System' + sysSelect('up-system', 'nes') + '</label><label class="field" for="up-title">Titel<input id="up-title" maxlength="60" placeholder="aus dem Dateinamen"></label>' +
          '<label class="field" for="up-players">Spieler<select id="up-players"><option>1</option><option selected>2</option><option>4</option></select></label><label class="field" for="up-files">Dateien (mehrere = ein Spiel, z. B. CUE + BIN)<input id="up-files" type="file" multiple></label></div>' + rights('up-rights') +
          '<progress id="up-progress" max="100" value="0" hidden aria-label="Fortschritt Upload"></progress><p class="status-line" id="up-msg" role="alert"></p><button class="btn" type="submit">Hochladen</button></form></div>' +
        '<div id="ad-tab-url"' + (adminTab === 'url' ? '' : ' hidden') + '><form id="lib-url-form" class="stack" novalidate><label class="field" for="url-url">Adresse der Datei (http/https)<input id="url-url" type="url" placeholder="https://beispiel.de/meine-sicherung.zip"></label><div class="grid-2"><label class="field" for="url-system">System' + sysSelect('url-system', 'nes') + '</label><label class="field" for="url-title">Titel<input id="url-title" maxlength="60" placeholder="aus dem Dateinamen"></label></div>' + rights('url-rights') +
          '<progress id="url-progress" max="100" value="0" hidden aria-label="Fortschritt Download"></progress><p class="status-line" id="url-msg" role="alert"></p><button class="btn" type="submit">Herunterladen</button></form></div>' +
        '<div id="ad-tab-folder"' + (adminTab === 'folder' ? '' : ' hidden') + '><p class="muted">Liest den eingebundenen Ordner <b>' + esc(state.importDir || '/srv/retrohub-import') + '</b> (z. B. NAS-Freigabe, beim Installieren per IMPORT_DIR). Dateien werden nicht kopiert, sondern dort gelesen.</p><button class="btn secondary" type="button" data-action="import-scan">Ordner einlesen</button><p class="status-line" id="imp-result" role="status" aria-live="polite"></p><div id="import-list" class="section"></div></div>' +
      '</section>' +
      '<section class="panel section" aria-labelledby="ad-lib"><h2 id="ad-lib">Spiele (' + GAMES.length + ')</h2><p class="muted">Kinderprofile sehen nur Spiele mit Altersfreigabe bis zu ihrer Grenze; nicht eingestufte Spiele bleiben für Kinder verborgen.</p><div id="ad-edit"></div><div id="ad-games"></div></section>' +
      '<section class="panel section" aria-labelledby="ad-emu"><div class="section-head"><h2 id="ad-emu">Emulatoren</h2><button class="btn" type="button" data-action="cores-all">Alle fehlenden laden</button></div><p class="muted">Kerne von EmulatorJS 4.2.3, geladen aus der npm-Registry und per SHA-256 geprüft. Danach laufen sie ohne Internet.</p><div id="ad-cores"><p class="muted">Lade …</p></div><pre class="log" id="ad-gamelog" tabindex="0" aria-label="Protokoll: Emulatoren nachladen" hidden></pre></section>' +
      '<section class="panel section" aria-labelledby="ad-bios"><h2 id="ad-bios">BIOS-Dateien</h2><p class="muted">Manche Systeme brauchen eine BIOS-Datei des Original-Geräts. Nur eigene Sicherungen verwenden.</p><div id="ad-bioslist"></div></section>' +
      '<div class="grid-2 section"><section class="panel" aria-labelledby="ad-sys"><div class="section-head"><h2 id="ad-sys">System</h2><button class="btn secondary small" type="button" data-action="admin-refresh">Aktualisieren</button></div><div id="ad-system"><p class="muted">Lade …</p></div></section>' +
      '<section class="panel stack" aria-labelledby="ad-reg"><h2 id="ad-reg">Registrierung</h2><div id="ad-settings"></div></section></div>' +
      '<section class="panel section" aria-labelledby="ad-users"><h2 id="ad-users">Konten</h2><div id="ad-userlist"><p class="muted">Lade …</p></div>' +
      '<form id="admin-user-form" class="inline-form section"><label class="field" for="au-new-name">Benutzername<input id="au-new-name" autocapitalize="none" required maxlength="24"></label><label class="field" for="au-new-display">Anzeigename<input id="au-new-display" maxlength="24"></label><label class="field" for="au-new-pw">Startpasswort (mind. 8)<input id="au-new-pw" type="password" autocomplete="new-password" required minlength="8"></label><label class="field" for="au-new-role">Rolle<select id="au-new-role"><option value="user">Mitglied</option><option value="admin">Administrator</option></select></label><button class="btn" type="submit">Konto anlegen</button></form><div id="ad-temp"></div></section>' +
      '<section class="panel section" aria-labelledby="ad-bak"><h2 id="ad-bak">Sicherung und Wiederherstellung</h2><p class="muted">Täglich legt der Server automatisch eine Sicherung an (Konten, Daten, Spielstände). Spieldateien, BIOS und Emulatoren sichert vzdump.</p>' +
      '<div class="row"><a class="btn" href="/api/admin/backup" download>Sicherung herunterladen</a><button class="btn secondary" type="button" data-action="backup-create">Sicherung auf dem Server anlegen</button><label class="btn secondary" for="restore-file">Wiederherstellen …</label><input class="sr-only" type="file" id="restore-file" accept="application/json,.json"></div>' +
      '<h3 class="section">Vollständige Sicherung</h3><p class="muted">Enthält zusätzlich hochgeladene Spieldateien, Cover und BIOS (kann mehrere GB groß sein). Spiele aus dem Import-Ordner bleiben dort und sind nicht enthalten.</p>' +
      '<div class="row"><a class="btn" href="/api/admin/backup/full" download>Vollständige Sicherung herunterladen</a><label class="btn secondary" for="restore-full-file">Vollständig wiederherstellen …</label><input class="sr-only" type="file" id="restore-full-file" accept=".tar,application/x-tar"></div>' +
      '<progress id="restore-progress" max="100" value="0" hidden aria-label="Fortschritt Wiederherstellung"></progress><p class="status-line" id="restore-msg" role="status" aria-live="polite"></p><div id="ad-backups" class="section"></div></section>' +
      '<section class="panel section" aria-labelledby="ad-audit"><h2 id="ad-audit">Protokoll</h2><div id="ad-auditlist"><p class="muted">Lade …</p></div></section>';
    loadAdmin();
  };
  function loadAdmin() {
    refreshCatalog().then(function () { renderAdminGames(); renderBios(); }, errToast);
    api('GET', '/api/admin/system').then(function (s) {
      var box = $('#ad-system'); if (!box) return;
      var up = s.uptime > 86400 ? Math.floor(s.uptime / 86400) + ' Tage' : Math.floor(s.uptime / 3600) + ' Std. ' + Math.floor(s.uptime % 3600 / 60) + ' Min.';
      var rows = [['Version', s.version], ['Container', s.hostname], ['Laufzeit', up], ['Node.js', s.node], ['Speicher Server', fmtBytes(s.memory.rss)], ['RAM frei', fmtBytes(s.memory.free) + ' von ' + fmtBytes(s.memory.total)], ['Speicherplatz frei', s.disk ? fmtBytes(s.disk.free) + ' von ' + fmtBytes(s.disk.total) : '–'], ['Konten', s.users], ['Online', s.online + ' Personen'], ['Spiele', s.games], ['Emulator-Kerne', s.cores], ['Couch-Sessions', s.couches], ['Netplay-Räume', s.netplayRooms]];
      box.innerHTML = '<dl class="kv">' + rows.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('') + '</dl>';
      var bk = $('#ad-backups'); if (bk) bk.innerHTML = s.backups.length ? '<h3>Letzte Sicherungen auf dem Server</h3><ul class="list">' + s.backups.map(function (b) { return '<li class="person"><span class="grow">' + esc(b.name) + '</span><span class="muted">' + Math.ceil(b.size / 1024) + ' KB</span></li>'; }).join('') + '</ul>' : '';
    }, errToast);
    api('GET', '/api/admin/settings').then(function (s) {
      var box = $('#ad-settings'); if (!box) return;
      box.innerHTML = '<fieldset class="field"><legend>Neue Konten</legend><label class="check"><input type="radio" name="registration" value="open"' + (s.registration === 'open' ? ' checked' : '') + '> Registrierung offen</label><label class="check"><input type="radio" name="registration" value="closed"' + (s.registration !== 'open' ? ' checked' : '') + '> Registrierung geschlossen</label></fieldset>';
    }, errToast);
    loadAdminUsers(); loadCores(); loadAudit();
  }
  function renderAdminGames() {
    var box = $('#ad-games'); if (!box) return; var h = $('#ad-lib'); if (h) h.textContent = 'Spiele (' + GAMES.length + ')';
    box.innerHTML = GAMES.length ? '<ul class="list">' + GAMES.map(function (g) {
      var srcs = {}; g.files.forEach(function (f) { srcs[f.src] = 1; });
      return '<li class="person"><span class="tag">' + esc(glyph(g.system)) + '</span><span class="grow"><b>' + esc(g.title) + '</b> <span class="muted">' + esc(sysName(g.system)) + ', ' + g.files.length + (g.files.length === 1 ? ' Datei' : ' Dateien') + ', ' + fmtSize(g.size) + ', ' + Object.keys(srcs).map(function (x) { return { upload: 'Upload', url: 'URL', folder: 'Ordner' }[x] || x; }).join('/') + '</span>' + (notReadyReason(g) ? ' <span class="tag warn">' + esc(notReadyReason(g)) + '</span>' : '') + ' <span class="tag' + (g.rating === null || g.rating === undefined ? ' warn' : '') + '">' + esc(ratingText(g.rating)) + '</span>' + (g.cover ? ' <span class="tag">Cover</span>' : '') + '</span>' +
        '<span class="row"><button class="btn small secondary" type="button" data-game-edit="' + g.gid + '" aria-label="' + esc(g.title) + ' bearbeiten">Bearbeiten</button><button class="btn small secondary" type="button" data-game-del="' + g.gid + '" aria-label="' + esc(g.title) + ' entfernen">Entfernen</button></span></li>';
    }).join('') + '</ul>' : '<p class="muted">Noch keine Spiele.</p>';
  }
  function renderEdit(gid) {
    var g = GAME['g' + gid], box = $('#ad-edit'); if (!g || !box) return;
    var same = GAMES.filter(function (x) { return x.system === g.system && x.gid !== g.gid; });
    var opt = function (v, l, sel) { return '<option value="' + v + '"' + (sel ? ' selected' : '') + '>' + l + '</option>'; };
    box.innerHTML = '<section class="panel edit-panel stack" aria-labelledby="ed-title"><div class="section-head"><h3 id="ed-title">Bearbeiten: ' + esc(g.title) + '</h3><button class="btn small secondary" type="button" data-action="edit-close">Schließen</button></div>' +
      '<form id="game-edit-form" class="stack" data-gid="' + g.gid + '" novalidate><div class="grid-2"><label class="field" for="ed-t">Titel<input id="ed-t" maxlength="60" value="' + esc(g.title) + '"></label>' +
      '<label class="field" for="ed-r">Altersfreigabe<select id="ed-r">' + opt('', 'nicht eingestuft (für Kinder verborgen)', g.rating === null || g.rating === undefined) + [0, 6, 12, 16, 18].map(function (r) { return opt(r, 'ab ' + r, g.rating === r); }).join('') + '</select></label>' +
      '<label class="field" for="ed-y">Erscheinungsjahr<input id="ed-y" inputmode="numeric" maxlength="4" value="' + esc(g.year || '') + '"></label><label class="field" for="ed-g">Genre<input id="ed-g" maxlength="40" value="' + esc(g.genre || '') + '"></label>' +
      '<label class="field" for="ed-p">Spieler<select id="ed-p">' + [1, 2, 3, 4, 5, 6, 8].map(function (n) { return opt(n, String(n), g.players === n); }).join('') + '</select></label></div>' +
      '<label class="field" for="ed-d">Beschreibung<textarea id="ed-d" rows="3" maxlength="300">' + esc(g.desc || '') + '</textarea></label><p class="status-line" id="ed-msg" role="alert"></p><button class="btn" type="submit">Speichern</button></form>' +
      '<form id="cover-form" class="inline-form" data-gid="' + g.gid + '" novalidate><label class="field" for="ed-c">Cover (PNG, JPEG oder WebP, bis 2 MB)<input id="ed-c" type="file" accept="image/png,image/jpeg,image/webp"></label><button class="btn secondary" type="submit">Cover hochladen</button>' + (g.cover ? '<button class="btn secondary" type="button" data-cover-del="' + g.gid + '">Cover entfernen</button>' : '') + '</form>' +
      (same.length ? '<form id="merge-form" class="inline-form" data-gid="' + g.gid + '" novalidate><label class="field" for="ed-m">Weitere Disc übernehmen (Spiel desselben Systems)<select id="ed-m">' + same.map(function (x) { return opt(x.gid, esc(x.title), false); }).join('') + '</select></label><button class="btn secondary" type="submit">Zusammenführen</button></form>' : '') +
      '</section>';
    $('#ed-t').focus();
  }
  function loadCores() {
    Promise.all([api('GET', '/api/admin/cores'), api('GET', '/api/admin/games/job')]).then(function (r) {
      var box = $('#ad-cores'); if (!box) return;
      box.innerHTML = '<ul class="list">' + r[0].packages.map(function (p) {
        return '<li class="person"><span class="grow"><b>' + esc(p.core ? p.systems.join(', ') : p.title) + '</b> <span class="muted">' + esc(p.core || 'Oberfläche') + ', ' + esc(p.license) + (p.sizeMB ? ', ' + String(p.sizeMB).replace('.', ',') + ' MB Paket' : '') + '</span></span>' +
          (p.installed ? '<span class="tag ok">installiert</span>' : '<button class="btn small" type="button" data-core-install="' + esc(p.id) + '"' + (r[1].running ? ' disabled' : '') + '>Laden</button>') + '</li>';
      }).join('') + '</ul>';
      var job = r[1], log = $('#ad-gamelog');
      if (job.log.length && log) { log.hidden = false; log.textContent = job.log.join('\n') + (job.running ? '\n…' : '\nBeendet mit Code ' + job.code); log.scrollTop = log.scrollHeight; }
      var all = $('[data-action="cores-all"]'); if (all) { all.disabled = job.running; all.textContent = job.running ? 'Lädt …' : 'Alle fehlenden laden'; }
      clearTimeout(gamesPoll); if (job.running && currentView === 'admin') gamesPoll = setTimeout(loadCores, 1500); else if (!job.running && job.code !== null) refreshCatalog().then(function () { renderAdminGames(); renderBios(); });
    }, errToast);
  }
  function renderBios() {
    var box = $('#ad-bioslist'); if (!box) return;
    box.innerHTML = '<ul class="list">' + SYSTEMS.filter(function (s) { return s.bios; }).map(function (s) {
      return '<li class="person"><span class="grow"><b>' + esc(s.name) + '</b> <span class="tag' + (s.bios === 'required' ? ' warn' : '') + '">' + (s.bios === 'required' ? 'erforderlich' : 'optional') + '</span><br><span class="muted">' + esc(s.biosHint || '') + (s.biosInstalled ? ' – vorhanden: ' + esc(s.biosFile) : '') + '</span></span>' +
        (s.biosInstalled ? '<button class="btn small secondary" type="button" data-bios-del="' + esc(s.key) + '">Entfernen</button>' : '<form class="inline-form bios-form" data-bios="' + esc(s.key) + '"><label class="sr-only" for="bios-' + esc(s.key) + '">BIOS-Datei für ' + esc(s.name) + '</label><input id="bios-' + esc(s.key) + '" type="file"><label class="check"><input type="checkbox"> Eigene Sicherung</label><button class="btn small" type="submit">Hochladen</button></form>') + '</li>';
    }).join('') + '</ul>';
  }
  function xhrUpload(url, body, bar, msg) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest(); x.open('POST', url); x.setRequestHeader('X-RetroHub', '1'); x.setRequestHeader('Content-Type', 'application/octet-stream');
      if (bar) { bar.hidden = false; bar.value = 0; x.upload.onprogress = function (e) { if (e.lengthComputable) { bar.value = Math.round(e.loaded / e.total * 100); if (msg) msg.textContent = 'Hochladen … ' + bar.value + ' %'; } }; }
      x.onload = function () { if (bar) bar.hidden = true; var j = {}; try { j = JSON.parse(x.responseText); } catch (e) { j = {}; } if (x.status === 200) resolve(j); else reject(new Error(j.error || ('Fehler ' + x.status))); };
      x.onerror = function () { if (bar) bar.hidden = true; reject(new Error('Upload abgebrochen (Netzwerk)')); };
      x.send(body);
    });
  }
  function uploadGame(f) {
    var files = Array.prototype.slice.call($('#up-files').files), msg = $('#up-msg'), bar = $('#up-progress'), sys = $('#up-system').value; msg.textContent = '';
    if (!files.length) { msg.textContent = 'Bitte mindestens eine Datei auswählen.'; return; }
    if (!$('#up-rights').checked) { msg.textContent = 'Bitte bestätigen, dass du die Rechte an den Dateien besitzt.'; return; }
    files.sort(function (a, b) { var p = function (n) { return /\.(cue|m3u|ccd)$/i.test(n.name) ? 0 : 1; }; return p(a) - p(b); });
    var title = $('#up-title').value.trim(), gameId = null, i = 0;
    (function next() {
      if (i >= files.length) { f.reset(); msg.textContent = ''; toast(files.length > 1 ? 'Spiel mit ' + files.length + ' Dateien hinzugefügt' : 'Spiel hinzugefügt'); refreshCatalog().then(renderAdminGames); return; }
      var file = files[i++], q = new URLSearchParams({ system: sys, filename: file.name, rights: '1', players: $('#up-players').value });
      if (gameId) q.set('game', gameId); else if (title) q.set('title', title);
      msg.textContent = 'Datei ' + i + ' von ' + files.length + ': ' + file.name;
      xhrUpload('/api/admin/library/upload?' + q.toString(), file, bar, msg).then(function (j) { gameId = gameId || j.game.id; next(); }, function (e) { msg.textContent = file.name + ': ' + e.message; refreshCatalog().then(renderAdminGames); });
    }());
  }
  function urlImport(f) {
    var msg = $('#url-msg'), bar = $('#url-progress'); msg.textContent = '';
    if (!$('#url-url').value.trim()) { msg.textContent = 'Bitte eine Adresse eingeben.'; return; }
    if (!$('#url-rights').checked) { msg.textContent = 'Bitte bestätigen, dass du die Rechte an der Datei besitzt.'; return; }
    api('POST', '/api/admin/library/url', { url: $('#url-url').value.trim(), system: $('#url-system').value, title: $('#url-title').value.trim(), rights: true }).then(function (r) {
      bar.hidden = false; bar.removeAttribute('value');
      (function poll() {
        api('GET', '/api/admin/jobs/' + r.job.id).then(function (x) {
          var j = x.job; if (j.total) { bar.max = 100; bar.value = Math.round(j.received / j.total * 100); }
          msg.textContent = j.state === 'läuft' ? 'Lädt … ' + fmtSize(j.received) + (j.total ? ' von ' + fmtSize(j.total) : '') : '';
          if (j.state === 'läuft') return setTimeout(poll, 700);
          bar.hidden = true;
          if (j.state === 'fertig') { f.reset(); toast('„' + j.game.title + '“ hinzugefügt'); refreshCatalog().then(renderAdminGames); } else msg.textContent = 'Fehler: ' + j.error;
        }, errToast);
      }());
    }, function (e) { msg.textContent = e.message; });
  }
  function scanImport() {
    var box = $('#import-list'); box.innerHTML = '<p class="muted">Lese Ordner …</p>';
    api('GET', '/api/admin/import/scan').then(function (r) {
      if (!r.available) { box.innerHTML = '<div class="notice"><strong>Kein Ordner:</strong><span>' + esc(r.dir) + ' ist nicht eingebunden. Beim Installieren mit IMPORT_DIR=/pfad/auf/dem/host angeben (oder in Proxmox einen Bind-Mount nach /srv/retrohub-import anlegen).</span></div>'; return; }
      var files = r.files.filter(function (x) { return !(/\.bin$/i.test(x.name) && r.files.some(function (y) { return /\.cue$/i.test(y.name) && y.path.split('/').slice(0, -1).join('/') === x.path.split('/').slice(0, -1).join('/'); })); });
      if (!files.length) { box.innerHTML = '<p class="muted">Keine passenden Dateien gefunden.</p>'; return; }
      box.innerHTML = '<form id="import-form" class="stack" novalidate><p class="muted">' + files.length + ' Dateien. BIN-Dateien neben einer CUE werden automatisch mitgenommen.</p><div class="table-wrap"><table class="imp"><thead><tr><th scope="col">Übernehmen</th><th scope="col">Datei</th><th scope="col">System</th><th scope="col">Titel</th></tr></thead><tbody>' +
        files.map(function (x, i) {
          return '<tr><td><input type="checkbox" id="imp-' + i + '" data-imp="' + i + '"' + (x.imported ? ' disabled' : ' checked') + ' aria-label="' + esc(x.name) + ' übernehmen"></td><td><span class="mono">' + esc(x.path) + '</span><br><span class="muted">' + fmtSize(x.size) + (x.imported ? ', bereits importiert' : '') + '</span></td>' +
            '<td><label class="sr-only" for="imp-sys-' + i + '">System für ' + esc(x.name) + '</label><select id="imp-sys-' + i + '">' + x.systems.map(function (k) { return '<option value="' + esc(k) + '">' + esc(sysName(k)) + '</option>'; }).join('') + '</select></td>' +
            '<td><label class="sr-only" for="imp-t-' + i + '">Titel für ' + esc(x.name) + '</label><input id="imp-t-' + i + '" maxlength="60" value="' + esc(x.name.replace(/\.[^.]+$/, '')) + '"></td></tr>';
        }).join('') + '</tbody></table></div><label class="check"><input type="checkbox" id="imp-rights"> Ich besitze die Rechte an diesen Dateien.</label><p class="status-line" id="imp-msg" role="alert"></p><button class="btn" type="submit">Ausgewählte importieren</button></form>';
      state.importFiles = files;
    }, function (e) { box.innerHTML = '<p class="status-line">' + esc(e.message) + '</p>'; });
  }
  function runImport() {
    var msg = $('#imp-msg'); if (!$('#imp-rights').checked) { msg.textContent = 'Bitte bestätigen, dass du die Rechte an den Dateien besitzt.'; return; }
    var items = state.importFiles.map(function (x, i) { var c = $('#imp-' + i); return c && c.checked && !c.disabled ? { path: x.path, system: $('#imp-sys-' + i).value, title: $('#imp-t-' + i).value.trim() } : null; }).filter(Boolean);
    if (!items.length) { msg.textContent = 'Keine Datei ausgewählt.'; return; }
    msg.textContent = 'Importiere ' + items.length + ' Dateien (Prüfsummen werden berechnet) …';
    api('POST', '/api/admin/import', { rights: true, items: items }).then(function (r) {
      // Ergebnis außerhalb der Liste anzeigen – die Liste wird anschließend neu eingelesen
      var text = r.imported.length + (r.imported.length === 1 ? ' Spiel importiert' : ' Spiele importiert') + (r.errors.length ? ', ' + r.errors.length + ' nicht übernommen: ' + r.errors.map(function (e) { return e.path + ' – ' + e.error; }).join('; ') : '');
      $('#imp-result').textContent = text; toast(r.imported.length + ' importiert' + (r.errors.length ? ', ' + r.errors.length + ' Fehler' : ''));
      refreshCatalog().then(function () { renderAdminGames(); scanImport(); });
    }, function (e) { msg.textContent = e.message; });
  }

  function loadAdminUsers() {
    api('GET', '/api/admin/users').then(function (r) {
      var box = $('#ad-userlist'); if (!box) return;
      box.innerHTML = '<ul class="list">' + r.users.map(function (u) {
        var self = u.id === state.me.id;
        return '<li class="person">' + avatar(u, true) + '<span class="grow"><b>' + esc(u.display) + '</b> <span class="muted">@' + esc(u.name) + '</span><br><span class="presence' + (u.online ? ' on' : '') + '" aria-hidden="true"></span><span class="muted">' + (u.role === 'admin' ? 'Administrator' : u.role === 'child' ? 'Kinderprofil' : 'Mitglied') + (u.disabled ? ', gesperrt' : '') + (u.lastLogin ? ', zuletzt ' + fmtTime(u.lastLogin) : '') + '</span></span>' +
          (self ? '<span class="tag ok">Du</span>' : '<span class="row">' + (u.role !== 'child' ? '<button class="btn small secondary" type="button" data-admin-role="' + esc(u.id) + '" data-role="' + (u.role === 'admin' ? 'user' : 'admin') + '">' + (u.role === 'admin' ? 'Zum Mitglied' : 'Zum Admin') + '</button>' : '') +
          '<button class="btn small secondary" type="button" data-admin-disable="' + esc(u.id) + '" data-disabled="' + (!u.disabled) + '">' + (u.disabled ? 'Entsperren' : 'Sperren') + '</button>' +
          '<button class="btn small secondary" type="button" data-admin-display="' + esc(u.id) + '" aria-label="Anzeigename von ' + esc(u.display) + ' ändern">Name ändern</button>' +
          '<button class="btn small secondary" type="button" data-admin-reset="' + esc(u.id) + '">Passwort zurücksetzen</button>' +
          '<button class="btn small secondary" type="button" data-admin-delete="' + esc(u.id) + '" aria-label="' + esc(u.display) + ' löschen">Löschen</button></span>') + '</li>';
      }).join('') + '</ul>';
    }, errToast);
  }
  function loadAudit() {
    api('GET', '/api/admin/audit').then(function (r) {
      var box = $('#ad-auditlist'); if (!box) return;
      box.innerHTML = r.audit.length ? '<ul class="list">' + r.audit.slice(0, 40).map(function (a) { return '<li class="person"><span class="grow"><b>' + esc(a.action) + '</b> ' + esc(a.detail) + '<br><span class="muted">' + esc(a.actor) + ', ' + fmtTime(a.at) + '</span></span></li>'; }).join('') + '</ul>' : '<p class="muted">Noch keine Einträge.</p>';
    }, errToast);
  }
  RENDER.mehr = function () {
    var links = [['favoriten', 'heart', 'Favoriten'], ['couch', 'tv', 'Couch-Modus'], ['turniere', 'trophy', 'Turniere'], ['chat', 'chat', 'Chat'], ['mitteilungen', 'bell', 'Mitteilungen'], ['profil', 'user', 'Profil'], ['einstellungen', 'settings', 'Einstellungen'], ['admin', 'shield', 'Administration']]
      .filter(function (l) { return !(ADULT_ONLY[l[0]] && state.me.role === 'child') && !(l[0] === 'admin' && state.me.role !== 'admin'); });
    $('#main').innerHTML = '<h1>Mehr</h1><nav aria-label="Weitere Bereiche" class="more-grid">' + links.map(function (l) { return '<a href="#' + l[0] + '">' + icon(l[1]) + l[2] + '</a>'; }).join('') + '</nav>';
  };
  function pendingJoin() {
    var code = null; try { code = sessionStorage.getItem('rh.join'); } catch (e) { code = null; }
    if (!code || !state.me || !state.online) return;
    try { sessionStorage.removeItem('rh.join'); } catch (e) { /* ohne Speicher */ }
    RT.send({ t: 'couch.join', code: code }); var log = $('#ctrl-log'); if (log) log.textContent = 'Verbinde mit ' + code + ' …';
  }
  function trapFocus(dlg) {
    dlg.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var f = $$('button, [href], input, select, textarea, iframe, canvas[tabindex], [tabindex]:not([tabindex="-1"])', dlg).filter(function (el) { return !el.disabled && !el.hidden && el.offsetParent !== null; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || !dlg.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !dlg.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    });
  }
  /* ---------- Detaildialog ---------- */
  var lastFocus = null;
  function openDetail(id) {
    var g = GAME[id]; if (!g) return; lastFocus = document.activeElement;
    var s = SYS[g.system] || {}, reason = notReadyReason(g), admin = state.me.role === 'admin';
    $('#detail-body').innerHTML =
      '<div class="sheet-head">' + spine(g.system, g) + '<div><h2 id="detail-title">' + esc(g.title) + '</h2><p class="muted">' + esc(sysName(g.system)) + (g.year ? ', ' + g.year : '') + (g.genre ? ', ' + esc(g.genre) : '') + '</p></div>' +
      '<button type="button" class="icon-btn close" data-action="close-detail" aria-label="Dialog schließen">' + icon('close') + '</button></div>' +
      '<div class="sheet-body stack">' + (g.desc ? '<p>' + esc(g.desc) + '</p>' : '') +
      '<div class="row"><span class="tag">' + esc(playersText(g)) + '</span><span class="tag">' + g.files.length + (g.files.length === 1 ? ' Datei' : ' Dateien') + ', ' + fmtSize(g.size) + '</span><span class="tag">Kern ' + esc(s.core || '?') + '</span><span class="tag">Freigabe ' + esc(ratingText(g.rating)) + '</span>' + (g.discs ? '<span class="tag">' + g.discs + ' Discs</span>' : '') + '</div>' +
      (g.discs ? '<p class="muted">Disc wechseln: im Emulator-Menü unter „Disks“.</p>' : '') +
      '<p class="muted">' + g.files.map(function (f) { return esc(f.name); }).join(', ') + '</p>' +
      (reason ? '<div class="notice"><strong>' + esc(reason) + ':</strong><span>' + (reason === 'BIOS fehlt' ? 'Für ' + esc(s.name) + ' wird eine BIOS-Datei benötigt (' + esc(s.biosHint || '') + ').' : 'Der Emulator für ' + esc(s.name) + ' ist noch nicht geladen.') + (admin ? ' Unter Administration nachholen.' : ' Ein Admin kann das nachholen.') + '</span></div>' : '') +
      (s.threads ? '<p class="muted">Dieses System braucht einen aktuellen Browser und ein leistungsfähiges Gerät.</p>' : '') +
      '<p class="muted">Spielstände: 3 Speicherplätze plus automatisches Speichern beim Beenden. Netplay (experimentell) über das Globus-Symbol im Spiel.</p>' +
      '<div class="row"><button type="button" class="btn" data-play="' + esc(g.id) + '"' + (reason ? ' disabled' : '') + '>' + (reason ? 'Nicht spielbereit' : 'Spiel starten') + '</button>' +
      '<button type="button" class="btn secondary fav-inline" data-fav="' + esc(g.id) + '" aria-pressed="' + isFav(g.id) + '">' + (isFav(g.id) ? 'Aus Favoriten entfernen' : 'Zu Favoriten') + '</button></div></div>';
    $('#detail').showModal();
    var start = $('#detail [data-play]:not([disabled])') || $('#detail .close'); start.focus();
  }
  function closeDetail() { var d = $('#detail'); if (d.open) d.close(); }
  function closeDialogs() { closeDetail(); var p = $('#player'); if (p.open) p.close(); }
  $('#detail').addEventListener('close', function () { if (lastFocus && document.contains(lastFocus) && !$('#player').open) lastFocus.focus(); });
  $('#detail').addEventListener('click', function (e) { if (e.target === e.currentTarget) closeDetail(); });
  trapFocus($('#detail')); trapFocus($('#player'));

  /* ---------- Spieler (EmulatorJS auf dem Emulator-Ursprung, Brücke per postMessage) ---------- */
  var session = null, ejsReq = {}, ejsSeq = 0;
  var SLOT_NAMES = { auto: 'Automatisch', 1: 'Platz 1', 2: 'Platz 2', 3: 'Platz 3', sram: 'Spielspeicher' };
  function gameOrigin() { return location.protocol + '//' + location.hostname + ':' + (location.protocol === 'https:' ? '8443' : '8080'); }
  function ejsFrame() { return session && session.game && session.game.frame; }
  function ejsCall(type, payload, transfer) {
    var f = ejsFrame(); if (!f) return Promise.reject(new Error('Kein Emulator'));
    var id = 'r' + (++ejsSeq);
    return new Promise(function (res, rej) {
      ejsReq[id] = { res: res, rej: rej };
      f.contentWindow.postMessage(Object.assign({ rh: type, id: id }, payload || {}), gameOrigin(), transfer || []);
      setTimeout(function () { if (ejsReq[id]) { delete ejsReq[id]; rej(new Error('Emulator antwortet nicht')); } }, 30000);
    });
  }
  function fetchBin(url) { return fetch(url, { credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error('Laden fehlgeschlagen (' + r.status + ')'); return r.arrayBuffer(); }); }
  function putBin(url, buf) {
    return fetch(url, { method: 'PUT', credentials: 'same-origin', headers: { 'X-RetroHub': '1', 'Content-Type': 'application/octet-stream' }, body: buf }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j && j.error || 'Speichern fehlgeschlagen'); return j; }); });
  }
  function ejsSave(slot, silent) {
    var key = session.game.key, label = session.game.title;
    return ejsCall('save').then(function (m) {
      var jobs = [putBin('/api/saves/' + key + '/' + slot + '/bin?label=' + encodeURIComponent(label), m.state)];
      if (m.sram) jobs.push(putBin('/api/saves/' + key + '/sram/bin?label=' + encodeURIComponent(label + ' (Spielspeicher)'), m.sram));
      return Promise.all(jobs).then(function () { return m.thumb ? api('PUT', '/api/saves/' + key + '/' + slot + '/thumb', { thumb: m.thumb }).catch(function () { return null; }) : null; });
    }).then(function () { if (silent) toast('Automatisch gespeichert'); else { toast('Gespeichert in ' + SLOT_NAMES[slot]); renderSavesPanel(); } }, function (e) { toast('Speichern fehlgeschlagen: ' + e.message); throw e; });
  }
  function ejsLoad(slot) {
    fetchBin('/api/saves/' + session.game.key + '/' + slot + '/bin').then(function (buf) { return ejsCall('load', { state: buf }, [buf]); })
      .then(function () { closeSavesPanel(); toast(SLOT_NAMES[slot] + ' geladen'); }, errToast);
  }
  function romSave(slot) { return ejsSave(slot, false); }
  function romLoad(slot) { ejsLoad(slot); }
  function openSavesPanel() {
    var sg = session && session.game; if (!sg) return;
    if (!sg.started) { toast('Das Spiel startet noch'); return; } ejsCall('pause').catch(function () { return null; });
    var panel = $('#stage .nes-saves');
    if (!panel) { panel = document.createElement('div'); panel.className = 'nes-saves panel'; panel.setAttribute('role', 'group'); panel.setAttribute('aria-labelledby', 'saves-title'); $('#stage .emu-wrap').appendChild(panel); }
    panel.hidden = false; panel.innerHTML = '<p class="muted">Lade …</p>'; renderSavesPanel();
  }
  function openPlayer(id, opts) {
    var g = GAME[id]; if (!g || !playable(g)) return; opts = opts || {};
    var returnTo = $('#detail').open ? lastFocus : document.activeElement; closeDetail();
    var dlg = $('#player'); dlg.classList.add('ejs');
    $('#player-title').textContent = g.title + (opts.couch && state.couch ? ' · Couch-Code ' + state.couch.code : '');
    $('#player-score').textContent = ''; $('#player-saves').hidden = false; $('#player-mute').hidden = true;
    $('#stage').innerHTML = ''; dlg.showModal();
    session = { id: id, start: Date.now(), returnTo: returnTo, couch: !!opts.couch, game: null };
    startEjs(g, $('#stage'), opts);
    state.data.progress.last = { id: id, at: Date.now() };
    if (opts.room) toast('Netplay ist experimentell. Im Spiel auf das Globus-Symbol tippen und den Raum „' + opts.room + '“ wählen.');
  }
  function startEjs(g, stage, opts) {
    var sid = session, s = SYS[g.system];
    stage.innerHTML = '<div class="emu-wrap"><p class="status-line" id="emu-status" aria-live="polite">Spiel wird geladen …</p></div>';
    sid.game = { ejs: true, key: g.id, gid: g.gid, system: g.system, core: s.core, threads: !!s.threads, title: g.title, frame: null, started: false, destroy: function () {} };
    var status = $('#emu-status'), fileName = 'spiel';
    Promise.all([
      fetch('/api/library/' + g.gid + '/data', { credentials: 'same-origin' }).then(function (r) {
        if (!r.ok) throw new Error('Spiel konnte nicht geladen werden (' + r.status + ')');
        fileName = decodeURIComponent(r.headers.get('X-Game-File') || 'spiel');
        var total = Number(r.headers.get('Content-Length')) || 0; if (!r.body || !r.body.getReader) return r.arrayBuffer();
        var reader = r.body.getReader(), chunks = [], got = 0;
        return (function pump() { return reader.read().then(function (x) { if (x.done) { var out = new Uint8Array(got), o = 0; chunks.forEach(function (c) { out.set(c, o); o += c.length; }); return out.buffer; } chunks.push(x.value); got += x.value.length; if (status) status.textContent = 'Spiel wird geladen … ' + fmtSize(got) + (total ? ' von ' + fmtSize(total) : ''); return pump(); }); }());
      }),
      api('GET', '/api/saves/' + g.id).catch(function () { return { saves: [] }; }),
      s.biosInstalled ? fetchBin('/api/bios/' + g.system).catch(function () { return null; }) : Promise.resolve(null)
    ]).then(function (res) {
      if (session !== sid) return;
      sid.game.rom = res[0]; sid.game.fileName = fileName; sid.game.bios = res[2];
      var auto = res[1].saves.filter(function (x) { return x.slot === 'auto' && x.kind === 'bin'; })[0], sram = res[1].saves.filter(function (x) { return x.slot === 'sram'; })[0];
      var go = function (withState) {
        Promise.all([withState ? fetchBin('/api/saves/' + g.id + '/auto/bin') : Promise.resolve(null), sram ? fetchBin('/api/saves/' + g.id + '/sram/bin').catch(function () { return null; }) : Promise.resolve(null)]).then(function (b) {
          if (session !== sid) return;
          sid.game.bootState = b[0]; sid.game.bootSram = b[1];
          var wrap = $('#stage .emu-wrap'); wrap.innerHTML = '<p class="status-line" id="emu-status" aria-live="polite">Emulator wird gestartet …</p>';
          var fr = document.createElement('iframe'); fr.className = 'game-frame'; fr.title = g.title + ' (' + sysName(g.system) + ')';
          fr.setAttribute('allow', 'cross-origin-isolated; fullscreen; gamepad; autoplay; screen-wake-lock'); fr.setAttribute('referrerpolicy', 'no-referrer');
          fr.src = gameOrigin() + '/_emu/host.html'; wrap.appendChild(fr); sid.game.frame = fr;
        }, errToast);
      };
      if (auto && !(opts && opts.couch)) {
        $('#stage .emu-wrap').innerHTML = '<div class="game-overlay"><p class="ov-msg"><b>' + esc(g.title) + '</b><br>Automatischer Spielstand vom ' + esc(fmtTime(auto.at)) + '</p><div class="row"><button class="btn" type="button" id="ejs-continue">Weiterspielen</button><button class="btn secondary" type="button" id="ejs-new">Neu starten</button></div></div>';
        $('#ejs-continue').addEventListener('click', function () { go(true); }); $('#ejs-new').addEventListener('click', function () { go(false); }); $('#ejs-continue').focus();
      } else go(false);
    }, function (e) { var st = $('#emu-status'); if (st) st.textContent = e.message; });
  }
  window.addEventListener('message', function (e) {
    var f = ejsFrame(); if (!f || e.source !== f.contentWindow || e.origin !== gameOrigin()) return;
    var m = e.data || {}, sg = session.game;
    if (m.rh === 'ready') {
      var tr = [sg.rom].concat(sg.bootState ? [sg.bootState] : [], sg.bootSram ? [sg.bootSram] : [], sg.bios ? [sg.bios] : []);
      f.contentWindow.postMessage({ rh: 'start', core: sg.core, threads: sg.threads, netplay: true, rom: sg.rom, fileName: sg.fileName, gameId: sg.gid, state: sg.bootState || null, sram: sg.bootSram || null, bios: sg.bios || null }, gameOrigin(), tr);
      sg.rom = null; sg.bootState = null; sg.bootSram = null; sg.bios = null;
    } else if (m.rh === 'started') { sg.started = true; var st = $('#emu-status'); if (st) st.hidden = true; try { f.focus(); } catch (x) { /* fremder Ursprung */ } }
    else if (m.rh === 'error') { var s2 = $('#emu-status'); if (s2) { s2.hidden = false; s2.textContent = m.message; } toast(m.message); }
    else if (m.rh === 'reply' && ejsReq[m.id]) { var r = ejsReq[m.id]; delete ejsReq[m.id]; if (m.error) r.rej(new Error(m.error)); else r.res(m); }
  });
  function forwardPad(m) { var f = ejsFrame(); if (!f || !session || !session.couch || !session.game.started) return; f.contentWindow.postMessage({ rh: 'pad', slot: m.slot, button: m.button, value: m.value }, gameOrigin()); }
  function requestClose() {
    var sg = session && session.game;
    if (sg && sg.ejs && sg.started && !sg.closing) {
      sg.closing = true; toast('Spielstand wird gespeichert …');
      // Erst pausieren: ein laufender Emulator belegt sonst die CPU und bremst das Speichern stark aus.
      ejsCall('pause').catch(function () { return null; }).then(function () { return ejsSave('auto', true); }).then(function () { $('#player').close(); }, function () { $('#player').close(); });
      return;
    }
    if (!(sg && sg.closing)) $('#player').close();
  }
  $('#player-close').addEventListener('click', requestClose);
  $('#player').addEventListener('cancel', function (e) { var sg = session && session.game; if (sg && sg.ejs && sg.started) { e.preventDefault(); requestClose(); } });
  $('#player').addEventListener('close', function () {
    if (!session) return; var s = session, sec = Math.round((Date.now() - s.start) / 1000); session = null; $('#stage').innerHTML = '';
    postProgress({ game: s.id, seconds: sec, rounds: sec >= 10 ? 1 : 0 }).then(function () { if (currentView === 'home' || currentView === 'profil') RENDER[currentView](); });
    if (s.returnTo && document.contains(s.returnTo)) s.returnTo.focus(); else $('#main').focus();
  });

  /* ---------- Spielstände (Speicherplätze) ---------- */
  function renderSavesPanel() {
    var panel = $('#stage .nes-saves'); if (!panel || !session) return;
    api('GET', '/api/saves/' + session.game.key).then(function (r) {
      var by = {}; r.saves.forEach(function (x) { by[x.slot] = x; });
      panel.innerHTML = '<div class="section-head"><h3 id="saves-title">Spielstände</h3><button class="btn small secondary" type="button" data-saves-close>Zurück zum Spiel</button></div><ul class="list">' +
        ['auto', '1', '2', '3'].map(function (sl) {
          var x = by[sl];
          return '<li class="person">' + (x && x.thumb ? '<img class="save-thumb" src="' + esc(x.thumb) + '" alt="">' : '<span class="save-thumb empty" aria-hidden="true"></span>') + '<span class="grow"><b>' + SLOT_NAMES[sl] + '</b><br><span class="muted">' + (x ? esc(fmtTime(x.at)) : 'leer') + '</span></span><span class="row">' +
            (sl !== 'auto' ? '<button class="btn small" type="button" data-slot-save="' + sl + '">Speichern</button>' : '') +
            (x ? '<button class="btn small secondary" type="button" data-slot-load="' + sl + '">Laden</button><button class="btn small secondary" type="button" data-slot-del="' + sl + '" aria-label="' + SLOT_NAMES[sl] + ' löschen">Löschen</button>' : '') + '</span></li>';
        }).join('') + '</ul><p class="muted">Beim Beenden wird automatisch gespeichert. Spielstände liegen auf dem Server und gehören zu deinem Konto.</p>';
      var f = panel.querySelector('button'); if (f) f.focus();
    }, errToast);
  }
  function closeSavesPanel() { var p = $('#stage .nes-saves'); if (p) p.hidden = true; }
  function loadSavesList() {
    api('GET', '/api/saves').then(function (r) {
      var box = $('#pf-saves'); if (!box) return;
      box.innerHTML = r.saves.length ? '<ul class="list">' + r.saves.map(function (x) {
        var g = GAME[x.game];
        return '<li class="person">' + (x.thumb ? '<img class="save-thumb" src="' + esc(x.thumb) + '" alt="">' : '<span class="save-thumb empty" aria-hidden="true"></span>') + '<span class="grow"><b>' + esc(g ? g.title : x.label || x.game) + '</b><br><span class="muted">' + SLOT_NAMES[x.slot] + ', ' + esc(fmtTime(x.at)) + ', ' + Math.ceil(x.size / 1024) + ' KB</span></span><span class="row">' +
          (g && playable(g) ? '<button class="btn small" type="button" data-play="' + esc(g.id) + '">Spielen</button>' : '') + '<button class="btn small secondary" type="button" data-save-del="' + esc(x.game + ':' + x.slot) + '" aria-label="Spielstand ' + esc(g ? g.title : x.game) + ' ' + SLOT_NAMES[x.slot] + ' löschen">Löschen</button></span></li>';
      }).join('') + '</ul>' : '<p class="muted">Noch keine Spielstände. In ROM-Spielen speicherst du über „Spielstände“, Lights Out merkt sich angefangene Rätsel automatisch.</p>';
    }, errToast);
  }

  /* ---------- Echtzeit-Nachrichten ---------- */
  function onRealtime(m) {
    switch (m.t) {
      case 'hello': state.me = m.user; applyProfile(); setConn(true); break;
      case 'couch': {
        var c = m.couch;
        if (m.closed && m.display) { state.couch = null; state.couchId = null; if (currentView === 'couch') renderCouchPanel(); break; }
        if (!c) { if (state.myCouch) { state.myCouch = null; if (m.closed) toast('Die Couch-Session wurde beendet'); if (currentView === 'controller') renderControllerPanel(); } break; }
        if (c.hostId === state.me.id && (state.awaitCouch || state.couchId === c.id)) { state.awaitCouch = false; state.couchId = c.id; state.couch = c; if (currentView === 'couch') renderCouchPanel(); if (session && session.couch) $('#player-title').textContent = c.gameTitle + ' · Couch-Code ' + c.code; }
        var mine = c.players.some(function (p) { return p.id === state.me.id; });
        if (mine) { var was = state.myCouch; state.myCouch = c; if (currentView === 'controller' && (!was || was.players.length !== c.players.length || was.id !== c.id)) renderControllerPanel(); else if (currentView !== 'controller' && !was) { toast('Verbunden als Controller'); go('controller'); } }
        else if (state.myCouch && state.myCouch.id === c.id) { state.myCouch = null; if (currentView === 'controller') renderControllerPanel(); }
        break;
      }
      case 'pad': forwardPad(m); break;
      case 'error': toast(m.message); var log = $('#ctrl-log'); if (log) log.textContent = m.message; break;
      case 'chat': {
        var ch = m.channel, list = state.chat[ch];
        if (list) list.push(m.message);
        if (currentView === 'chat' && state.channel === ch) renderMessages();
        break;
      }
      case 'notify': state.notifications.unshift(m.n); updateBadge(); if (currentView === 'mitteilungen') RENDER.mitteilungen(); else toast(m.n.text); if (m.n.type === 'friend' || m.n.type === 'friend-request') loadFriends(); break;
      case 'presence': if (state.friends) { state.friends.friends.forEach(function (f) { if (f.id === m.id) f.online = m.online; }); if (currentView === 'freunde') RENDER.freunde(); if (currentView === 'chat') renderChannels(); } break;
      case 'friends': if (state.me.role !== 'child') loadFriends(); break;
      case 'tournaments': if (state.tournaments) loadTournaments(); break;
      case 'library': refreshCatalog().then(function () { if (currentView === 'spiele') renderResults(); else if (currentView === 'home') RENDER.home(); else if (currentView === 'admin') { renderAdminGames(); renderBios(); } }); break;
      default: break;
    }
  }

  /* ---------- Ereignisse ---------- */
  var suppressFocus = false;
  window.addEventListener('hashchange', function () { var f = !suppressFocus; suppressFocus = false; route(f); });

  document.addEventListener('click', function (e) {
    var t = e.target.closest('button, a'); if (!t) return;
    var d = t.dataset;
    if (d.open) { openDetail(d.open); return; }
    if (d.adminTab) { adminTab = d.adminTab; if (currentView !== 'admin') { go('admin'); return; } $$('[data-admin-tab]').forEach(function (b) { var on = b.dataset.adminTab === adminTab; b.classList.toggle('secondary', !on); b.setAttribute('aria-selected', String(on)); }); ['add', 'url', 'folder'].forEach(function (k) { $('#ad-tab-' + k).hidden = k !== adminTab; }); return; }
    if (d.maker && t.classList.contains('chip')) { state.filters.maker = d.maker; $$('.chip').forEach(function (c) { c.setAttribute('aria-pressed', String(c === t)); }); renderResults(); return; }
    if (d.roomJoin) { openPlayer(d.roomJoin, { room: d.roomName }); return; }
    if (d.gameDel) { var gd = GAME['g' + d.gameDel]; if (!window.confirm('„' + (gd ? gd.title : '') + '“ entfernen? Hochgeladene Dateien werden gelöscht, Dateien im Import-Ordner bleiben.')) return; api('DELETE', '/api/admin/library/' + d.gameDel).then(function () { toast('Spiel entfernt'); refreshCatalog().then(renderAdminGames); }, errToast); return; }
    if (d.gameEdit) { renderEdit(Number(d.gameEdit)); $('#ad-edit').scrollIntoView({ block: 'start' }); return; }
    if (d.coverDel) { api('DELETE', '/api/admin/library/' + d.coverDel + '/cover').then(function () { toast('Cover entfernt'); refreshCatalog().then(function () { renderAdminGames(); renderEdit(Number(d.coverDel)); }); }, errToast); return; }
    if (d.coreInstall) { api('POST', '/api/admin/games/install', { only: [d.coreInstall] }).then(function () { toast('Emulator wird geladen'); loadCores(); }, errToast); return; }
    if (d.biosDel) { if (!window.confirm('BIOS-Datei entfernen?')) return; api('DELETE', '/api/admin/bios/' + d.biosDel).then(function () { toast('BIOS entfernt'); refreshCatalog().then(renderBios); }, errToast); return; }
    if (d.slotSave) { romSave(d.slotSave); return; }
    if (d.slotLoad) { romLoad(d.slotLoad); return; }
    if (d.slotDel) { api('DELETE', '/api/saves/' + session.game.key + '/' + d.slotDel).then(function () { toast('Gelöscht'); renderSavesPanel(); }, errToast); return; }
    if (d.savesClose !== undefined) { closeSavesPanel(); ejsCall('resume').catch(function () { return null; }); return; }
    if (d.saveDel) { if (!window.confirm('Spielstand löschen?')) return; var gs = d.saveDel.split(':'); api('DELETE', '/api/saves/' + gs[0] + '/' + gs[1]).then(function () { toast('Spielstand gelöscht'); loadSavesList(); }, errToast); return; }
    if (d.adminDisplay) { var nd = window.prompt('Neuer Anzeigename:'); if (!nd) return; api('PATCH', '/api/admin/users/' + d.adminDisplay, { display: nd }).then(function () { toast('Anzeigename geändert'); loadAdminUsers(); loadAudit(); }, errToast); return; }
    if (t.id === 'player-saves') { openSavesPanel(); return; }
    if (d.fav) { toggleFav(d.fav); return; }
    if (d.play) { openPlayer(d.play); return; }
    if (d.win) { var w = d.win.split(':'); api('POST', '/api/tournaments/' + d.tid + '/result', { round: Number(w[0]), match: Number(w[1]), winner: d.player }).then(function (r) { state.tournaments = state.tournaments.map(function (x) { return x.id === r.tournament.id ? r.tournament : x; }); state.tournamentId = r.tournament.id; RENDER.turniere(); var b = $('[data-win="' + d.win + '"][aria-pressed="true"]'); if (b) b.focus(); toast(d.player + ' gewinnt die Begegnung'); }, errToast); return; }
    if (d.tournament) { state.tournamentId = d.tournament; RENDER.turniere(); return; }
    if (d.channel) { state.channel = d.channel; renderChannels(); var h = $('#ch-title'); if (h) h.textContent = channelTitle(d.channel); if (state.chat[d.channel]) renderMessages(); loadChannel(d.channel); return; }
    if (d.dm) { state.channel = 'dm:' + d.dm; return; }
    if (d.friendAccept) { api('POST', '/api/friends/' + d.friendAccept + '/accept', {}).then(function () { toast('Freundschaft angenommen'); loadFriends(); }, errToast); return; }
    if (d.friendRemove) { if (!window.confirm('Verbindung wirklich entfernen?')) return; api('DELETE', '/api/friends/' + d.friendRemove).then(function () { toast('Entfernt'); loadFriends(); }, errToast); return; }
    if (d.kidPw) { var pin = window.prompt('Neue PIN bzw. neues Passwort (mindestens 4 Zeichen):'); if (!pin) return; api('PATCH', '/api/children/' + d.kidPw, { password: pin }).then(function () { toast('PIN geändert'); }, errToast); return; }
    if (d.kidDel) { if (!window.confirm('Kinderprofil mit allen Spielständen löschen?')) return; api('DELETE', '/api/children/' + d.kidDel).then(function () { toast('Kinderprofil gelöscht'); loadKids(); }, errToast); return; }
    if (d.adminRole) { api('PATCH', '/api/admin/users/' + d.adminRole, { role: d.role }).then(function () { toast('Rolle geändert'); loadAdminUsers(); loadAudit(); }, errToast); return; }
    if (d.adminDisable) { api('PATCH', '/api/admin/users/' + d.adminDisable, { disabled: d.disabled === 'true' }).then(function () { toast(d.disabled === 'true' ? 'Konto gesperrt' : 'Konto entsperrt'); loadAdminUsers(); loadAudit(); }, errToast); return; }
    if (d.adminReset) { if (!window.confirm('Passwort zurücksetzen? Die Person wird abgemeldet.')) return; api('PATCH', '/api/admin/users/' + d.adminReset, { resetPassword: true }).then(function (r) { $('#ad-temp').innerHTML = '<p class="section">Einmalpasswort für <b>' + esc(r.user.display) + '</b> (nur jetzt sichtbar, bitte weitergeben):</p><p class="temp-pw">' + esc(r.tempPassword) + '</p>'; loadAudit(); }, errToast); return; }
    if (d.adminDelete) { if (!window.confirm('Konto endgültig löschen?')) return; api('DELETE', '/api/admin/users/' + d.adminDelete).then(function () { toast('Konto gelöscht'); loadAdminUsers(); loadAudit(); }, errToast); return; }
    if (t.id === 'reset-filters') { resetFilters(); return; }
    if (t.id === 'random-game') { var rl = filtered().filter(playable); if (!rl.length) { toast('Kein spielbereites Spiel passt zu den Filtern'); return; } openDetail(rl[Math.floor(Math.random() * rl.length)].id); return; }
    if (t.id === 'theme-toggle') { state.theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'; local.set('theme', state.theme); applyTheme(); toast(state.theme === 'dark' ? 'Dunkles Farbschema aktiv' : 'Helles Farbschema aktiv'); if (currentView === 'einstellungen') RENDER.einstellungen(); return; }
    var a = d.action; if (!a) return;
    if (a === 'close-detail') closeDetail();
    else if (a === 'reset-filters') resetFilters();
    else if (a === 'auth-switch') { authMode = authMode === 'login' ? 'register' : 'login'; RENDER.anmelden(); }
    else if (a === 'logout') api('POST', '/api/logout', {}).then(function () { loggedOut('Abgemeldet'); }, errToast);
    else if (a === 't-delete') { if (window.confirm('Turnier löschen?')) api('DELETE', '/api/tournaments/' + d.id).then(function () { state.tournamentId = null; loadTournaments(); }, errToast); }
    else if (a === 'admin-refresh') loadAdmin();
    else if (a === 'couch-close') { RT.send({ t: 'couch.close' }); state.couch = null; state.couchId = null; renderCouchPanel(); }
    else if (a === 'couch-play') { if (state.couch) openPlayer('g' + state.couch.gameId, { couch: true }); }
    else if (a === 'couch-leave') { RT.send({ t: 'couch.leave' }); state.myCouch = null; renderControllerPanel(); }
    else if (a === 'rooms-refresh') loadRooms();
    else if (a === 'cores-all') api('POST', '/api/admin/games/install', {}).then(function () { toast('Emulatoren werden geladen'); loadCores(); }, errToast);
    else if (a === 'import-scan') scanImport();
    else if (a === 'edit-close') { $('#ad-edit').innerHTML = ''; }
    else if (a === 'backup-create') api('POST', '/api/admin/backups', {}).then(function (r) { toast('Sicherung angelegt: ' + r.name); loadAdmin(); }, errToast);
  });

  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.dataset && t.dataset.filter) { state.filters[t.dataset.filter] = t.value; renderResults(); return; }
    if (t.id === 'f-playable') { state.filters.playableOnly = t.checked; renderResults(); return; }
    if (t.dataset && t.dataset.kidRating) { api('PATCH', '/api/children/' + t.dataset.kidRating, { maxRating: Number(t.value) }).then(function () { toast('Freigabe gespeichert: Spiele ab ' + t.value); }, errToast); return; }
    if (t.id === 'restore-full-file' && t.files && t.files[0]) {
      var rf = t.files[0]; t.value = '';
      if (!window.confirm('Alle Daten, Spielstände, hochgeladenen Spiele und BIOS durch die Sicherung „' + rf.name + '“ ersetzen? Vorher wird automatisch eine Sicherung der Daten angelegt.')) return;
      var rm = $('#restore-msg'); rm.textContent = 'Lade Sicherung hoch …';
      xhrUpload('/api/admin/restore/full', rf, $('#restore-progress'), rm).then(function (r) { rm.textContent = 'Wiederhergestellt: ' + r.games + ' Spiele, ' + r.files + ' Dateien. Bitte neu anmelden …'; setTimeout(function () { location.reload(); }, 2500); }, function (e) { rm.textContent = 'Fehler: ' + e.message; });
      return;
    }

    if (t.name === 'theme') { state.theme = t.value; local.set('theme', state.theme); applyTheme(); toast('Farbschema gespeichert'); return; }
    if (t.id === 'st-motion') { state.reduceMotion = t.checked; local.set('reduceMotion', t.checked); applyTheme(); toast(t.checked ? 'Bewegungen reduziert' : 'Bewegungen normal'); return; }
    if (t.name === 'registration') { api('PUT', '/api/admin/settings', { registration: t.value }).then(function () { toast(t.value === 'open' ? 'Registrierung geöffnet' : 'Registrierung geschlossen'); loadAudit(); }, errToast); return; }
    if (t.id === 'restore-file' && t.files && t.files[0]) {
      if (!window.confirm('Alle aktuellen Server-Daten durch diese Sicherung ersetzen? Vorher wird automatisch eine Sicherung angelegt. Alle werden abgemeldet.')) { t.value = ''; return; }
      var reader = new FileReader();
      reader.onload = function () {
        var obj; try { obj = JSON.parse(reader.result); } catch (err) { toast('Datei ist kein gültiges JSON'); return; }
        api('POST', '/api/admin/restore', obj).then(function (r) { toast('Wiederhergestellt (' + r.users + ' Konten). Bitte neu anmelden.'); loggedOut(); }, errToast);
      };
      reader.readAsText(t.files[0]);
    }
  });

  document.addEventListener('submit', function (e) {
    var f = e.target; e.preventDefault();
    if (f.id === 'auth-form') { submitAuth(); return; }
    if (f.id === 'search-form') { if (currentView !== 'spiele') go('spiele'); return; }
    if (f.id === 'lib-upload-form') { uploadGame(f); return; }
    if (f.id === 'lib-url-form') { urlImport(f); return; }
    if (f.id === 'import-form') { runImport(); return; }
    if (f.id === 'game-edit-form') {
      var eg = Number(f.dataset.gid), em = $('#ed-msg'); em.textContent = '';
      api('PATCH', '/api/admin/library/' + eg, { title: $('#ed-t').value.trim(), rating: $('#ed-r').value === '' ? null : Number($('#ed-r').value), year: $('#ed-y').value.trim() || null, genre: $('#ed-g').value.trim(), players: Number($('#ed-p').value), desc: $('#ed-d').value.trim() })
        .then(function () { toast('Gespeichert'); refreshCatalog().then(function () { renderAdminGames(); renderEdit(eg); }); }, function (e) { em.textContent = e.message; });
      return;
    }
    if (f.id === 'cover-form') {
      var cg = Number(f.dataset.gid), cf = $('#ed-c').files[0]; if (!cf) { toast('Bitte ein Bild auswählen'); return; }
      xhrUpload('/api/admin/library/' + cg + '/cover', cf).then(function () { toast('Cover gespeichert'); refreshCatalog().then(function () { renderAdminGames(); renderEdit(cg); }); }, errToast); return;
    }
    if (f.id === 'merge-form') {
      var mg = Number(f.dataset.gid), from = Number($('#ed-m').value), fromT = GAME['g' + from] ? GAME['g' + from].title : '';
      if (!window.confirm('„' + fromT + '“ als weitere Disc übernehmen? Der Eintrag „' + fromT + '“ verschwindet, seine Dateien gehören danach zu diesem Spiel.')) return;
      api('POST', '/api/admin/library/' + mg + '/merge', { from: from }).then(function (r) { toast('Zusammengeführt' + (r.game.discs ? ' – ' + r.game.discs + ' Discs' : '')); refreshCatalog().then(function () { renderAdminGames(); renderEdit(mg); }); }, errToast);
      return;
    }

    if (f.dataset && f.dataset.bios) {
      var bf = f.querySelector('input[type=file]').files[0]; if (!bf) { toast('Bitte eine BIOS-Datei auswählen'); return; }
      if (!f.querySelector('input[type=checkbox]').checked) { toast('Bitte bestätigen, dass es eine eigene Sicherung ist'); return; }
      xhrUpload('/api/admin/bios/' + f.dataset.bios + '?rights=1&filename=' + encodeURIComponent(bf.name), bf).then(function () { toast('BIOS hochgeladen'); refreshCatalog().then(renderBios); }, errToast); return;
    }
    if (f.id === 'room-open-form') { openPlayer($('#np-game').value); return; }
    if (f.id === 'couch-form') { RT.send({ t: 'couch.create', gameId: Number($('#couch-game').value) }); state.awaitCouch = true; return; }
    if (f.id === 'ctrl-form') { var cc = $('#ctrl-code').value.trim(); if (!/^[A-Za-z2-9]{4}$/.test(cc)) { $('#ctrl-log').textContent = 'Der Code hat 4 Zeichen, z. B. A7K2.'; return; } RT.send({ t: 'couch.join', code: cc }); return; }
    if (f.id === 'friend-form') { var n = $('#fr-name').value.trim(); api('POST', '/api/friends/request', { name: n }).then(function (r) { toast(r.status === 'accepted' ? 'Ihr seid jetzt befreundet' : 'Anfrage an ' + n + ' gesendet'); loadFriends(); }, errToast); return; }
    if (f.id === 'chat-form') {
      var inp = $('#chat-input'), txt = inp.value.trim(); if (!txt) return; inp.value = '';
      api('POST', '/api/chat/' + encodeURIComponent(state.channel), { text: txt }).then(function () { $('#chat-input').focus(); }, function (err) { inp.value = txt; errToast(err); }); return;
    }
    if (f.id === 'profile-form') {
      var col = f.querySelector('input[name=color]:checked');
      api('PATCH', '/api/me', { display: $('#pf-name').value.trim(), color: col ? col.value : undefined }).then(function (r) { state.me = r.user; applyProfile(); RENDER.profil(); toast('Profil gespeichert'); }, errToast); return;
    }
    if (f.id === 'pw-form') { api('PATCH', '/api/me', { currentPassword: $('#pw-old').value, newPassword: $('#pw-new').value }).then(function () { f.reset(); toast('Passwort geändert'); }, errToast); return; }
    if (f.id === 'kid-form') { api('POST', '/api/children', { name: $('#kid-name').value.trim(), display: $('#kid-display').value.trim(), password: $('#kid-pw').value }).then(function () { f.reset(); toast('Kinderprofil angelegt'); loadKids(); }, errToast); return; }
    if (f.id === 'admin-user-form') { api('POST', '/api/admin/users', { name: $('#au-new-name').value.trim(), display: $('#au-new-display').value.trim(), password: $('#au-new-pw').value, role: $('#au-new-role').value }).then(function (r) { f.reset(); toast('Konto ' + r.user.name + ' angelegt'); loadAdminUsers(); loadAudit(); }, errToast); return; }
    if (f.id === 't-form') {
      var players = [1, 2, 3, 4, 5, 6, 7, 8].map(function (i) { return $('#t-p' + i).value.trim(); });
      api('POST', '/api/tournaments', { name: $('#t-title').value.trim(), game: $('#t-game').value, players: players }).then(function (r) { state.tournamentId = r.tournament.id; toast('Turnier angelegt'); loadTournaments(); }, errToast);
    }
  });

  $('#search').addEventListener('input', function (e) { state.filters.q = e.target.value; if (currentView !== 'spiele') { suppressFocus = true; location.hash = 'spiele'; } else renderResults(); });
  document.addEventListener('keydown', function (e) {
    var typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (e.key === '/' && !typing && !$('#player').open && !$('#detail').open && state.me) { e.preventDefault(); $('#search').focus(); }
  });

  function applyProfile() {
    var child = state.me && state.me.role === 'child', admin = state.me && state.me.role === 'admin';
    $$('[data-adult]').forEach(function (a) { a.hidden = !!child; });
    $$('[data-admin]').forEach(function (a) { a.hidden = !admin; });
    setConn(state.online);
  }

  /* ---------- Start ---------- */
  applyTheme();
  api('GET', '/api/session').then(function (s) {
    state.setupRequired = s.setupRequired; state.registration = s.registration;
    if (s.user) loggedIn(s.user); else { applyProfile(); route(false); }
  }, function () {
    $('#main').innerHTML = '<div class="auth-box panel stack"><h1>Server nicht erreichbar</h1><p>Der RetroHub-Server antwortet nicht. Prüfe im Container: <b>systemctl status retrohub</b></p><button class="btn" type="button" data-action="reload">Erneut versuchen</button></div>';
    document.body.classList.add('auth');
  });
  document.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('[data-action="reload"]')) location.reload(); });
}());
