'use strict';
/* Integrationstest für den RetroHub-Server: startet eine eigene Instanz mit leerem Datenverzeichnis.
   Aufruf: node tests/api-test.js   (Exitcode 0 = alles bestanden) */
const http = require('http'); const net = require('net'); const crypto = require('crypto'); const fs = require('fs'); const os = require('os'); const path = require('path'); const { spawn } = require('child_process');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-test-')); const PORT = 33000 + Math.floor(Math.random() * 2000);
const results = []; let failed = 0;
const check = (name, cond, info) => { results.push([cond ? 'PASS' : 'FAIL', name, info || '']); if (!cond) failed++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (info ? ' — ' + info : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, p, body, cookie, extra) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = Object.assign({ Host: 'retrohub.test', 'Content-Type': 'application/json' }, method !== 'GET' ? { 'X-RetroHub': '1' } : {}, cookie ? { Cookie: cookie } : {}, extra || {});
    if (data) h['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) { /* kein JSON */ } const sc = res.headers['set-cookie']; resolve({ status: res.statusCode, body: j, cookie: sc ? sc[0].split(';')[0] : null, headers: res.headers }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
function raw(method, p2, buf, cookie, headers) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({ Host: 'retrohub.test', 'X-RetroHub': '1', 'Content-Type': 'application/octet-stream', 'Content-Length': buf ? buf.length : 0 }, cookie ? { Cookie: cookie } : {}, headers || {});
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p2, headers: h }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => { const b = Buffer.concat(c); let j = null; try { j = JSON.parse(b.toString()); } catch (e) { /* binär */ } resolve({ status: res.statusCode, body: j, buf: b, headers: res.headers }); }); });
    r.on('error', reject); if (buf) r.write(buf); r.end();
  });
}
function wsConnect(cookie, origin) {
  return new Promise((resolve, reject) => {
    const s = net.connect(PORT, '127.0.0.1'); const key = crypto.randomBytes(16).toString('base64');
    s.write('GET /ws HTTP/1.1\r\nHost: retrohub.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ' + key + '\r\n' + (origin ? 'Origin: ' + origin + '\r\n' : '') + (cookie ? 'Cookie: ' + cookie + '\r\n' : '') + '\r\n');
    let buf = Buffer.alloc(0), upgraded = false; const msgs = []; const waiters = [];
    const api = {
      msgs, status: null,
      send(o) { const p = Buffer.from(JSON.stringify(o)); const m = crypto.randomBytes(4); const head = p.length < 126 ? Buffer.from([0x81, 0x80 | p.length]) : Buffer.from([0x81, 0x80 | 126, p.length >> 8, p.length & 255]); const x = Buffer.from(p); for (let i = 0; i < x.length; i++) x[i] ^= m[i & 3]; s.write(Buffer.concat([head, m, x])); },
      wait(pred, ms = 4000) { return new Promise((res, rej) => { const f = msgs.find(pred); if (f) return res(f); const w = { pred, res }; waiters.push(w); setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); rej(new Error('Zeitüberschreitung')); } }, ms); }); },
      clear() { msgs.length = 0; }, close() { s.destroy(); }
    };
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) { const i = buf.indexOf('\r\n\r\n'); if (i < 0) return; const head = buf.slice(0, i).toString(); api.status = +head.split(' ')[1]; buf = buf.slice(i + 4); if (api.status !== 101) { s.destroy(); return resolve(api); } upgraded = true; resolve(api); }
      while (buf.length >= 2) {
        let len = buf[1] & 127, off = 2; if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + len) return;
        const op = buf[0] & 15, payload = buf.slice(off, off + len); buf = buf.slice(off + len);
        if (op === 1) { const m = JSON.parse(payload.toString()); msgs.push(m); for (const w of waiters.slice()) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); } }
      }
    });
    s.on('error', reject);
  });
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], { env: Object.assign({}, process.env, { RETROHUB_DATA: DATA, RETROHUB_PORT: String(PORT), RETROHUB_LEAVE_GRACE: '300', RETROHUB_IMPORT: path.join(DATA, 'import') }), stdio: ['ignore', 'pipe', 'pipe'] });
  let srvLog = ''; srv.stdout.on('data', (d) => { srvLog += d; }); srv.stderr.on('data', (d) => { srvLog += d; });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await req('GET', '/api/health')).status === 200) break; } catch (e) { /* noch nicht da */ } await sleep(100); }
    const code = fs.readFileSync(path.join(DATA, 'data', 'setup-code'), 'utf8').trim();
    check('Einrichtungscode beim ersten Start erzeugt', /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code), code.replace(/./g, '•'));
    let r = await req('GET', '/api/session'); check('Session meldet Ersteinrichtung', r.body.setupRequired === true && r.body.user === null);
    r = await req('POST', '/api/register', { name: 'admin', password: 'sehrgeheim1', setupCode: 'XXXX-XXXX' }); check('Erstregistrierung ohne gültigen Code abgelehnt', r.status === 403, r.body.error);
    r = await req('POST', '/api/register', { name: 'admin', password: 'sehrgeheim1', display: 'Sebastian', setupCode: code }); const A = r.cookie;
    check('Erstes Konto wird Admin, Sitzungscookie HttpOnly', r.status === 200 && r.body.user.role === 'admin' && /HttpOnly/.test(r.headers['set-cookie'][0]), r.headers['set-cookie'][0].split(';').slice(1).join(';'));
    check('Einrichtungscode nach Nutzung gelöscht', !fs.existsSync(path.join(DATA, 'data', 'setup-code')));
    r = await req('POST', '/api/register', { name: 'mallory', password: 'sehrgeheim1' }); check('Registrierung standardmäßig geschlossen', r.status === 403, r.body.error);
    r = await req('PUT', '/api/admin/settings', { registration: 'open' }, A); check('Admin öffnet Registrierung', r.body.registration === 'open');
    r = await req('POST', '/api/register', { name: 'jonas', password: 'passwort12', display: 'Jonas' }); const J = r.cookie; check('Registrierung zweites Konto', r.status === 200 && r.body.user.role === 'user');
    r = await req('POST', '/api/register', { name: 'jonas', password: 'passwort12' }); check('Doppelter Benutzername abgelehnt', r.status === 409);
    r = await req('POST', '/api/register', { name: 'x', password: 'kurz' }); check('Ungültiger Name/Passwort abgelehnt', r.status === 400, r.body.error);
    r = await req('POST', '/api/login', { name: 'jonas', password: 'falsch' }); check('Falsches Passwort abgelehnt', r.status === 401);
    r = await req('POST', '/api/login', { name: 'JONAS', password: 'passwort12' }); check('Anmeldung (Name ohne Groß/Klein)', r.status === 200 && !!r.cookie);
    r = await req('POST', '/api/me/progress', { game: 'snake', score: 12, seconds: 30, round: true }, A, { 'X-RetroHub': '' }); check('CSRF: Schreibzugriff ohne X-RetroHub abgelehnt', r.status === 403);
    r = await req('POST', '/api/me/progress', { game: 'snake', score: 12, seconds: 30, round: true }, A, { Origin: 'http://evil.example' }); check('CSRF: fremder Origin abgelehnt', r.status === 403);
    r = await req('GET', '/api/admin/users', null, J); check('Rechte: Nutzer kommt nicht in Admin-API', r.status === 403);
    r = await req('GET', '/api/me/data'); check('Ohne Anmeldung 401', r.status === 401);
    // Fortschritt & Favoriten
    await req('POST', '/api/me/progress', { game: 'snake', score: 12, seconds: 30, round: true }, A);
    r = await req('POST', '/api/me/progress', { game: 'snake', score: 7, seconds: 20, round: true }, A);
    check('Spielstand serverseitig (Rekord bleibt Maximum)', r.body.progress.best.snake === 12 && r.body.progress.plays.snake === 2 && r.body.progress.time.snake === 50);
    r = await req('PUT', '/api/me/favorites', { favorites: ['snake', '2048', 'snake'] }, A); check('Favoriten gespeichert, Duplikate entfernt', JSON.stringify(r.body.favorites) === '["snake","2048"]');
    // Kinderprofil
    r = await req('POST', '/api/children', { name: 'mia', password: '1234', display: 'Mia' }, A); check('Kinderprofil anlegen', r.status === 200 && r.body.child.role === 'child');
    r = await req('POST', '/api/login', { name: 'mia', password: '1234' }); const M = r.cookie;
    r = await req('GET', '/api/chat/allgemein', null, M); check('Kinderprofil: Chat gesperrt', r.status === 403);
    r = await req('POST', '/api/friends/request', { name: 'jonas' }, M); check('Kinderprofil: Freundschaften gesperrt', r.status === 403);
    // Freunde
    r = await req('POST', '/api/friends/request', { name: 'jonas' }, A); check('Freundschaftsanfrage', r.body.status === 'pending');
    r = await req('POST', '/api/friends/request', { name: 'mia' }, A); check('Kinder nicht als Freunde anfragbar', r.status === 404);
    r = await req('GET', '/api/notifications', null, J); check('Benachrichtigung über Anfrage', r.body.notifications[0] && r.body.notifications[0].type === 'friend-request');
    r = await req('GET', '/api/friends', null, J); const aid = r.body.incoming[0].id;
    r = await req('POST', '/api/friends/' + aid + '/accept', {}, J); r = await req('GET', '/api/friends', null, A); check('Anfrage angenommen', r.body.friends.length === 1 && r.body.friends[0].name === 'jonas');
    const jid = r.body.friends[0].id;
    // Echtzeit
    const wa = await wsConnect(A), wj = await wsConnect(J);
    check('WebSocket: Upgrade mit Sitzung', wa.status === 101 && wj.status === 101);
    const wn = await wsConnect(null); check('WebSocket: ohne Sitzung 401', wn.status === 401);
    const wo = await wsConnect(A, 'http://evil.example'); check('WebSocket: fremder Origin 403', wo.status === 403);
    await wa.wait((m) => m.t === 'hello'); await wj.wait((m) => m.t === 'hello');
    r = await req('POST', '/api/chat/allgemein', { text: '<b>Hallo</b> zusammen' }, A);
    const cm = await wj.wait((m) => m.t === 'chat' && m.channel === 'allgemein'); check('Chat in Echtzeit an andere Nutzer', cm.message.text === '<b>Hallo</b> zusammen' && cm.message.display === 'Sebastian');
    r = await req('POST', '/api/chat/dm:' + jid, { text: 'Lust auf eine Runde?' }, A);
    const dm = await wj.wait((m) => m.t === 'chat' && m.dm); check('Direktnachricht in Echtzeit', dm.channel === 'dm:' + aid && dm.message.text === 'Lust auf eine Runde?');
    const dn = await wj.wait((m) => m.t === 'notify' && m.n.type === 'dm'); check('Benachrichtigung bei Direktnachricht', !!dn);
    r = await req('POST', '/api/chat/dm:' + jid, { text: 'x' }, M); check('Direktnachricht nur unter Freunden', r.status === 403);
    // ---------- Spielebibliothek (9.0) ----------
    r = await req('GET', '/api/systems', null, J); check('35 Systeme gelistet, ohne Kerne nicht spielbereit', r.body.systems.length === 35 && r.body.systems.every((s) => !s.ready), r.body.systems.length + ' Systeme');
    check('BIOS-Pflicht korrekt markiert (Mega-CD, Lynx, PC-FX, ColecoVision, 3DO)', r.body.systems.filter((s) => s.bios === 'required').map((s) => s.key).sort().join() === '3do,coleco,lynx,pcfx,segaCD');
    r = await req('GET', '/api/library', null, J); check('Bibliothek startet leer (keine vorinstallierten Spiele)', r.body.games.length === 0);
    const up = (q, buf, ck) => raw('POST', '/api/admin/library/upload?' + new URLSearchParams(Object.assign({ rights: '1' }, q)), buf, ck || A);
    const nes = Buffer.concat([Buffer.from('NES\x1a', 'binary'), crypto.randomBytes(40976)]);
    r = await up({ system: 'nes', filename: 'Mein Spiel.nes', title: 'Mein NES-Spiel' }, nes); const gid = r.body.game && r.body.game.id;
    check('Upload NES als Spiel (Admin, Rechte bestätigt)', r.status === 200 && Number.isInteger(gid) && r.body.game.system === 'nes', r.status);
    r = await up({ system: 'nes', filename: 'x.nes' }, crypto.randomBytes(2000)); check('NES ohne gültigen Dateikopf abgelehnt', r.status === 400, r.body.error);
    r = await up({ system: 'snes', filename: 'x.nes' }, nes); check('Dateiendung muss zum System passen', r.status === 400, r.body.error);
    r = await up({ system: 'nes', filename: 'x.nes', rights: '0' }, nes); check('Upload ohne Rechtebestätigung abgelehnt', r.status === 400);
    r = await up({ system: 'nes', filename: 'x.nes' }, nes, J); check('Upload nur für Admins', r.status === 403);
    r = await up({ system: 'nes', filename: 'kopie.nes' }, nes); check('Doppelte Datei erkannt (SHA-256)', r.status === 409, r.body.error);
    r = await up({ system: 'gb', filename: 'gross.gb' }, Buffer.concat([Buffer.alloc(0x104), Buffer.from('ceed6666', 'hex'), crypto.randomBytes(9 << 20)])); check('Größenlimit je System (Game Boy 8 MB)', r.status === 413, r.body && r.body.error);
    r = await up({ system: 'gamecube', filename: 'x.iso' }, nes); check('Nicht unterstütztes System (GameCube) abgelehnt', r.status === 400);
    const zipGame = crypto.randomBytes(5000); r = await up({ system: 'snes', filename: 'archiv.zip', title: 'Gepackt' }, zipGame); check('ZIP-Archiv für jedes System erlaubt', r.status === 200);
    const cue = Buffer.from('FILE "spiel.bin" BINARY\r\n  TRACK 01 MODE2/2352\r\n    INDEX 01 00:00:00\r\n'), bin = crypto.randomBytes(300000);
    r = await up({ system: 'psx', filename: 'spiel.cue', title: 'Disc-Spiel' }, cue); const pid = r.body.game.id;
    r = await up({ system: 'psx', filename: 'spiel.bin', game: String(pid) }, bin); check('Weitere Datei an Spiel anhängen', r.status === 200 && r.body.game.files.length === 2);
    r = await up({ system: 'snes', filename: 'falsch.smc', game: String(pid) }, crypto.randomBytes(1000)); check('Anhängen nur an Spiel desselben Systems', r.status === 400);
    const z = await raw('GET', '/api/library/' + pid + '/data', null, J);
    const parseZip = (b) => { const eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); const n = b.readUInt16LE(eocd + 10); let off = b.readUInt32LE(eocd + 16); const out = {}; for (let i = 0; i < n; i++) { const csize = b.readUInt32LE(off + 20), nl = b.readUInt16LE(off + 28), el = b.readUInt16LE(off + 30), cl = b.readUInt16LE(off + 32), lo = b.readUInt32LE(off + 42); const name = b.slice(off + 46, off + 46 + nl).toString(); const lnl = b.readUInt16LE(lo + 26), lel = b.readUInt16LE(lo + 28); out[name] = b.slice(lo + 30 + lnl + lel, lo + 30 + lnl + lel + csize); off += 46 + nl + el + cl; } return out; };
    let zf = {}; try { zf = parseZip(z.buf); } catch (e) { zf = {}; }
    check('Mehrteiliges Spiel wird als ZIP geliefert, Inhalt bitgenau', z.status === 200 && zf['spiel.cue'] && zf['spiel.cue'].equals(cue) && zf['spiel.bin'] && zf['spiel.bin'].equals(bin), Object.keys(zf).join(', '));
    let zipOk = false; try { const tmpz = path.join(DATA, 'test.zip'); fs.writeFileSync(tmpz, z.buf); require('child_process').execFileSync('unzip', ['-tq', tmpz]); zipOk = true; } catch (e) { zipOk = false; }
    check('ZIP ist standardkonform (unzip -t, CRC geprüft)', zipOk);
    const one = await raw('GET', '/api/library/' + gid + '/data', null, J); check('Einzeldatei bitgenau geliefert', one.status === 200 && one.buf.equals(nes));
    r = await raw('GET', '/api/library/' + gid + '/data'); check('Spieldaten nur mit Anmeldung', r.status === 401);
    const ip = Object.values(os.networkInterfaces()).flat().find((x) => x.family === 'IPv4' && !x.internal);
    if (ip) {
      const gbRom = Buffer.concat([Buffer.alloc(0x104), Buffer.from('ceed6666', 'hex'), crypto.randomBytes(32768)]);
      const fsrv = http.createServer((q, s) => { if (q.url === '/redir') { s.writeHead(302, { Location: '/spiel.gbc' }); return s.end(); } if (q.url === '/spiel.gbc') { s.writeHead(200, { 'Content-Length': gbRom.length }); return s.end(gbRom); } s.writeHead(404); s.end(); });
      await new Promise((ok) => fsrv.listen(0, '0.0.0.0', ok)); const fport = fsrv.address().port;
      r = await req('POST', '/api/admin/library/url', { url: 'http://' + ip.address + ':' + fport + '/redir', system: 'gb', title: 'Von URL', rights: true }, A); const jid2 = r.body.job.id;
      let jb = null; for (let i = 0; i < 50; i++) { jb = (await req('GET', '/api/admin/jobs/' + jid2, null, A)).body.job; if (jb.state !== 'läuft') break; await sleep(100); }
      check('URL-Import (mit Weiterleitung) legt Spiel an', jb.state === 'fertig' && jb.game && jb.game.files[0].name === 'spiel.gbc' && jb.received === gbRom.length, jb.state + ' ' + (jb.error || ''));
      r = await req('POST', '/api/admin/library/url', { url: 'http://' + ip.address + ':' + fport + '/fehlt.gbc', system: 'gb', rights: true }, A); for (let i = 0; i < 30; i++) { jb = (await req('GET', '/api/admin/jobs/' + r.body.job.id, null, A)).body.job; if (jb.state !== 'läuft') break; await sleep(100); }
      check('URL-Import: HTTP-Fehler wird gemeldet', jb.state === 'fehler' && /404/.test(jb.error), jb.error);
      fsrv.close();
    } else check('URL-Import (keine Netzwerkadresse in Testumgebung)', true, 'übersprungen');
    for (const [u2, why] of [['http://127.0.0.1:' + PORT + '/api/health', 'Loopback'], ['ftp://example.org/x.gb', 'Protokoll'], ['file:///etc/passwd', 'Datei']]) {
      r = await req('POST', '/api/admin/library/url', { url: u2, system: 'gb', rights: true }, A); let jb2 = null; for (let i = 0; i < 30; i++) { jb2 = (await req('GET', '/api/admin/jobs/' + r.body.job.id, null, A)).body.job; if (jb2.state !== 'läuft') break; await sleep(50); }
      check('URL-Import blockiert (' + why + ')', jb2.state === 'fehler', jb2.error);
    }
    r = await req('POST', '/api/admin/library/url', { url: 'http://example.org/x.gb', system: 'gb' }, A); check('URL-Import ohne Rechtebestätigung abgelehnt', r.status === 400);
    const IMP = path.join(DATA, 'import'); fs.mkdirSync(path.join(IMP, 'PSX', 'Disc A'), { recursive: true });
    fs.writeFileSync(path.join(IMP, 'snes-spiel.sfc'), crypto.randomBytes(4096)); fs.writeFileSync(path.join(IMP, 'liesmich.txt'), 'x');
    fs.writeFileSync(path.join(IMP, 'PSX', 'Disc A', 'disc.cue'), 'FILE "disc (Track 1).bin" BINARY\n  TRACK 01 MODE2/2352\n'); fs.writeFileSync(path.join(IMP, 'PSX', 'Disc A', 'disc (Track 1).bin'), crypto.randomBytes(200000));
    r = await req('GET', '/api/admin/import/scan', null, A); const sc = r.body;
    check('Ordner-Scan findet passende Dateien, ignoriert andere', sc.available && sc.files.length === 3 && !sc.files.some((f) => f.name === 'liesmich.txt'), sc.files.map((f) => f.path).join('; '));
    r = await req('POST', '/api/admin/import', { rights: true, items: [{ path: 'snes-spiel.sfc', system: 'snes' }, { path: 'PSX/Disc A/disc.cue', system: 'psx', title: 'Disc A' }, { path: '../data/db.json', system: 'snes' }, { path: 'liesmich.txt', system: 'snes' }] }, A);
    check('Ordner-Import: 2 Spiele, CUE mit zugehöriger BIN gebündelt', r.body.imported.length === 2 && r.body.imported.find((g) => g.title === 'Disc A').files.length === 2);
    check('Ordner-Import: Pfad außerhalb und falsche Endung abgelehnt', r.body.errors.length === 2, r.body.errors.map((e) => e.error).join(' | '));
    const discId = r.body.imported.find((g) => g.title === 'Disc A').id;
    r = await req('GET', '/api/admin/import/scan', null, A); check('Scan markiert importierte Dateien (inkl. BIN zur CUE)', r.body.files.filter((f) => f.imported).length === 3);
    r = await req('DELETE', '/api/admin/library/' + discId, null, A); check('Löschen eines Ordner-Spiels lässt Quelldateien unangetastet', r.status === 200 && fs.existsSync(path.join(IMP, 'PSX', 'Disc A', 'disc.cue')));
    const lynxBios = crypto.randomBytes(512);
    r = await raw('POST', '/api/admin/bios/lynx?filename=lynxboot.img', lynxBios, A); check('BIOS ohne Rechtebestätigung abgelehnt', r.status === 400);
    r = await raw('POST', '/api/admin/bios/lynx?filename=lynxboot.img&rights=1', lynxBios, J); check('BIOS-Upload nur für Admins', r.status === 403);
    r = await raw('POST', '/api/admin/bios/lynx?filename=lynxboot.img&rights=1', lynxBios, A); check('BIOS hochgeladen', r.status === 200 && r.body.bios.filename === 'lynxboot.img');
    const bz = await raw('GET', '/api/bios/lynx', null, J); let bf = {}; try { bf = parseZip(bz.buf); } catch (e) { bf = {}; }
    check('BIOS wird als ZIP mit Originalnamen geliefert', bf['lynxboot.img'] && bf['lynxboot.img'].equals(lynxBios));
    r = await req('GET', '/api/systems', null, J); check('System zeigt BIOS als vorhanden', r.body.systems.find((s) => s.key === 'lynx').biosInstalled === true);
    r = await req('PATCH', '/api/admin/library/' + gid, { title: 'Umbenannt', players: 2 }, A); check('Spiel bearbeiten', r.body.game.title === 'Umbenannt' && r.body.game.players === 2);
    const zg = (await req('GET', '/api/library', null, A)).body.games.find((g) => g.title === 'Gepackt');
    const libFiles = () => fs.readdirSync(path.join(DATA, 'library')).filter((f) => !f.startsWith('.')).length; const before = libFiles();
    r = await req('DELETE', '/api/admin/library/' + zg.id, null, A); check('Löschen entfernt hochgeladene Datei', r.status === 200 && libFiles() === before - 1);
    const romId = gid; const saveSt = { cpu: { a: 1 }, mem: Array.from({ length: 512 }, (_, i) => i % 7) };
    r = await req('PUT', '/api/saves/g' + gid + '/1', { state: saveSt, label: 'Test' }, J); check('Spielstand speichern', r.status === 200);
    const stbin = crypto.randomBytes(1 << 20);
    r = await raw('PUT', '/api/saves/g' + gid + '/2/bin?label=T', stbin, J); check('Binärer Spielstand speichern', r.status === 200 && r.body.raw === stbin.length);
    r = await raw('GET', '/api/saves/g' + gid + '/2/bin', null, J); check('Binärer Spielstand bitgenau geladen', r.status === 200 && r.buf.equals(stbin));
    r = await raw('GET', '/api/saves/g' + gid + '/2/bin', null, A); check('Fremde Spielstände nicht lesbar', r.status === 404);
    r = await req('PUT', '/api/saves/g' + gid + '/2/thumb', { thumb: 'data:image/jpeg;base64,/9j/4AAQ' }, J); check('Vorschaubild zum binären Stand', r.status === 200);
    r = await req('PUT', '/api/saves/g' + gid + '/auto', { state: { x: 1 } }, M); check('Kinderprofil speichert Spielstand', r.status === 200);
    const tv = await wsConnect(A); await tv.wait((m) => m.t === 'hello'); tv.send({ t: 'couch.create', gameId: gid });
    const cv = (await tv.wait((m) => m.t === 'couch' && m.couch)).couch; check('Couch-Session für ein Spiel', cv.gameId === gid && /^[A-Z2-9]{4}$/.test(cv.code), cv.code);
    const wm = await wsConnect(M); await wm.wait((m) => m.t === 'hello');
    wj.send({ t: 'couch.join', code: cv.code.toLowerCase() }); wm.send({ t: 'couch.join', code: cv.code });
    const cv2 = (await tv.wait((m) => m.t === 'couch' && m.couch && m.couch.players.length === 2)).couch;
    check('Zwei Handys als Controller 1 und 2', cv2.players.map((p) => p.slot).sort().join() === '0,1');
    tv.clear(); wj.send({ t: 'pad', button: 8, value: 1 }); const pd = await tv.wait((m) => m.t === 'pad');
    const jslot = cv2.players.find((p) => p.id === jid).slot; check('Tastendruck vom Handy erreicht den Fernseher', pd.slot === jslot && pd.button === 8 && pd.value === 1, JSON.stringify(pd));
    tv.clear(); wj.send({ t: 'pad', button: 99, value: 1 }); wj.send({ t: 'pad', button: 4, value: 'x' }); await sleep(200); check('Ungültige Tasten werden verworfen', !tv.msgs.some((m) => m.t === 'pad'));
    wa.send({ t: 'couch.join', code: 'ZZZZ' }); const ce = await wa.wait((m) => m.t === 'error'); check('Unbekannter Couch-Code gemeldet', /ZZZZ/.test(ce.message));
    wm.send({ t: 'couch.leave' }); await tv.wait((m) => m.t === 'couch' && m.couch && m.couch.players.length === 1); check('Controller verlässt Session', true);
    tv.send({ t: 'couch.close' }); await wj.wait((m) => m.t === 'couch' && m.couch === null); check('Session beenden trennt Controller', true); tv.close(); wm.close();
    let ioc = null; try { ioc = require(process.env.SIO_CLIENT || 'socket.io-client').io; } catch (e) { ioc = null; }
    if (ioc) {
      const conn = (ck) => ioc('http://127.0.0.1:' + PORT + '/netplay', { transports: ['polling', 'websocket'], extraHeaders: Object.assign({ Host: 'retrohub.test' }, ck ? { Cookie: ck } : {}), reconnection: false, forceNew: true });
      const once = (s, ev) => new Promise((res) => s.once(ev, res));
      const anon = conn(null); const err = await Promise.race([once(anon, 'connect_error'), sleep(3000).then(() => null)]); check('Netplay ohne Anmeldung abgewiesen', err && /anmelden/.test(err.message)); anon.close();
      const h = conn(A), g2 = conn(J); await Promise.all([once(h, 'connect'), once(g2, 'connect')]);
      const ex = { domain: 'retrohub.test', game_id: gid, room_name: 'Abendrunde', player_name: 'x', userid: 'u-host', sessionid: 'sess-1' };
      const oe = await new Promise((res) => h.emit('open-room', { extra: ex, maxPlayers: 2, password: '' }, res)); check('Netplay-Raum öffnen', oe === null || oe === undefined, String(oe));
      const lst = await raw('GET', '/netplay/list?domain=retrohub.test&game_id=' + gid, null, J); check('Raumliste im EmulatorJS-Format', lst.body && lst.body['sess-1'] && lst.body['sess-1'].room_name === 'Abendrunde' && lst.body['sess-1'].current === 1 && lst.body['sess-1'].max === 2, JSON.stringify(lst.body));
      const rr = await req('GET', '/api/netplay/rooms', null, J); check('Lobby-Ansicht sieht Netplay-Raum mit Spieltitel', rr.body.rooms[0] && rr.body.rooms[0].gameTitle === 'Umbenannt' && rr.body.rooms[0].host === 'Sebastian');
      const upd = once(h, 'users-updated');
      const jr = await new Promise((res) => g2.emit('join-room', { extra: Object.assign({}, ex, { userid: 'u-gast' }) }, (e, users) => res([e, users])));
      check('Netplay-Raum beitreten', !jr[0] && Object.keys(jr[1]).length === 2); const uu = await upd; check('Mitspieler-Liste wird verteilt (Anzeigenamen vom Server)', Object.keys(uu).length === 2, Object.values(uu).map((x) => x.player_name).join(','));
      let selfGot = false; h.on('data-message', () => { selfGot = true; }); const dm = once(g2, 'data-message'); h.emit('data-message', { 'sync-control': [{ frame: 5, connected_input: [0, 8, 1] }] });
      const dd = await dm; await sleep(200); check('Eingaben werden an Mitspieler weitergereicht, nicht zurück', dd['sync-control'][0].frame === 5 && !selfGot);
      const gk = conn(M); await once(gk, 'connect'); const kidJoin = await new Promise((res) => gk.emit('join-room', { extra: Object.assign({}, ex, { userid: 'u-kind' }) }, (e) => res(e))); check('Kind kann Raum eines nicht freigegebenen Spiels nicht betreten', /nicht gefunden/.test(String(kidJoin)), String(kidJoin)); gk.close();
      const g3 = conn(J); await once(g3, 'connect'); const full = await new Promise((res) => g3.emit('join-room', { extra: Object.assign({}, ex, { userid: 'u-drei' }) }, (e) => res(e))); check('Voller Raum lehnt ab', /voll/.test(String(full)), String(full)); g3.close();
      const gone = once(g2, 'disconnect'); h.close(); await Promise.race([gone, sleep(3000)]); await sleep(200);
      const lst2 = await raw('GET', '/netplay/list?game_id=' + gid, null, J); check('Raum endet, wenn der Gastgeber geht', Object.keys(lst2.body || {}).length === 0); g2.close();
    } else check('Netplay-Test (socket.io-client nicht installiert)', true, 'übersprungen');
    // ---------- 9.1: Altersfreigabe, Metadaten, Cover, Discs ----------
    r = await req('GET', '/api/library', null, M); check('Kind sieht keine nicht eingestuften Spiele', r.status === 200 && r.body.games.length === 0, r.body.games.length);
    r = await raw('GET', '/api/library/' + gid + '/data', null, M); check('Kind kann nicht eingestuftes Spiel nicht laden', r.status === 403);
    r = await req('PATCH', '/api/admin/library/' + gid, { rating: 6, year: 1999, genre: 'Puzzle', desc: 'Gedächtnisspiel' }, A); check('Freigabe und Metadaten setzen', r.status === 200 && r.body.game.rating === 6 && r.body.game.year === 1999 && r.body.game.genre === 'Puzzle');
    r = await req('PATCH', '/api/admin/library/' + gid, { rating: 7 }, A); check('Ungültige Freigabe abgelehnt', r.status === 400);
    r = await req('PATCH', '/api/admin/library/' + gid, { year: 1900 }, A); check('Ungültiges Jahr abgelehnt', r.status === 400);
    r = await req('PATCH', '/api/admin/library/' + gid, { rating: 6 }, J); check('Freigabe nur durch Admins', r.status === 403);
    r = await req('GET', '/api/library', null, M); check('Kind sieht Spiel ab 6 (Standardgrenze 6)', r.body.games.length === 1 && r.body.games[0].id === gid);
    r = await raw('GET', '/api/library/' + gid + '/data', null, M); check('Kind kann freigegebenes Spiel laden', r.status === 200);
    await req('PATCH', '/api/admin/library/' + pid, { rating: 12 }, A);
    r = await raw('GET', '/api/library/' + pid + '/data', null, M); check('Kind (bis 6) kann Spiel ab 12 nicht laden', r.status === 403);
    r = await req('GET', '/api/children', null, A); const kid = r.body.children.find((x) => x.name === 'mia'); check('Kinderprofil zeigt Freigabegrenze (Standard 6)', kid && kid.maxRating === 6);
    r = await req('PATCH', '/api/children/' + kid.id, { maxRating: 18 }, A); check('Grenze 18 für Kinder nicht erlaubt', r.status === 400);
    r = await req('PATCH', '/api/children/' + kid.id, { maxRating: 12 }, J); check('Fremde Eltern können Grenze nicht ändern', r.status === 404);
    r = await req('PATCH', '/api/children/' + kid.id, { maxRating: 12 }, A); check('Eltern setzen Grenze auf 12', r.status === 200 && r.body.child.maxRating === 12);
    r = await req('GET', '/api/library', null, M); check('Kind sieht jetzt auch Spiel ab 12', r.body.games.length === 2);
    await req('PATCH', '/api/children/' + kid.id, { maxRating: 6 }, A);
    { const tim = (await req('POST', '/api/children', { name: 'tim', password: '1111' }, A)).body.child;
      r = await req('PATCH', '/api/children/' + tim.id, { password: '5678', maxRating: 12 }, A); const tl = await req('POST', '/api/login', { name: 'tim', password: '5678' });
      check('PIN-Änderung und Freigabe in einem Aufruf (keine doppelte Route)', r.status === 200 && r.body.child.maxRating === 12 && tl.status === 200);
      await req('DELETE', '/api/children/' + tim.id, null, A); }
    const wk = await wsConnect(M); await wk.wait((m) => m.t === 'hello'); wk.send({ t: 'couch.create', gameId: pid }); const ke = await wk.wait((m) => m.t === 'error'); check('Kind kann Couch-Session mit nicht freigegebenem Spiel nicht starten', /nicht gefunden/.test(ke.message)); wk.close();
    // Cover
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), crypto.randomBytes(2000)]);
    r = await raw('POST', '/api/admin/library/' + gid + '/cover', png, A); check('Cover (PNG) hochladen', r.status === 200 && typeof r.body.game.cover === 'string');
    r = await raw('GET', '/api/library/' + gid + '/cover', null, M); check('Cover abrufbar (mit richtigem Typ)', r.status === 200 && r.buf.equals(png) && /image\/png/.test(r.headers ? r.headers['content-type'] : 'image/png'));
    r = await raw('POST', '/api/admin/library/' + gid + '/cover', Buffer.from('<svg onload=alert(1)>'), A); check('Kein Bild (z. B. SVG/Text) als Cover abgelehnt', r.status === 400);
    r = await raw('POST', '/api/admin/library/' + gid + '/cover', Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), crypto.randomBytes(2200000)]), A); check('Cover über 2 MB abgelehnt', r.status === 413);
    r = await raw('POST', '/api/admin/library/' + gid + '/cover', png, J); check('Cover nur durch Admins', r.status === 403);
    await raw('POST', '/api/admin/library/' + pid + '/cover', png.slice(0, 1500), A);
    r = await raw('GET', '/api/library/' + pid + '/cover', null, M); check('Kind sieht Cover nicht freigegebener Spiele nicht', r.status === 403);
    // Mehrere Discs: zweites Spiel anlegen und zusammenführen
    const cue2 = Buffer.from('FILE "disc2.bin" BINARY\r\n  TRACK 01 MODE2/2352\r\n'), bin2 = crypto.randomBytes(200000);
    r = await up({ system: 'psx', filename: 'disc2.cue', title: 'Disc 2' }, cue2); const d2 = r.body.game.id; await up({ system: 'psx', filename: 'disc2.bin', game: String(d2) }, bin2);
    r = await req('POST', '/api/admin/library/' + pid + '/merge', { from: gid }, A); check('Zusammenführen nur bei gleichem System', r.status === 400);
    r = await req('POST', '/api/admin/library/' + pid + '/merge', { from: d2 }, A); check('Discs zusammenführen', r.status === 200 && r.body.game.files.length === 4 && r.body.game.discs === 2, r.body.game && r.body.game.discs);
    r = await req('GET', '/api/library', null, A); check('Zusammengeführtes Spiel entfernt', !r.body.games.some((g) => g.id === d2));
    const mz = await raw('GET', '/api/library/' + pid + '/data', null, A); let mf = {}; try { mf = parseZip(mz.buf); } catch (e) { mf = {}; }
    const m3u = Object.keys(mf).find((n) => n.endsWith('.m3u'));
    check('Disc-Liste (.m3u) wird automatisch ins Archiv gelegt', m3u && mf[m3u].toString() === 'disc2.cue\nspiel.cue\n' && mf['disc2.bin'] && mf['spiel.bin'], m3u + ': ' + (m3u ? JSON.stringify(mf[m3u].toString()) : ''));
    // Admin
    r = await req('GET', '/api/admin/system', null, A); check('Admin: Systemstatus', r.body.users === 3 && typeof r.body.memory.rss === 'number');
    r = await req('GET', '/api/admin/backup', null, A); check('Admin: Backup-Download ohne Sitzungen', r.body.kind === 'server-backup' && Object.keys(r.body.data.sessions).length === 0 && Object.keys(r.body.data.users).length === 3);
    check('Backup enthält Spielstände (JSON und binär)', Array.isArray(r.body.saves) && r.body.saves.length === 3 && r.body.saves.some((x) => x.kind === 'bin'), (r.body.saves || []).length + ' Spielstände');
    const backup = r.body;
    r = await req('PATCH', '/api/admin/users/' + jid, { disabled: true }, A); r = await req('GET', '/api/me/data', null, J); check('Sperren beendet Sitzungen sofort', r.status === 401);
    r = await req('PATCH', '/api/admin/users/' + aid, { role: 'user' }, A); check('Letzter Admin kann nicht herabgestuft werden', r.status === 409);
    r = await req('POST', '/api/register', { name: 'nachher', password: 'passwort12' });
    r = await req('POST', '/api/admin/restore', backup, A); check('Restore stellt Stand wieder her, Sicherung davor', r.status === 200 && r.body.users === 3 && /vor-restore/.test(r.body.backupBefore));
    r = await req('GET', '/api/admin/users', null, A); check('Nach Restore: Sitzungen gelöscht (neu anmelden)', r.status === 401);
    r = await req('POST', '/api/login', { name: 'admin', password: 'sehrgeheim1' }); const A2 = r.cookie;
    r = await req('POST', '/api/login', { name: 'jonas', password: 'passwort12' }); r = await req('GET', '/api/saves/g' + romId + '/1', null, r.cookie);
    check('Nach Restore: Spielstände wiederhergestellt', r.status === 200 && JSON.stringify(r.body.state) === JSON.stringify(saveSt));
    r = await req('GET', '/api/admin/users', null, A2); check('Nach Restore: Konten wie im Backup', r.body.users.length === 3 && !r.body.users.some((u) => u.name === 'nachher') && r.body.users.find((u) => u.name === 'jonas').disabled === false);
    r = await req('POST', '/api/admin/restore', { app: 'RetroHub', kind: 'server-backup', data: { users: {}, friendships: [] } }, A2); check('Restore ohne Admin abgelehnt', r.status === 400);
    r = await req('GET', '/api/admin/audit', null, A2); check('Audit-Protokoll', r.body.audit.some((a) => a.action === 'restore'));
    r = await req('GET', '/api/admin/users', null, A2); const mid = r.body.users.find((x) => x.name === 'mia').id;
    r = await req('DELETE', '/api/admin/users/' + mid, null, A2); check('Konto löschen entfernt Spielstände', r.status === 200 && !fs.existsSync(path.join(DATA, 'data', 'saves', mid)));
    // Brute-Force-Schutz
    // ---------- 9.1: Vollständige Sicherung (TAR) und Wiederherstellung ----------
    await req('POST', '/api/children', { name: 'lea', password: '1234', display: 'Lea' }, A2); const M2 = (await req('POST', '/api/login', { name: 'lea', password: '1234' })).cookie;
    r = await raw('GET', '/api/admin/backup/full', null, M2); check('Vollsicherung nur für Admins', r.status === 403, r.status);
    const full = await raw('GET', '/api/admin/backup/full', null, A2); const tarf = path.join(DATA, 'voll.tar'); fs.writeFileSync(tarf, full.buf);
    let tlist = []; try { tlist = require('child_process').execFileSync('tar', ['-tf', tarf]).toString().trim().split('\n'); } catch (e) { tlist = []; }
    const libBefore = (await req('GET', '/api/library', null, A2)).body.games.map((g) => g.id).sort().join();
    check('Vollsicherung ist ein gültiges TAR (mit tar lesbar)', full.status === 200 && tlist.includes('retrohub-backup.json'), tlist.length + ' Einträge');
    check('Vollsicherung enthält Spieldateien, Cover und BIOS (lange Namen per PAX)', tlist.some((n) => /^library\/[0-9a-f]{16}-/.test(n)) && tlist.some((n) => n.startsWith('library/covers/')) && tlist.includes('bios/lynx.bin') && !tlist.some((n) => n.includes('import')), tlist.filter((n) => n.startsWith('library/')).length + ' Spieldateien');
    // Zustand verändern, dann zurückspielen
    const someGame = (await req('GET', '/api/library', null, A2)).body.games[0]; await req('DELETE', '/api/admin/library/' + someGame.id, null, A2); await raw('DELETE', '/api/admin/bios/lynx', null, A2);
    r = await raw('POST', '/api/admin/restore/full', full.buf, A2); check('Vollständige Wiederherstellung', r.status === 200 && r.body.files === tlist.length, JSON.stringify(r.body).slice(0, 120));
    const A3 = (await req('POST', '/api/login', { name: 'admin', password: 'sehrgeheim1' })).cookie;
    r = await req('GET', '/api/library', null, A3); check('Nach Vollrestore: Bibliothek wie vorher', r.body.games.map((g) => g.id).sort().join() === libBefore);
    r = await raw('GET', '/api/library/' + someGame.id + '/data', null, A3); check('Nach Vollrestore: gelöschte Spieldatei wieder da', r.status === 200);
    r = await raw('GET', '/api/bios/lynx', null, A3); check('Nach Vollrestore: BIOS wieder da', r.status === 200);
    // Manipuliertes Archiv mit Pfad außerhalb
    const hdr = (name, size) => { const h = Buffer.alloc(512); h.write(name, 0); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116); h.write(size.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.write('        ', 148); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263); let s2 = 0; for (const x of h) s2 += x; h.write(s2.toString(8).padStart(6, '0') + '\0 ', 148); return h; };
    const evil = Buffer.concat([hdr('../../evil.txt', 4), Buffer.from('boom'), Buffer.alloc(508), Buffer.alloc(1024)]);
    r = await raw('POST', '/api/admin/restore/full', evil, A3); check('Archiv mit Pfad außerhalb abgelehnt', r.status === 400 && /Unerlaubter Pfad/.test(r.body.error) && !fs.existsSync(path.join(DATA, '..', 'evil.txt')), r.body && r.body.error);
    const nojson = Buffer.concat([hdr('library/x.bin', 4), Buffer.from('abcd'), Buffer.alloc(508), Buffer.alloc(1024)]);
    r = await raw('POST', '/api/admin/restore/full', nojson, A3); check('Archiv ohne Datendatei abgelehnt, Bestand unverändert', r.status === 400 && (await req('GET', '/api/library', null, A3)).body.games.length === libBefore.split(',').length);
    r = await raw('POST', '/api/admin/restore/full', Buffer.from('kein tar'), A3); check('Kaputtes Archiv abgelehnt', r.status === 400);
    check('Keine Reste temporärer Wiederherstellungen', !fs.readdirSync(DATA).some((f) => f.startsWith('.restore-')));
    { const kids = (await req('GET', '/api/children', null, A3)).body.children; const lea = kids.find((x) => x.name === 'lea'); if (lea) await req('DELETE', '/api/admin/users/' + lea.id, null, A3); }
    let okCount = 0; for (let i = 0; i < 15; i++) { const x = await req('POST', '/api/login', { name: 'admin', password: 'sehrgeheim1' }); if (x.status === 200) okCount++; }
    check('Erfolgreiche Anmeldungen werden nicht gesperrt (15 in Folge)', okCount === 15, okCount + '/15');
    let last; for (let i = 0; i < 12; i++) last = await req('POST', '/api/login', { name: 'admin', password: 'falsch' + i });
    check('Fehlgeschlagene Anmeldeversuche begrenzt (ab dem 11.)', last.status === 429);
    r = await req('POST', '/api/login', { name: 'admin', password: 'sehrgeheim1' }); check('Gesperrt auch mit richtigem Passwort während der Sperre', r.status === 429);
    // Persistenz über Neustart
    srv.kill('SIGTERM'); await sleep(500);
    const db = JSON.parse(fs.readFileSync(path.join(DATA, 'data', 'db.json'), 'utf8')); check('Daten nach Beenden auf Platte', Object.keys(db.users).length === 2);
    const mode = (fs.statSync(path.join(DATA, 'data', 'db.json')).mode & 0o777).toString(8); check('db.json nur für Dienstkonto lesbar', mode === '600', mode);
    [wa, wj].forEach((w) => w.close());
  } catch (e) { check('Unerwarteter Fehler', false, e.stack); console.log(srvLog.slice(-2000)); }
  finally { try { srv.kill('SIGTERM'); } catch (e) { /* schon beendet */ } fs.writeFileSync(path.join(os.tmpdir(), 'rh-api-results.json'), JSON.stringify(results, null, 1)); }
  console.log('\nERGEBNIS: ' + (results.length - failed) + ' bestanden, ' + failed + ' fehlgeschlagen');
  process.exit(failed ? 1 : 0);
})();
