'use strict';
/* RetroHub-Server 9.1.1 – HTTP-API, WebSocket-Echtzeit, Netplay (Socket.IO). Node ≥ 18.
   Lauscht nur auf 127.0.0.1; nginx stellt /api und /ws nach außen bereit. */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Store } = require('./lib/store');
const wslib = require('./lib/ws');

const ROOT = path.join(__dirname, '..');
const VERSION = (() => { try { return fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim(); } catch (e) { return '9.1.1'; } })();
const DATA = process.env.RETROHUB_DATA || '/var/lib/retrohub';
const PORT = Number(process.env.RETROHUB_PORT || 3000);
const BIND = process.env.RETROHUB_BIND || '127.0.0.1';
const DB_DIR = path.join(DATA, 'data');
const SETUP_FILE = path.join(DB_DIR, 'setup-code');
const SOURCES = process.env.RETROHUB_SOURCES || path.join(ROOT, 'games', 'sources.json');
const GAMES_TOOL = path.join(ROOT, 'tools', 'retrohub-games.js');
const SAVE_DIR = path.join(DB_DIR, 'saves');
const zlib = require('zlib');
const SESSION_DAYS = 30;

const store = new Store(DB_DIR);
const D = () => store.data;
const now = () => Date.now();
const newId = (p) => p + crypto.randomBytes(9).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
function clean(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max); }
function log(...a) { console.log(new Date().toISOString(), ...a); }

/* ---------- Einrichtungscode für das erste Admin-Konto ---------- */
function ensureSetupCode() {
  if (Object.keys(D().users).length) { try { fs.unlinkSync(SETUP_FILE); } catch (e) { /* nicht vorhanden */ } return; }
  if (fs.existsSync(SETUP_FILE)) return;
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c = '';
  for (let i = 0; i < 8; i++) c += A[crypto.randomInt(A.length)];
  fs.writeFileSync(SETUP_FILE, c.slice(0, 4) + '-' + c.slice(4) + '\n', { mode: 0o600 });
  log('Einrichtungscode erzeugt:', SETUP_FILE);
}
function setupCode() { try { return fs.readFileSync(SETUP_FILE, 'utf8').trim(); } catch (e) { return null; } }

/* ---------- Passwörter ---------- */
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function hashPw(pw) {
  return new Promise((res, rej) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(pw, salt, 64, SCRYPT, (e, k) => e ? rej(e) : res(['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), k.toString('base64')].join('$')));
  });
}
const DUMMY = 'scrypt$16384$8$1$' + Buffer.alloc(16).toString('base64') + '$' + Buffer.alloc(64).toString('base64');
function verifyPw(pw, stored) {
  return new Promise((res) => {
    const [alg, N, r, p, salt, hash] = String(stored || DUMMY).split('$');
    if (alg !== 'scrypt') return res(false);
    const expect = Buffer.from(hash, 'base64');
    crypto.scrypt(String(pw), Buffer.from(salt, 'base64'), expect.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem }, (e, k) => res(!e && crypto.timingSafeEqual(k, expect)));
  });
}

/* ---------- Ratenbegrenzung ---------- */
const buckets = new Map();
function limited(key, max, ms) {
  const t = now(); let b = buckets.get(key);
  if (!b || b.reset < t) { b = { n: 0, reset: t + ms }; buckets.set(key, b); }
  b.n++; return b.n > max;
}
// Nur zählen, nicht erhöhen (für Anmeldesperre: zählt ausschließlich Fehlversuche)
function hits(key) { const b = buckets.get(key); return b && b.reset >= now() ? b.n : 0; }
setInterval(() => { const t = now(); for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k); }, 60000).unref();

/* ---------- Hilfen für Nutzer, Audit, Benachrichtigungen ---------- */
const NAME_RE = /^[a-z0-9][a-z0-9_.-]{2,23}$/;
const RATINGS = [0, 6, 12, 16, 18];
function pub(u) { return u ? { id: u.id, name: u.name, display: u.display, role: u.role, color: u.color, parentId: u.parentId || null, maxRating: u.role === 'child' ? (RATINGS.includes(u.maxRating) ? u.maxRating : 6) : null } : null; }
function displayOf(id) { const u = D().users[id]; return u ? u.display : 'Gelöschtes Konto'; }
function findByName(name) { return Object.values(D().users).find((u) => u.name === String(name || '').toLowerCase()); }
function audit(actor, action, detail) {
  D().audit.push({ at: new Date().toISOString(), actor: actor ? actor.name : 'system', action, detail: detail || '' });
  if (D().audit.length > 2000) D().audit.splice(0, D().audit.length - 2000);
  store.save();
}
function notify(uid, type, text, data) {
  const list = D().notifications[uid] || (D().notifications[uid] = []);
  const n = { id: newId('n'), type, text, data: data || null, at: now(), read: false };
  list.push(n); if (list.length > 200) list.splice(0, list.length - 200);
  store.save(); sendTo(uid, { t: 'notify', n });
}
const COLORS = ['#FF7A66', '#3DD6C1', '#A99BFF', '#FFC94A', '#FF9F5A', '#6CB4FF', '#FF85BA', '#8BE09D'];

/* ---------- Sitzungen ---------- */
function parseCookies(h) { const o = {}; String(h || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return o; }
function sessionUser(req) {
  const tok = parseCookies(req.headers.cookie).rh_session; if (!tok) return null;
  const key = sha256(tok), s = D().sessions[key]; if (!s) return null;
  if (s.expiresAt < now()) { delete D().sessions[key]; store.save(); return null; }
  const u = D().users[s.userId]; if (!u || u.disabled) return null;
  if (now() - (s.seenAt || 0) > 3600000) { s.seenAt = now(); s.expiresAt = now() + SESSION_DAYS * 864e5; store.save(); }
  req.sessionKey = key; return u;
}
function isHttps(req) { return req.headers['x-forwarded-proto'] === 'https'; }
function setSession(req, res, u) {
  const tok = crypto.randomBytes(32).toString('base64url');
  D().sessions[sha256(tok)] = { userId: u.id, createdAt: now(), seenAt: now(), expiresAt: now() + SESSION_DAYS * 864e5, ua: clean(req.headers['user-agent'], 120) };
  u.lastLogin = new Date().toISOString(); store.save();
  res.setHeader('Set-Cookie', 'rh_session=' + tok + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + SESSION_DAYS * 86400 + (isHttps(req) ? '; Secure' : ''));
}
function killSessions(uid) { for (const [k, s] of Object.entries(D().sessions)) if (s.userId === uid) delete D().sessions[k]; store.save(); for (const ws of userSockets.get(uid) || []) ws.close(4001, 'abgemeldet'); }

/* ---------- HTTP-Grundlagen ---------- */
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (code, msg) => { throw new HttpError(code, msg); };
function send(res, code, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) }, extra || {}));
  res.end(body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Anfrage zu groß')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new HttpError(400, 'Ungültiges JSON')); } });
    req.on('error', reject);
  });
}
function clientIp(req) { return req.headers['x-real-ip'] || req.socket.remoteAddress || '?'; }
function sameOrigin(req) {
  const o = req.headers.origin; if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch (e) { return false; }
}

/* ---------- Routen ---------- */
const routes = [];
function route(method, pattern, opts, fn) {
  const keys = []; const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, opts, fn });
}
const need = (u, role) => { if (!u) fail(401, 'Bitte anmelden'); if (role === 'admin' && u.role !== 'admin') fail(403, 'Nur für Administratoren'); if (role === 'adult' && u.role === 'child') fail(403, 'Im Kinderprofil nicht verfügbar'); };

route('GET', '/api/health', { auth: false }, () => ({ ok: true, version: VERSION, uptime: Math.round(process.uptime()) }));
route('GET', '/api/session', { auth: false }, (req, u) => ({
  user: pub(u), version: VERSION, setupRequired: Object.keys(D().users).length === 0, registration: D().settings.registration
}));

function validName(name) { name = String(name || '').toLowerCase().trim(); if (!NAME_RE.test(name)) fail(400, 'Benutzername: 3–24 Zeichen, a–z, 0–9, Punkt, Bindestrich, Unterstrich'); if (findByName(name)) fail(409, 'Benutzername ist vergeben'); return name; }
function validPw(pw, min) { if (typeof pw !== 'string' || pw.length < min || pw.length > 200) fail(400, 'Passwort: mindestens ' + min + ' Zeichen'); return pw; }

route('POST', '/api/register', { auth: false }, async (req, u, b, res) => {
  if (limited('reg:' + clientIp(req), 20, 3600e3)) fail(429, 'Zu viele Versuche, später erneut');
  const first = Object.keys(D().users).length === 0;
  if (first) { const code = setupCode(); if (!code || clean(b.setupCode, 20).toUpperCase() !== code) fail(403, 'Einrichtungscode ist falsch. Er wurde am Ende der Installation angezeigt.'); }
  else if (D().settings.registration !== 'open') fail(403, 'Registrierung ist geschlossen. Ein Admin kann dein Konto anlegen.');
  const name = validName(b.name); const pw = validPw(b.password, 8);
  const display = clean(b.display, 24) || name;
  const user = { id: newId('u'), name, display, role: first ? 'admin' : 'user', pwHash: await hashPw(pw), color: COLORS[crypto.randomInt(COLORS.length)], createdAt: new Date().toISOString(), disabled: false };
  D().users[user.id] = user; store.save();
  if (first) { try { fs.unlinkSync(SETUP_FILE); } catch (e) { /* schon weg */ } }
  audit(user, 'registriert', first ? 'erstes Konto (Admin)' : '');
  setSession(req, res, user); return { user: pub(user) };
});
route('POST', '/api/login', { auth: false }, async (req, u, b, res) => {
  const name = String(b.name || '').toLowerCase().trim();
  const ipKey = 'login-ip:' + clientIp(req), nameKey = 'login:' + name;
  if (hits(ipKey) >= 30 || hits(nameKey) >= 10) fail(429, 'Zu viele fehlgeschlagene Anmeldeversuche. Bitte 10 Minuten warten.');
  const user = findByName(name);
  const ok = await verifyPw(String(b.password || ''), user && user.pwHash);
  if (!user || !ok) {
    limited(ipKey, Infinity, 600e3); limited(nameKey, Infinity, 600e3);
    audit(null, 'anmeldung-fehlgeschlagen', name + ' von ' + clientIp(req)); fail(401, 'Benutzername oder Passwort ist falsch');
  }
  buckets.delete(nameKey);
  if (user.disabled) fail(403, 'Dieses Konto ist gesperrt');
  setSession(req, res, user); audit(user, 'angemeldet', clientIp(req)); return { user: pub(user) };
});
route('POST', '/api/logout', { auth: false }, (req, u, b, res) => {
  if (req.sessionKey) { delete D().sessions[req.sessionKey]; store.save(); }
  res.setHeader('Set-Cookie', 'rh_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'); return { ok: true };
});

route('PATCH', '/api/me', {}, async (req, u, b) => {
  if (b.display !== undefined) { const d = clean(b.display, 24); if (!d) fail(400, 'Anzeigename fehlt'); u.display = d; }
  if (b.color !== undefined) { if (!COLORS.includes(b.color)) fail(400, 'Farbe nicht erlaubt'); u.color = b.color; }
  if (b.newPassword !== undefined) {
    if (!(await verifyPw(String(b.currentPassword || ''), u.pwHash))) fail(403, 'Aktuelles Passwort ist falsch');
    u.pwHash = await hashPw(validPw(b.newPassword, u.role === 'child' ? 4 : 8));
    for (const [k, s] of Object.entries(D().sessions)) if (s.userId === u.id && k !== req.sessionKey) delete D().sessions[k];
    audit(u, 'passwort-geändert');
  }
  store.save(); return { user: pub(u) };
});
route('GET', '/api/me/data', {}, (req, u) => ({
  favorites: D().favorites[u.id] || [], progress: D().progress[u.id] || { best: {}, time: {}, plays: {}, last: null }, stats: D().stats[u.id] || {}
}));
route('PUT', '/api/me/favorites', {}, (req, u, b) => {
  if (!Array.isArray(b.favorites)) fail(400, 'Liste erwartet');
  D().favorites[u.id] = [...new Set(b.favorites.map((x) => clean(x, 40)).filter(Boolean))].slice(0, 500); store.save(); return { favorites: D().favorites[u.id] };
});
const BEST_MIN = { lightsout: true };
route('POST', '/api/me/progress', {}, (req, u, b) => {
  const game = clean(b.game, 40); if (!/^[a-z0-9-]+$/.test(game)) fail(400, 'Spiel-ID ungültig');
  const p = D().progress[u.id] || (D().progress[u.id] = { best: {}, time: {}, plays: {}, last: null });
  const sec = Math.max(0, Math.min(86400, Math.round(Number(b.seconds) || 0)));
  p.time[game] = (p.time[game] || 0) + sec; p.last = { id: game, at: now() };
  let record = false;
  const rounds = b.round === true ? 1 : Math.max(0, Math.min(1000, Math.round(Number(b.rounds) || 0)));
  if (rounds) p.plays[game] = (p.plays[game] || 0) + rounds;
  if (b.score !== undefined && Number.isFinite(Number(b.score))) {
    const v = Number(b.score), old = p.best[game];
    if (old === undefined || (BEST_MIN[game] ? v < old : v > old)) { p.best[game] = v; record = true; }
  }
  store.save(); return { progress: p, record };
});

/* Kinderprofile */
route('GET', '/api/children', {}, (req, u) => ({ children: Object.values(D().users).filter((c) => c.role === 'child' && (c.parentId === u.id || u.role === 'admin')).map(pub) }));
route('POST', '/api/children', { role: 'adult' }, async (req, u, b) => {
  const name = validName(b.name); const pw = validPw(b.password, 4);
  const c = { id: newId('u'), name, display: clean(b.display, 24) || name, role: 'child', parentId: u.id, maxRating: RATINGS.includes(Number(b.maxRating)) ? Number(b.maxRating) : 6, pwHash: await hashPw(pw), color: COLORS[crypto.randomInt(COLORS.length)], createdAt: new Date().toISOString(), disabled: false };
  D().users[c.id] = c; store.save(); audit(u, 'kinderprofil-angelegt', name); return { child: pub(c) };
});
function ownChild(u, id) { const c = D().users[id]; if (!c || c.role !== 'child' || (c.parentId !== u.id && u.role !== 'admin')) fail(404, 'Kinderprofil nicht gefunden'); return c; }
route('PATCH', '/api/children/:id', { role: 'adult' }, async (req, u, b, res, p) => {
  const c = ownChild(u, p.id);
  if (b.password !== undefined) { c.pwHash = await hashPw(validPw(b.password, 4)); killSessions(c.id); }
  if (b.display !== undefined) c.display = clean(b.display, 24) || c.display;
  if (b.maxRating !== undefined) { const r = Number(b.maxRating); if (![0, 6, 12, 16].includes(r)) fail(400, 'Freigabe muss 0, 6, 12 oder 16 sein'); c.maxRating = r; sendTo(c.id, { t: 'library' }); }
  store.save(); audit(u, 'kinderprofil-geändert', c.name + (b.maxRating !== undefined ? ' (Freigabe bis ' + c.maxRating + ')' : '')); return { child: pub(c) };
});
route('DELETE', '/api/children/:id', { role: 'adult' }, (req, u, b, res, p) => { const c = ownChild(u, p.id); deleteUser(c); audit(u, 'kinderprofil-gelöscht', c.name); return { ok: true }; });

/* Freunde */
const pairKey = (a, b) => (a < b ? [a, b] : [b, a]);
function rel(a, b) { const [x, y] = pairKey(a, b); return D().friendships.find((f) => f.a === x && f.b === y); }
function areFriends(a, b) { const r = rel(a, b); return !!r && r.status === 'accepted'; }
function friendIds(uid) { return D().friendships.filter((f) => f.status === 'accepted' && (f.a === uid || f.b === uid)).map((f) => (f.a === uid ? f.b : f.a)); }
route('GET', '/api/friends', { role: 'adult' }, (req, u) => {
  const mine = D().friendships.filter((f) => f.a === u.id || f.b === u.id);
  const other = (f) => (f.a === u.id ? f.b : f.a);
  const card = (id) => Object.assign(pub(D().users[id]) || { id, display: 'Gelöschtes Konto' }, { online: userSockets.has(id), lobby: lobbyTitleOf(id) });
  return {
    friends: mine.filter((f) => f.status === 'accepted').map((f) => card(other(f))),
    incoming: mine.filter((f) => f.status === 'pending' && f.from !== u.id).map((f) => card(other(f))),
    outgoing: mine.filter((f) => f.status === 'pending' && f.from === u.id).map((f) => card(other(f)))
  };
});
route('POST', '/api/friends/request', { role: 'adult' }, (req, u, b) => {
  if (limited('friendreq:' + u.id, 30, 3600e3)) fail(429, 'Zu viele Anfragen');
  const t = findByName(b.name); if (!t || t.role === 'child' || t.disabled) fail(404, 'Kein Konto mit diesem Benutzernamen');
  if (t.id === u.id) fail(400, 'Das bist du selbst');
  const r = rel(u.id, t.id);
  if (r && r.status === 'accepted') fail(409, 'Ihr seid bereits befreundet');
  if (r && r.from === t.id) { r.status = 'accepted'; store.save(); notify(t.id, 'friend', u.display + ' hat deine Freundschaftsanfrage angenommen'); pushFriends(u.id, t.id); return { status: 'accepted' }; }
  if (r) fail(409, 'Anfrage wurde bereits gesendet');
  const [a, bb] = pairKey(u.id, t.id); D().friendships.push({ a, b: bb, status: 'pending', from: u.id, at: now() }); store.save();
  notify(t.id, 'friend-request', u.display + ' möchte mit dir befreundet sein', { from: u.id }); pushFriends(t.id); return { status: 'pending' };
});
route('POST', '/api/friends/:id/accept', { role: 'adult' }, (req, u, b, res, p) => {
  const r = rel(u.id, p.id); if (!r || r.status !== 'pending' || r.from === u.id) fail(404, 'Keine offene Anfrage');
  r.status = 'accepted'; store.save(); notify(p.id, 'friend', u.display + ' hat deine Freundschaftsanfrage angenommen'); pushFriends(u.id, p.id); return { ok: true };
});
route('DELETE', '/api/friends/:id', { role: 'adult' }, (req, u, b, res, p) => {
  const r = rel(u.id, p.id); if (!r) fail(404, 'Keine Verbindung'); D().friendships.splice(D().friendships.indexOf(r), 1); store.save(); pushFriends(u.id, p.id); return { ok: true };
});

/* Chat und Direktnachrichten */
const CHANNELS = { allgemein: 'Allgemein', couchabend: 'Couch-Abend' };
function channelKey(u, ch) {
  if (CHANNELS[ch]) return { key: 'c:' + ch, members: null };
  const m = /^dm:(u[\w-]+)$/.exec(ch); if (!m) fail(404, 'Kanal unbekannt');
  if (!areFriends(u.id, m[1])) fail(403, 'Direktnachrichten nur unter Freunden');
  const [a, b] = pairKey(u.id, m[1]); return { key: 'dm:' + a + ':' + b, members: [a, b], other: m[1] };
}
const msgView = (m) => ({ id: m.id, from: m.from, display: displayOf(m.from), color: (D().users[m.from] || {}).color, text: m.text, at: m.at });
route('GET', '/api/chat/:ch', { role: 'adult' }, (req, u, b, res, p) => { const c = channelKey(u, p.ch); return { messages: (D().messages[c.key] || []).slice(-100).map(msgView) }; });
route('POST', '/api/chat/:ch', { role: 'adult' }, (req, u, b, res, p) => {
  if (limited('chat:' + u.id, 20, 10e3)) fail(429, 'Bitte langsamer schreiben');
  const c = channelKey(u, p.ch); const text = clean(b.text, 500); if (!text) fail(400, 'Nachricht ist leer');
  const list = D().messages[c.key] || (D().messages[c.key] = []);
  const m = { id: newId('m'), from: u.id, text, at: now() }; list.push(m); if (list.length > 500) list.splice(0, list.length - 500); store.save();
  const out = { t: 'chat', channel: c.members ? null : p.ch, dm: c.members ? true : false, message: msgView(m) };
  if (c.members) {
    for (const id of c.members) sendTo(id, Object.assign({}, out, { channel: 'dm:' + (id === u.id ? c.other : u.id) }));
    notify(c.other, 'dm', u.display + ': ' + text.slice(0, 80), { from: u.id });
  } else broadcast(out, (cu) => cu.role !== 'child');
  return { message: msgView(m) };
});

/* Benachrichtigungen */
route('GET', '/api/notifications', {}, (req, u) => ({ notifications: (D().notifications[u.id] || []).slice(-50).reverse() }));
route('POST', '/api/notifications/read', {}, (req, u) => { (D().notifications[u.id] || []).forEach((n) => { n.read = true; }); store.save(); return { ok: true }; });

/* ---------- Spielebibliothek (Emulatoren) ---------- */
const { SYSTEMS: SYS_LIST, BY_KEY: SYS, checkHeader } = require('./lib/systems');
const LIB_DIR = path.join(DATA, 'library');
const BIOS_DIR = path.join(DATA, 'bios');
const IMPORT_DIR = process.env.RETROHUB_IMPORT || '/srv/retrohub-import';
const EMU_MANIFEST = path.join(DATA, 'emu-manifest.json');
const safeName = (n) => String(n || 'datei').replace(/[\\/\u0000-\u001f]/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'datei';
const extOf = (n) => { const m = /\.[A-Za-z0-9]{1,6}$/.exec(String(n)); return m ? m[0].toLowerCase() : ''; };
function installedCores() {
  let pk = []; try { pk = JSON.parse(fs.readFileSync(EMU_MANIFEST, 'utf8')).packages || []; } catch (e) { pk = []; }
  return { ui: pk.some((p) => p.id === 'emulatorjs'), cores: new Set(pk.map((p) => p.core).filter(Boolean)) };
}
const biosFile = (k) => path.join(BIOS_DIR, k + '.bin');
function biosMeta(k) { try { return JSON.parse(fs.readFileSync(path.join(BIOS_DIR, k + '.json'), 'utf8')); } catch (e) { return null; } }
function sysView(s, ic) {
  ic = ic || installedCores(); const bm = biosMeta(s.key);
  const coreOk = ic.ui && ic.cores.has(s.core);
  return { key: s.key, name: s.name, maker: s.maker, core: s.core, exts: s.exts, maxMB: s.maxMB, players: s.players, bios: s.bios || null, biosHint: s.biosHint || null, biosInstalled: !!bm, biosFile: bm ? bm.filename : null, threads: !!s.threads, archiveIsGame: !!s.archiveIsGame, coreInstalled: coreOk, ready: coreOk && (s.bios !== 'required' || !!bm) };
}
function lib() { if (!D().library) D().library = {}; return D().library; }
// Altersfreigabe: Kinder sehen nur eingestufte Spiele bis zu ihrer Freigabegrenze (nicht eingestufte bleiben verborgen)
function canSee(u, g) { if (!u || u.role !== 'child') return true; const max = RATINGS.includes(u.maxRating) ? u.maxRating : 6; return g.rating !== null && g.rating !== undefined && g.rating <= max; }
function visibleGame(u, id) { const g = findGame(id); if (!canSee(u, g)) fail(403, 'Dieses Spiel ist für dein Profil nicht freigegeben'); return g; }
const COVER_DIR = () => path.join(LIB_DIR, 'covers');
const DISC_EXT = ['.cue', '.ccd', '.chd', '.pbp', '.iso', '.cso'];
const MULTIDISC = ['psx', 'segaCD', 'segaSaturn', 'pce', 'pcfx', '3do'];
function discFiles(g) {
  if (!MULTIDISC.includes(g.system) || g.files.some((f) => extOf(f.name) === '.m3u')) return [];
  let d = g.files.filter((f) => ['.cue', '.ccd', '.chd', '.pbp'].includes(extOf(f.name)));
  if (!d.length) d = g.files.filter((f) => ['.iso', '.cso'].includes(extOf(f.name)));
  return d.sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }));
}
function gameView(g, ic) {
  const s = SYS[g.system]; const sv = s ? sysView(s, ic) : null;
  return { id: g.id, title: g.title, system: g.system, systemName: s ? s.name : g.system, desc: g.desc || '', year: g.year || null, genre: g.genre || '', rating: g.rating === undefined ? null : g.rating, cover: g.cover ? g.cover.v : null, discs: discFiles(g).length || null, players: g.players || (s ? Math.min(s.players, 4) : 1), files: g.files.map((f) => ({ name: f.name, size: f.size, src: f.src })), size: g.files.reduce((a, f) => a + f.size, 0), addedAt: g.addedAt, addedBy: displayOf(g.addedBy), ready: !!(sv && sv.ready) };
}
function within(base, p) { const r = path.resolve(base, p); return r === base || r.startsWith(base + path.sep) ? r : null; }
function filePath(f) {
  if (f.src === 'folder') { const r = within(path.resolve(IMPORT_DIR), f.path); if (!r) fail(400, 'Ungültiger Pfad'); return r; }
  return path.join(LIB_DIR, f.path);
}
function findGame(id) { const g = lib()[String(Number(id))]; if (!g) fail(404, 'Spiel nicht gefunden'); return g; }
function newGame(u, sys, title, extra) {
  D().librarySeq = (D().librarySeq || 0) + 1; const id = D().librarySeq;
  const g = { id, title: clean(title, 60) || 'Spiel ' + id, system: sys.key, desc: clean(extra.desc, 300), players: Math.max(1, Math.min(sys.players, Number(extra.players) || 1)), files: [], addedBy: u.id, addedAt: new Date().toISOString() };
  lib()[String(id)] = g; return g;
}
function shaExists(sha) { for (const g of Object.values(lib())) for (const f of g.files) if (f.sha256 === sha) return g; return null; }
// CRC32 und ZIP-Strom (Methode „store“, mit Datendeskriptor) für mehrteilige Spiele und BIOS-Pakete
const CRC_T = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crcUpdate(crc, buf) { let c = crc ^ -1; for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; }
async function zipStream(entries, out) { // entries: [{name, path}]
  const central = []; let offset = 0, failed = null; out.on('error', (e) => { failed = e; });
  const write = (b) => new Promise((res, rej) => { if (failed) return rej(failed); offset += b.length; if (out.write(b)) res(); else out.once('drain', res); });
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'), h = Buffer.alloc(30); const start = offset;
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0808, 6); h.writeUInt16LE(0, 8); h.writeUInt32LE(0, 10); h.writeUInt32LE(0, 14); h.writeUInt32LE(0, 18); h.writeUInt32LE(0, 22); h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    await write(Buffer.concat([h, name]));
    let crc = 0, size = 0;
    const src = e.data ? [e.data] : fs.createReadStream(e.path, { highWaterMark: 1 << 20 });
    for await (const chunk of src) { crc = crcUpdate(crc, chunk); size += chunk.length; await write(chunk); }
    if (size >= 0xFFFFFFFF) throw new Error('Datei zu groß für ZIP');
    const dd = Buffer.alloc(16); dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc, 4); dd.writeUInt32LE(size, 8); dd.writeUInt32LE(size, 12); await write(dd);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0808, 8); c.writeUInt16LE(0, 10); c.writeUInt32LE(0, 12); c.writeUInt32LE(crc, 16); c.writeUInt32LE(size, 20); c.writeUInt32LE(size, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(start, 42);
    central.push(Buffer.concat([c, name]));
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  await write(cd); await write(end); out.end();
}
route('GET', '/api/systems', {}, () => { const ic = installedCores(); return { systems: SYS_LIST.map((s) => sysView(s, ic)), importDir: fs.existsSync(IMPORT_DIR) ? IMPORT_DIR : null }; });
route('GET', '/api/library', {}, (req, u) => { const ic = installedCores(); return { games: Object.values(lib()).filter((g) => canSee(u, g)).map((g) => gameView(g, ic)).sort((a, b) => a.title.localeCompare(b.title, 'de')) }; });
route('GET', '/api/library/:id/data', {}, async (req, u, b, res, p) => {
  const g = visibleGame(u, p.id); const files = g.files.map((f) => ({ name: f.name, path: filePath(f) }));
  for (const f of files) if (!fs.existsSync(f.path)) fail(404, 'Spieldatei fehlt: ' + f.name);
  const discs = discFiles(g);
  if (discs.length > 1) files.unshift({ name: safeName(g.title) + '.m3u', data: Buffer.from(discs.map((f) => f.name).join('\n') + '\n', 'utf8') }); // Disc-Liste für den Disc-Wechsel
  if (files.length === 1) {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(files[0].path).size, 'Cache-Control': 'private, max-age=3600', 'X-Game-File': encodeURIComponent(files[0].name) });
    fs.createReadStream(files[0].path).pipe(res); return undefined;
  }
  res.writeHead(200, { 'Content-Type': 'application/zip', 'Cache-Control': 'private, max-age=3600', 'X-Game-File': encodeURIComponent(safeName(g.title) + '.zip') });
  await zipStream(files, res); return undefined;
});
// Neues Spiel oder weitere Datei aus einem Datenstrom (Upload oder URL) anlegen
function ingest(u, src, q, stream, declared, origName) {
  return new Promise((resolve, reject) => {
    const sys = SYS[q.system]; if (!sys) return reject(new HttpError(400, 'System unbekannt'));
    const name = safeName(origName), ext = extOf(name);
    if (!sys.exts.includes(ext)) return reject(new HttpError(400, 'Dateiendung ' + (ext || '(keine)') + ' passt nicht zu ' + sys.name + ' (' + sys.exts.join(', ') + ')'));
    if (declared > sys.maxBytes) return reject(new HttpError(413, 'Datei größer als ' + sys.maxMB + ' MB'));
    const target = q.game ? findGame(q.game) : null; if (target && target.system !== sys.key) return reject(new HttpError(400, 'Spiel gehört zu einem anderen System'));
    fs.mkdirSync(LIB_DIR, { recursive: true, mode: 0o750 });
    const rel = crypto.randomBytes(8).toString('hex') + '-' + name, tmp = path.join(LIB_DIR, '.tmp-' + rel);
    const out = fs.createWriteStream(tmp, { mode: 0o640 }), hash = crypto.createHash('sha256'); let size = 0, head = Buffer.alloc(0), dead = false;
    const abort = (e) => { if (dead) return; dead = true; out.destroy(); try { fs.unlinkSync(tmp); } catch (x) { /* weg */ } stream.resume(); reject(e); };
    stream.on('data', (c) => {
      if (dead) return; size += c.length; if (size > sys.maxBytes) return abort(new HttpError(413, 'Datei größer als ' + sys.maxMB + ' MB'));
      if (head.length < 0x9000) head = Buffer.concat([head, c.slice(0, 0x9000 - head.length)]);
      hash.update(c); if (!out.write(c)) { stream.pause(); out.once('drain', () => stream.resume()); }
    });
    stream.on('error', () => abort(new HttpError(400, 'Übertragung abgebrochen')));
    stream.on('end', () => {
      if (dead) return;
      out.end(() => {
        if (!size) return abort(new HttpError(400, 'Datei ist leer'));
        if (!checkHeader(sys, ext, head)) return abort(new HttpError(400, 'Dateikopf passt nicht zu ' + sys.name + ' (' + ext + ')'));
        const sha = hash.digest('hex'); const dup = shaExists(sha);
        if (dup) return abort(new HttpError(409, 'Diese Datei ist bereits im Spiel „' + dup.title + '“'));
        fs.renameSync(tmp, path.join(LIB_DIR, rel));
        const g = target || newGame(u, sys, q.title || name.replace(/\.[^.]+$/, ''), q);
        g.files.push({ name, size, sha256: sha, src, path: rel });
        store.save(); audit(u, 'spiel-' + (target ? 'datei-ergänzt' : 'hinzugefügt'), g.title + ' (' + sys.name + ', ' + src + ', ' + Math.round(size / 1024) + ' KB)'); broadcast({ t: 'library' });
        resolve({ game: gameView(g) });
      });
    });
  });
}
const rightsOk = (v) => v === true || v === '1' || v === 'true';
route('POST', '/api/admin/library/upload', { role: 'admin', raw: true }, (req, u, b, res, p, url) => {
  const q = Object.fromEntries(url.searchParams);
  if (!rightsOk(q.rights)) { req.resume(); fail(400, 'Bitte bestätigen, dass du die Rechte an dieser Datei besitzt'); }
  return ingest(u, 'upload', q, req, Number(req.headers['content-length'] || 0), q.filename);
});
// Download von einer URL (Hintergrundauftrag mit Fortschritt)
const jobs = new Map();
function blockedHost(h) { return /^(localhost|127\.|0\.|\[?::1\]?$|169\.254\.)/i.test(h); }
function fetchUrl(url, redirects) {
  return new Promise((resolve, reject) => {
    let u2; try { u2 = new URL(url); } catch (e) { return reject(new Error('Ungültige URL')); }
    if (!/^https?:$/.test(u2.protocol)) return reject(new Error('Nur http:// und https:// sind erlaubt'));
    if (blockedHost(u2.hostname)) return reject(new Error('Adressen dieses Servers sind nicht erlaubt'));
    const mod = u2.protocol === 'https:' ? require('https') : http;
    const r = mod.get(u2, { headers: { 'User-Agent': 'RetroHub/' + VERSION }, timeout: 30000 }, (resp) => {
      if ([301, 302, 303, 307, 308].includes(resp.statusCode) && resp.headers.location) { resp.resume(); if ((redirects || 0) >= 5) return reject(new Error('Zu viele Weiterleitungen')); return resolve(fetchUrl(new URL(resp.headers.location, u2).toString(), (redirects || 0) + 1)); }
      if (resp.statusCode !== 200) { resp.resume(); return reject(new Error('Server antwortet mit HTTP ' + resp.statusCode)); }
      let name = ''; const cd = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(resp.headers['content-disposition'] || ''); if (cd) { try { name = decodeURIComponent(cd[1]); } catch (e) { name = cd[1]; } }
      if (!name) name = decodeURIComponent(path.basename(u2.pathname) || 'download');
      resolve({ resp, name, total: Number(resp.headers['content-length'] || 0) });
    });
    r.on('timeout', () => r.destroy(new Error('Zeitüberschreitung'))); r.on('error', reject);
  });
}
route('POST', '/api/admin/library/url', { role: 'admin' }, (req, u, b) => {
  if (!rightsOk(b.rights)) fail(400, 'Bitte bestätigen, dass du die Rechte an dieser Datei besitzt');
  if (!SYS[b.system]) fail(400, 'System unbekannt');
  const id = 'j' + crypto.randomBytes(6).toString('hex'); const job = { id, state: 'läuft', received: 0, total: 0, url: clean(b.url, 500), error: null, game: null }; jobs.set(id, job);
  fetchUrl(String(b.url || '')).then(({ resp, name, total }) => {
    job.total = total; job.name = name; resp.on('data', (c) => { job.received += c.length; });
    return ingest(u, 'url', { system: b.system, title: b.title, desc: b.desc, players: b.players, game: b.game }, resp, total, b.filename || name);
  }).then((r) => { job.state = 'fertig'; job.game = r.game; }, (e) => { job.state = 'fehler'; job.error = e.message; });
  audit(u, 'url-download-gestartet', job.url); return { job };
});
route('GET', '/api/admin/jobs/:id', { role: 'admin' }, (req, u, b, res, p) => { const j = jobs.get(p.id); if (!j) fail(404, 'Auftrag unbekannt'); return { job: j }; });
// Ordner-Import (z. B. NAS-Freigabe per Bind-Mount, nur lesend)
route('GET', '/api/admin/import/scan', { role: 'admin' }, () => {
  const base = path.resolve(IMPORT_DIR); if (!fs.existsSync(base)) return { available: false, dir: IMPORT_DIR, files: [] };
  const known = new Map(); for (const g of Object.values(lib())) for (const f of g.files) if (f.src === 'folder') known.set(f.path, g.id);
  const out = []; let count = 0;
  (function walk(d, depth) {
    if (depth > 8 || count > 20000) return;
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue; const pth = path.join(d, e.name); count++;
      if (e.isDirectory()) walk(pth, depth + 1);
      else if (e.isFile()) {
        const ext = extOf(e.name), systems = SYS_LIST.filter((s) => s.exts.includes(ext)).map((s) => s.key); if (!systems.length) continue;
        const rel = path.relative(base, pth); let size = 0; try { size = fs.statSync(pth).size; } catch (x) { continue; }
        out.push({ path: rel, name: e.name, size, ext, systems, imported: known.has(rel) ? known.get(rel) : null });
      }
    }
  }(base, 0));
  return { available: true, dir: IMPORT_DIR, files: out.slice(0, 5000), truncated: out.length > 5000 };
});
async function hashFile(p) { const h = crypto.createHash('sha256'); for await (const c of fs.createReadStream(p, { highWaterMark: 1 << 20 })) h.update(c); return h.digest('hex'); }
function readHead(p) { const fd = fs.openSync(p, 'r'); try { const b = Buffer.alloc(0x9000); const n = fs.readSync(fd, b, 0, b.length, 0); return b.slice(0, n); } finally { fs.closeSync(fd); } }
function cueCompanions(abs, rel) {
  try { const txt = fs.readFileSync(abs, 'utf8'); const out = []; for (const m of txt.matchAll(/^\s*FILE\s+"?([^"\r\n]+?)"?\s+\w+\s*$/gmi)) { const r = path.join(path.dirname(rel), m[1]); if (!out.includes(r)) out.push(r); } return out; } catch (e) { return []; }
}
route('POST', '/api/admin/import', { role: 'admin' }, async (req, u, b) => {
  if (!rightsOk(b.rights)) fail(400, 'Bitte bestätigen, dass du die Rechte an diesen Dateien besitzt');
  const base = path.resolve(IMPORT_DIR); if (!fs.existsSync(base)) fail(400, 'Kein Import-Ordner eingebunden');
  const items = Array.isArray(b.items) ? b.items.slice(0, 500) : []; const done = [], errors = [];
  for (const it of items) {
    try {
      const sys = SYS[it.system]; if (!sys) throw new Error('System unbekannt');
      const abs = within(base, String(it.path || '')); if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error('Datei nicht gefunden');
      const rel = path.relative(base, abs), ext = extOf(abs); if (!sys.exts.includes(ext)) throw new Error('Endung passt nicht zu ' + sys.name);
      const parts = [rel].concat(ext === '.cue' ? cueCompanions(abs, rel) : []);
      const files = [];
      for (const r of parts) {
        const a = within(base, r); if (!a || !fs.existsSync(a)) throw new Error('Zugehörige Datei fehlt: ' + r);
        const size = fs.statSync(a).size; if (size > sys.maxBytes) throw new Error(path.basename(r) + ' größer als ' + sys.maxMB + ' MB');
        if (r === rel && !checkHeader(sys, ext, readHead(a))) throw new Error('Dateikopf passt nicht zu ' + sys.name);
        const sha = await hashFile(a); const dup = shaExists(sha); if (dup) throw new Error('Bereits vorhanden im Spiel „' + dup.title + '“');
        files.push({ name: path.basename(r), size, sha256: sha, src: 'folder', path: r });
      }
      const g = newGame(u, sys, it.title || path.basename(rel).replace(/\.[^.]+$/, ''), it); g.files = files; done.push(gameView(g));
    } catch (e) { errors.push({ path: it.path, error: e.message }); }
  }
  store.save(); if (done.length) { audit(u, 'ordner-import', done.length + ' Spiele'); broadcast({ t: 'library' }); }
  return { imported: done, errors };
});
route('PATCH', '/api/admin/library/:id', { role: 'admin' }, (req, u, b, res, p) => {
  const g = findGame(p.id);
  if (b.title !== undefined) g.title = clean(b.title, 60) || g.title;
  if (b.desc !== undefined) g.desc = clean(b.desc, 300);
  if (b.players !== undefined) g.players = Math.max(1, Math.min(8, Number(b.players) || 1));
  if (b.year !== undefined) { const y = b.year === null || b.year === '' ? null : Number(b.year); if (y !== null && (!Number.isInteger(y) || y < 1970 || y > 2100)) fail(400, 'Jahr ungültig'); g.year = y; }
  if (b.genre !== undefined) g.genre = clean(b.genre, 40);
  if (b.rating !== undefined) { const r = b.rating === null || b.rating === '' ? null : Number(b.rating); if (r !== null && !RATINGS.includes(r)) fail(400, 'Freigabe muss 0, 6, 12, 16 oder 18 sein'); g.rating = r; }
  store.save(); broadcast({ t: 'library' }); return { game: gameView(g) };
});
// Cover (PNG, JPEG, WebP bis 2 MB) – Dateikopf wird geprüft
const IMG = { png: { mime: 'image/png', ok: (b) => b.slice(0, 8).toString('hex') === '89504e470d0a1a0a' }, jpg: { mime: 'image/jpeg', ok: (b) => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF }, webp: { mime: 'image/webp', ok: (b) => b.slice(0, 4).toString('binary') === 'RIFF' && b.slice(8, 12).toString('binary') === 'WEBP' } };
route('POST', '/api/admin/library/:id/cover', { role: 'admin', raw: true }, (req, u, b, res, p) => new Promise((resolve, reject) => {
  let g; try { g = findGame(p.id); } catch (e) { req.resume(); return reject(e); }
  const chunks = []; let size = 0, dead = false;
  req.on('data', (c) => { if (dead) return; size += c.length; if (size > 2 * 1048576) { dead = true; req.resume(); reject(new HttpError(413, 'Cover größer als 2 MB')); return; } chunks.push(c); });
  req.on('end', () => {
    if (dead) return; const buf = Buffer.concat(chunks); const kind = Object.keys(IMG).find((k) => IMG[k].ok(buf));
    if (!kind) return reject(new HttpError(400, 'Cover muss PNG, JPEG oder WebP sein'));
    fs.mkdirSync(COVER_DIR(), { recursive: true, mode: 0o750 });
    if (g.cover) { try { fs.unlinkSync(path.join(COVER_DIR(), g.cover.file)); } catch (e) { /* weg */ } }
    const file = g.id + '-' + crypto.randomBytes(4).toString('hex') + '.' + kind; fs.writeFileSync(path.join(COVER_DIR(), file), buf, { mode: 0o640 });
    g.cover = { file, mime: IMG[kind].mime, v: crypto.randomBytes(4).toString('hex') }; store.save(); broadcast({ t: 'library' }); resolve({ game: gameView(g) });
  });
}));
route('DELETE', '/api/admin/library/:id/cover', { role: 'admin' }, (req, u, b, res, p) => {
  const g = findGame(p.id); if (g.cover) { try { fs.unlinkSync(path.join(COVER_DIR(), g.cover.file)); } catch (e) { /* weg */ } delete g.cover; store.save(); broadcast({ t: 'library' }); }
  return { game: gameView(g) };
});
route('GET', '/api/library/:id/cover', {}, (req, u, b, res, p) => {
  const g = visibleGame(u, p.id); if (!g.cover) fail(404, 'Kein Cover');
  const f = path.join(COVER_DIR(), g.cover.file); if (!fs.existsSync(f)) fail(404, 'Kein Cover');
  res.writeHead(200, { 'Content-Type': g.cover.mime, 'Content-Length': fs.statSync(f).size, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(f).pipe(res); return undefined;
});
// Discs zusammenführen: Dateien eines anderen Spiels desselben Systems übernehmen
route('POST', '/api/admin/library/:id/merge', { role: 'admin' }, (req, u, b, res, p) => {
  const g = findGame(p.id), o = findGame(b.from);
  if (g.id === o.id) fail(400, 'Ein Spiel kann nicht mit sich selbst zusammengeführt werden');
  if (g.system !== o.system) fail(400, 'Nur Spiele desselben Systems lassen sich zusammenführen');
  g.files = g.files.concat(o.files); if (o.cover) { try { fs.unlinkSync(path.join(COVER_DIR(), o.cover.file)); } catch (e) { /* weg */ } }
  delete lib()[String(o.id)];
  try { for (const uid of fs.readdirSync(SAVE_DIR)) { const from = path.join(SAVE_DIR, uid, 'g' + o.id), to = path.join(SAVE_DIR, uid, 'g' + g.id); if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to); } } catch (e) { /* keine Spielstände */ }
  store.save(); audit(u, 'spiele-zusammengeführt', o.title + ' → ' + g.title); broadcast({ t: 'library' }); return { game: gameView(g) };
});
route('DELETE', '/api/admin/library/:id', { role: 'admin' }, (req, u, b, res, p) => {
  const g = findGame(p.id);
  if (g.cover) { try { fs.unlinkSync(path.join(COVER_DIR(), g.cover.file)); } catch (e) { /* weg */ } }
  for (const f of g.files) if (f.src !== 'folder') { try { fs.unlinkSync(path.join(LIB_DIR, f.path)); } catch (e) { /* weg */ } }
  delete lib()[String(g.id)]; store.save(); audit(u, 'spiel-entfernt', g.title); broadcast({ t: 'library' }); return { ok: true };
});
// BIOS je System (als ZIP mit Originaldateinamen an den Emulator geliefert)
route('GET', '/api/bios/:system', {}, async (req, u, b, res, p) => {
  const bm = biosMeta(p.system); if (!SYS[p.system] || !bm || !fs.existsSync(biosFile(p.system))) fail(404, 'Kein BIOS für dieses System');
  res.writeHead(200, { 'Content-Type': 'application/zip', 'Cache-Control': 'private, max-age=3600' });
  if (extOf(bm.filename) === '.zip') { fs.createReadStream(biosFile(p.system)).pipe(res); return undefined; }
  await zipStream([{ name: bm.filename, path: biosFile(p.system) }], res); return undefined;
});
route('POST', '/api/admin/bios/:system', { role: 'admin', raw: true }, (req, u, b, res, p, url) => new Promise((resolve, reject) => {
  const sys = SYS[p.system]; if (!sys) { req.resume(); return reject(new HttpError(404, 'System unbekannt')); }
  if (!rightsOk(url.searchParams.get('rights'))) { req.resume(); return reject(new HttpError(400, 'Bitte bestätigen, dass du die Rechte an dieser BIOS-Datei besitzt')); }
  const filename = safeName(url.searchParams.get('filename')); fs.mkdirSync(BIOS_DIR, { recursive: true, mode: 0o750 });
  const tmp = biosFile(p.system) + '.tmp', out = fs.createWriteStream(tmp, { mode: 0o640 }), hash = crypto.createHash('sha256'); let size = 0, dead = false;
  req.on('data', (c) => { if (dead) return; size += c.length; if (size > 64 * 1048576) { dead = true; out.destroy(); try { fs.unlinkSync(tmp); } catch (e) { /* weg */ } req.resume(); reject(new HttpError(413, 'BIOS größer als 64 MB')); return; } hash.update(c); out.write(c); });
  req.on('end', () => { if (dead) return; out.end(() => { if (!size) { fs.unlinkSync(tmp); return reject(new HttpError(400, 'Datei ist leer')); } fs.renameSync(tmp, biosFile(p.system)); const meta = { filename, size, sha256: hash.digest('hex'), at: new Date().toISOString() }; fs.writeFileSync(path.join(BIOS_DIR, p.system + '.json'), JSON.stringify(meta), { mode: 0o640 }); audit(u, 'bios-hochgeladen', sys.name + ': ' + filename); broadcast({ t: 'library' }); resolve({ bios: meta }); }); });
}));
route('DELETE', '/api/admin/bios/:system', { role: 'admin' }, (req, u, b, res, p) => {
  if (!SYS[p.system]) fail(404, 'System unbekannt'); for (const f of [biosFile(p.system), path.join(BIOS_DIR, p.system + '.json')]) { try { fs.unlinkSync(f); } catch (e) { /* weg */ } }
  audit(u, 'bios-entfernt', p.system); broadcast({ t: 'library' }); return { ok: true };
});
// Emulator-Kerne (aus games/sources.json) – Liste und Nachladen
route('GET', '/api/admin/cores', { role: 'admin' }, () => {
  let src = []; try { src = JSON.parse(fs.readFileSync(SOURCES, 'utf8')).emulators || []; } catch (e) { src = []; }
  const ic = installedCores();
  return { packages: src.map((e) => ({ id: e.id, title: e.title, core: e.core || null, license: e.license, sizeMB: e.size ? Math.round(e.size / 104857.6) / 10 : null, installed: e.core ? ic.cores.has(e.core) : ic.ui, systems: SYS_LIST.filter((s) => s.core === e.core).map((s) => s.name) })) };
});

/* ---------- Spielstände (Speicherplätze je Konto und Spiel) ---------- */
const SLOTS = ['auto', '1', '2', '3', 'sram'];
const SAVE_EXT = ['.json.gz', '.bin.gz'];
const GAME_KEY = /^[a-z0-9][a-z0-9-]{0,40}$/;
function saveFile(uid, game, slot) { return path.join(SAVE_DIR, uid, game, slot + '.json.gz'); }
function checkSaveArgs(game, slot) { if (!GAME_KEY.test(game)) fail(400, 'Spiel-ID ungültig'); if (slot !== undefined && !SLOTS.includes(slot)) fail(400, 'Speicherplatz ungültig (auto, 1, 2, 3)'); }
function listSaves(uid, onlyGame) {
  const base = path.join(SAVE_DIR, uid), out = [];
  let games = []; try { games = fs.readdirSync(base); } catch (e) { return out; }
  for (const g of games) {
    if (onlyGame && g !== onlyGame) continue;
    for (const f of fs.readdirSync(path.join(base, g))) {
      const ext = SAVE_EXT.find((x) => f.endsWith(x)); if (!ext) continue;
      const slot = f.slice(0, -ext.length); let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(base, g, slot + '.meta.json'), 'utf8')); } catch (e) { /* ohne Metadaten */ }
      out.push({ game: g, slot, kind: ext === '.bin.gz' ? 'bin' : 'json', at: meta.at || fs.statSync(path.join(base, g, f)).mtimeMs, label: meta.label || '', thumb: meta.thumb || null, size: fs.statSync(path.join(base, g, f)).size });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}
route('GET', '/api/saves', {}, (req, u) => ({ saves: listSaves(u.id) }));
route('GET', '/api/saves/:game', {}, (req, u, b, res, p) => { checkSaveArgs(p.game); return { saves: listSaves(u.id, p.game) }; });
route('GET', '/api/saves/:game/:slot', {}, (req, u, b, res, p) => {
  checkSaveArgs(p.game, p.slot); const f = saveFile(u.id, p.game, p.slot);
  if (!fs.existsSync(f)) fail(404, 'Kein Spielstand in diesem Speicherplatz');
  const body = zlib.gunzipSync(fs.readFileSync(f));
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); return undefined;
});
route('PUT', '/api/saves/:game/:slot', { limit: 6 * 1024 * 1024 }, (req, u, b, res, p) => {
  checkSaveArgs(p.game, p.slot);
  if (b.state === undefined) fail(400, 'Spielstand fehlt');
  const existing = listSaves(u.id); if (existing.length >= 60 && !existing.some((x) => x.game === p.game && x.slot === p.slot)) fail(409, 'Maximal 60 Spielstände pro Konto – bitte alte löschen');
  const dir = path.dirname(saveFile(u.id, p.game, p.slot)); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify({ state: b.state, at: now() }), 'utf8'), { level: 6 });
  const tmp = saveFile(u.id, p.game, p.slot) + '.tmp'; fs.writeFileSync(tmp, gz, { mode: 0o600 }); fs.renameSync(tmp, saveFile(u.id, p.game, p.slot));
  const thumb = typeof b.thumb === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(b.thumb) && b.thumb.length < 40000 ? b.thumb : null;
  fs.writeFileSync(path.join(dir, p.slot + '.meta.json'), JSON.stringify({ at: now(), label: clean(b.label, 60), thumb }), { mode: 0o600 });
  return { saved: true, slot: p.slot, size: gz.length };
});
function binFile(uid, game, slot) { return path.join(SAVE_DIR, uid, game, slot + '.bin.gz'); }
function userSaveBytes(uid) { return listSaves(uid).reduce((a, x) => a + x.size, 0); }
route('PUT', '/api/saves/:game/:slot/bin', { raw: true }, (req, u, b, res, p, url) => new Promise((resolve, reject) => {
  try { checkSaveArgs(p.game, p.slot); } catch (e) { req.resume(); return reject(e); }
  const MAX = 160 * 1048576; if (Number(req.headers['content-length'] || 0) > MAX) { req.resume(); return reject(new HttpError(413, 'Spielstand zu groß')); }
  if (userSaveBytes(u.id) > 2048 * 1048576) { req.resume(); return reject(new HttpError(409, 'Speicherplatz für Spielstände voll (2 GB pro Konto)')); }
  const dir = path.join(SAVE_DIR, u.id, p.game); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = binFile(u.id, p.game, p.slot), tmp = target + '.tmp';
  const gz = zlib.createGzip({ level: 6 }), out = fs.createWriteStream(tmp, { mode: 0o600 }); let size = 0, failed = false;
  req.on('data', (c) => { size += c.length; if (size > MAX && !failed) { failed = true; req.unpipe(gz); gz.destroy(); out.destroy(); try { fs.unlinkSync(tmp); } catch (e) { /* weg */ } reject(new HttpError(413, 'Spielstand zu groß')); } });
  req.pipe(gz).pipe(out);
  out.on('finish', () => {
    if (failed) return; if (!size) { fs.unlinkSync(tmp); return reject(new HttpError(400, 'Spielstand ist leer')); }
    fs.renameSync(tmp, target); try { fs.unlinkSync(saveFile(u.id, p.game, p.slot)); } catch (e) { /* kein JSON-Stand */ }
    fs.writeFileSync(path.join(dir, p.slot + '.meta.json'), JSON.stringify({ at: now(), label: clean(url.searchParams.get('label'), 60), thumb: null, bytes: size }), { mode: 0o600 });
    resolve({ saved: true, slot: p.slot, size: fs.statSync(target).size, raw: size });
  });
  out.on('error', () => reject(new HttpError(500, 'Speichern fehlgeschlagen')));
}));
route('PUT', '/api/saves/:game/:slot/thumb', {}, (req, u, b, res, p) => {
  checkSaveArgs(p.game, p.slot); const mf = path.join(SAVE_DIR, u.id, p.game, p.slot + '.meta.json'); if (!fs.existsSync(mf)) fail(404, 'Kein Spielstand');
  if (typeof b.thumb !== 'string' || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(b.thumb) || b.thumb.length > 60000) fail(400, 'Vorschaubild ungültig');
  const m = JSON.parse(fs.readFileSync(mf, 'utf8')); m.thumb = b.thumb; fs.writeFileSync(mf, JSON.stringify(m), { mode: 0o600 }); return { ok: true };
});
route('GET', '/api/saves/:game/:slot/bin', {}, (req, u, b, res, p) => {
  checkSaveArgs(p.game, p.slot); const f = binFile(u.id, p.game, p.slot); if (!fs.existsSync(f)) fail(404, 'Kein Spielstand in diesem Speicherplatz');
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(f).pipe(zlib.createGunzip()).pipe(res); return undefined;
});
route('DELETE', '/api/saves/:game/:slot', {}, (req, u, b, res, p) => {
  checkSaveArgs(p.game, p.slot); let f = saveFile(u.id, p.game, p.slot); if (!fs.existsSync(f)) f = binFile(u.id, p.game, p.slot); if (!fs.existsSync(f)) fail(404, 'Kein Spielstand');
  fs.unlinkSync(f); try { fs.unlinkSync(path.join(path.dirname(f), p.slot + '.meta.json')); } catch (e) { /* ohne Metadaten */ } return { ok: true };
});
function savesSnapshot() {
  const out = []; let users = []; try { users = fs.readdirSync(SAVE_DIR); } catch (e) { return out; }
  for (const uid of users) for (const s of listSaves(uid)) {
    const dir = path.join(SAVE_DIR, uid, s.game);
    out.push({ uid, game: s.game, slot: s.slot, kind: s.kind, gz: fs.readFileSync(path.join(dir, s.slot + (s.kind === 'bin' ? '.bin.gz' : '.json.gz'))).toString('base64'), meta: (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, s.slot + '.meta.json'), 'utf8')); } catch (e) { return {}; } })() });
  }
  return out;
}
function restoreSaves(list) {
  fs.rmSync(SAVE_DIR, { recursive: true, force: true }); fs.mkdirSync(SAVE_DIR, { recursive: true, mode: 0o700 });
  for (const s of list || []) {
    if (!/^u[\w-]+$/.test(s.uid) || !GAME_KEY.test(s.game) || !SLOTS.includes(s.slot)) continue;
    const dir = path.join(SAVE_DIR, s.uid, s.game); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, s.slot + (s.kind === 'bin' ? '.bin.gz' : '.json.gz')), Buffer.from(String(s.gz), 'base64'), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, s.slot + '.meta.json'), JSON.stringify(s.meta || {}), { mode: 0o600 });
  }
}

/* Turniere */
const newRounds = () => [[null, null, null, null], [null, null], [null]];
route('GET', '/api/tournaments', {}, () => ({ tournaments: D().tournaments }));
route('POST', '/api/tournaments', { role: 'adult' }, (req, u, b) => {
  const players = (Array.isArray(b.players) ? b.players : []).map((x) => clean(x, 24)).filter(Boolean);
  if (players.length !== 8 || new Set(players).size !== 8) fail(400, 'Genau 8 verschiedene Namen eintragen');
  const t = { id: newId('t'), name: clean(b.name, 40) || 'Turnier', game: clean(b.game, 40) || '', players, rounds: newRounds(), createdBy: u.id, createdAt: now() };
  D().tournaments.unshift(t); D().tournaments.splice(20); store.save(); broadcast({ t: 'tournaments' }); return { tournament: t };
});
route('POST', '/api/tournaments/:id/result', {}, (req, u, b, res, p) => {
  const t = D().tournaments.find((x) => x.id === p.id); if (!t) fail(404, 'Turnier nicht gefunden');
  if (t.createdBy !== u.id && u.role !== 'admin') fail(403, 'Nur die Turnierleitung trägt Ergebnisse ein');
  const ri = Number(b.round), mi = Number(b.match); if (!t.rounds[ri] || t.rounds[ri][mi] === undefined) fail(400, 'Begegnung unbekannt');
  const cand = ri === 0 ? [t.players[mi * 2], t.players[mi * 2 + 1]] : [t.rounds[ri - 1][mi * 2], t.rounds[ri - 1][mi * 2 + 1]];
  if (!cand.includes(b.winner) || !b.winner) fail(400, 'Gewinner gehört nicht zur Begegnung');
  t.rounds[ri][mi] = b.winner; let idx = mi; for (let k = ri + 1; k < t.rounds.length; k++) { idx = Math.floor(idx / 2); t.rounds[k][idx] = null; }
  store.save(); broadcast({ t: 'tournaments' }); return { tournament: t };
});
route('DELETE', '/api/tournaments/:id', {}, (req, u, b, res, p) => {
  const i = D().tournaments.findIndex((x) => x.id === p.id); if (i < 0) fail(404, 'Turnier nicht gefunden');
  if (D().tournaments[i].createdBy !== u.id && u.role !== 'admin') fail(403, 'Keine Berechtigung');
  D().tournaments.splice(i, 1); store.save(); broadcast({ t: 'tournaments' }); return { ok: true };
});

/* Administration */
function deleteUser(t) {
  killSessions(t.id); leaveCouch(t.id);
  delete D().users[t.id]; delete D().favorites[t.id]; delete D().progress[t.id]; delete D().notifications[t.id]; delete D().stats[t.id];
  D().friendships = D().friendships.filter((f) => f.a !== t.id && f.b !== t.id);
  fs.rmSync(path.join(SAVE_DIR, t.id), { recursive: true, force: true });
  for (const c of Object.values(D().users)) if (c.parentId === t.id) deleteUser(c);
  store.save();
}
const admins = () => Object.values(D().users).filter((x) => x.role === 'admin' && !x.disabled);
route('GET', '/api/admin/users', { role: 'admin' }, () => ({ users: Object.values(D().users).map((x) => Object.assign(pub(x), { disabled: !!x.disabled, createdAt: x.createdAt, lastLogin: x.lastLogin || null, online: userSockets.has(x.id) })) }));
route('POST', '/api/admin/users', { role: 'admin' }, async (req, u, b) => {
  const role = ['user', 'admin'].includes(b.role) ? b.role : 'user';
  const nu = { id: newId('u'), name: validName(b.name), display: clean(b.display, 24) || String(b.name), role, pwHash: await hashPw(validPw(b.password, 8)), color: COLORS[crypto.randomInt(COLORS.length)], createdAt: new Date().toISOString(), disabled: false };
  D().users[nu.id] = nu; store.save(); audit(u, 'konto-angelegt', nu.name + ' (' + role + ')'); return { user: pub(nu) };
});
route('PATCH', '/api/admin/users/:id', { role: 'admin' }, async (req, u, b, res, p) => {
  const t = D().users[p.id]; if (!t) fail(404, 'Konto nicht gefunden'); let temp = null;
  if (b.role !== undefined) {
    if (!['user', 'admin'].includes(b.role) || t.role === 'child') fail(400, 'Rolle nicht erlaubt');
    if (t.role === 'admin' && b.role !== 'admin' && admins().length <= 1) fail(409, 'Der letzte Admin kann nicht herabgestuft werden');
    t.role = b.role; audit(u, 'rolle-geändert', t.name + ' → ' + b.role);
  }
  if (b.disabled !== undefined) {
    if (t.id === u.id) fail(409, 'Du kannst dich nicht selbst sperren');
    if (b.disabled && t.role === 'admin' && admins().length <= 1) fail(409, 'Der letzte Admin kann nicht gesperrt werden');
    t.disabled = !!b.disabled; if (t.disabled) killSessions(t.id); audit(u, t.disabled ? 'konto-gesperrt' : 'konto-entsperrt', t.name);
  }
  if (b.display !== undefined) { const dsp = clean(b.display, 24); if (!dsp) fail(400, 'Anzeigename fehlt'); audit(u, 'anzeigename-geändert', t.name + ': ' + t.display + ' → ' + dsp); t.display = dsp; }
  if (b.resetPassword) {
    temp = crypto.randomBytes(9).toString('base64url'); t.pwHash = await hashPw(temp); killSessions(t.id); audit(u, 'passwort-zurückgesetzt', t.name);
  }
  store.save(); return { user: pub(t), tempPassword: temp };
});
route('DELETE', '/api/admin/users/:id', { role: 'admin' }, (req, u, b, res, p) => {
  const t = D().users[p.id]; if (!t) fail(404, 'Konto nicht gefunden'); if (t.id === u.id) fail(409, 'Du kannst dich nicht selbst löschen');
  if (t.role === 'admin' && admins().length <= 1) fail(409, 'Der letzte Admin kann nicht gelöscht werden');
  deleteUser(t); audit(u, 'konto-gelöscht', t.name); return { ok: true };
});
route('GET', '/api/admin/settings', { role: 'admin' }, () => D().settings);
route('PUT', '/api/admin/settings', { role: 'admin' }, (req, u, b) => {
  if (b.registration !== undefined) { if (!['open', 'closed'].includes(b.registration)) fail(400, 'Wert ungültig'); D().settings.registration = b.registration; audit(u, 'registrierung', b.registration); }
  store.save(); return D().settings;
});
route('GET', '/api/admin/audit', { role: 'admin' }, () => ({ audit: D().audit.slice(-200).reverse() }));
route('GET', '/api/admin/system', { role: 'admin' }, () => {
  let disk = null;
  try { if (fs.statfsSync) { const s = fs.statfsSync(DATA); disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize }; } } catch (e) { /* nicht unterstützt */ }
  return {
    version: VERSION, node: process.version, uptime: Math.round(process.uptime()), hostname: os.hostname(),
    memory: { rss: process.memoryUsage().rss, total: os.totalmem(), free: os.freemem() }, load: os.loadavg(), disk,
    users: Object.keys(D().users).length, online: userSockets.size, sockets: sockets.size, couches: couches.size, netplayRooms: netRooms.size,
    games: Object.keys(lib()).length, cores: installedCores().cores.size, backups: store.listBackups().slice(0, 5)
  };
});
route('GET', '/api/admin/backup', { role: 'admin' }, (req, u, b, res) => {
  const name = store.backup('download'); audit(u, 'backup-erstellt', name);
  const body = JSON.stringify({ app: 'RetroHub', kind: 'server-backup', version: VERSION, createdAt: new Date().toISOString(), data: store.snapshot(false), saves: savesSnapshot() });
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="' + name + '"' });
  res.end(body); return undefined;
});
route('POST', '/api/admin/backups', { role: 'admin' }, (req, u) => { const name = store.backup('manuell'); audit(u, 'backup-erstellt', name); return { name, backups: store.listBackups() }; });
function validateBackup(b) {
  const d = b && b.data;
  if (!b || b.app !== 'RetroHub' || b.kind !== 'server-backup' || !d || typeof d.users !== 'object' || !Array.isArray(d.friendships)) fail(400, 'Datei ist kein RetroHub-Server-Backup');
  if (!Object.values(d.users).some((x) => x && x.role === 'admin' && !x.disabled)) fail(400, 'Backup enthält kein aktives Admin-Konto');
  return d;
}
route('POST', '/api/admin/restore', { role: 'admin', limit: 50 * 1024 * 1024 }, (req, u, b) => {
  const d = b && b.data;
  if (!b || b.app !== 'RetroHub' || b.kind !== 'server-backup' || !d || typeof d.users !== 'object' || !Array.isArray(d.friendships)) fail(400, 'Datei ist kein RetroHub-Server-Backup');
  if (!Object.values(d.users).some((x) => x && x.role === 'admin' && !x.disabled)) fail(400, 'Backup enthält kein aktives Admin-Konto');
  const before = store.backup('vor-restore');
  store.replace(d); if (Array.isArray(b.saves)) restoreSaves(b.saves); audit(u, 'restore', 'Sicherung vorher: ' + before + (Array.isArray(b.saves) ? ', ' + b.saves.length + ' Spielstände' : ''));
  for (const ws of sockets.keys()) ws.close(4002, 'Daten wiederhergestellt');
  for (const c of [...couches.values()]) closeCouch(c);
  return { ok: true, backupBefore: before, users: Object.keys(d.users).length };
});
/* ---------- Vollständige Sicherung: TAR mit Daten, Spielständen, Spieldateien, Covern und BIOS ---------- */
function tarHeader(name, size, type) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8'); h.write('0000640\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124); h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136);
  h.write('        ', 148); h.write(type, 156); h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0; for (const x of h) sum += x; h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148); return h;
}
function paxRecord(key, val) {
  const base = Buffer.byteLength(' ' + key + '=' + val + '\n'); let len = base + String(base).length;
  if (String(len).length !== String(base).length) len = base + String(len).length;
  return Buffer.from(len + ' ' + key + '=' + val + '\n', 'utf8');
}
const pad512 = (n) => Buffer.alloc((512 - (n % 512)) % 512);
async function tarStream(entries, out) { // entries: [{name, path}|{name, data}]
  let failed = null; out.on('error', (e) => { failed = e; });
  const write = (b) => new Promise((res, rej) => { if (failed) return rej(failed); if (out.write(b)) res(); else out.once('drain', res); });
  for (const e of entries) {
    const size = e.data ? e.data.length : fs.statSync(e.path).size;
    if (Buffer.byteLength(e.name) > 99) { const rec = paxRecord('path', e.name); await write(tarHeader('PaxHeader/' + crypto.randomBytes(4).toString('hex'), rec.length, 'x')); await write(rec); await write(pad512(rec.length)); }
    await write(tarHeader(Buffer.byteLength(e.name) > 99 ? e.name.slice(-90) : e.name, size, '0'));
    if (e.data) await write(e.data); else for await (const c of fs.createReadStream(e.path, { highWaterMark: 1 << 20 })) await write(c);
    await write(pad512(size));
  }
  await write(Buffer.alloc(1024)); out.end();
}
function backupJson() { return Buffer.from(JSON.stringify({ app: 'RetroHub', kind: 'server-backup', version: VERSION, createdAt: new Date().toISOString(), data: store.snapshot(false), saves: savesSnapshot() })); }
route('GET', '/api/admin/backup/full', { role: 'admin' }, async (req, u, b, res) => {
  const entries = [{ name: 'retrohub-backup.json', data: backupJson() }];
  for (const g of Object.values(lib())) for (const f of g.files) if (f.src !== 'folder' && fs.existsSync(path.join(LIB_DIR, f.path))) entries.push({ name: 'library/' + f.path, path: path.join(LIB_DIR, f.path) });
  if (fs.existsSync(COVER_DIR())) for (const f of fs.readdirSync(COVER_DIR())) entries.push({ name: 'library/covers/' + f, path: path.join(COVER_DIR(), f) });
  if (fs.existsSync(BIOS_DIR)) for (const f of fs.readdirSync(BIOS_DIR)) if (!f.endsWith('.tmp')) entries.push({ name: 'bios/' + f, path: path.join(BIOS_DIR, f) });
  audit(u, 'vollsicherung-heruntergeladen', entries.length + ' Einträge');
  res.writeHead(200, { 'Content-Type': 'application/x-tar', 'Content-Disposition': 'attachment; filename="retrohub-vollsicherung-' + new Date().toISOString().slice(0, 10) + '.tar"', 'Cache-Control': 'no-store' });
  await tarStream(entries, res); return undefined;
});
function readExact(fd, len, pos) { const b = Buffer.alloc(len); let got = 0; while (got < len) { const n = fs.readSync(fd, b, got, len - got, pos + got); if (!n) throw new HttpError(400, 'Archiv ist unvollständig'); got += n; } return b; }
function extractTar(file, dest) {
  const fd = fs.openSync(file, 'r'), total = fs.fstatSync(fd).size; let pos = 0, nextName = null, count = 0;
  try {
    while (pos + 512 <= total) {
      const h = readExact(fd, 512, pos); pos += 512;
      if (h.every((x) => x === 0)) break;
      const sum = h.reduce((a, x, i) => a + (i >= 148 && i < 156 ? 32 : x), 0); if (sum !== parseInt(h.slice(148, 156).toString().replace(/\0.*$/, '').trim(), 8)) throw new HttpError(400, 'Archiv ist beschädigt (Prüfsumme eines Kopfes)');
      const size = parseInt(h.slice(124, 136).toString().replace(/\0.*$/, '').trim() || '0', 8), type = String.fromCharCode(h[156] || 48);
      let name = h.slice(0, 100).toString('utf8').replace(/\0.*$/, '');
      if (type === 'x') { const rec = readExact(fd, size, pos).toString('utf8'); const m = /\d+ path=([^\n]*)\n/.exec(rec); nextName = m ? m[1] : null; pos += size + pad512(size).length; continue; }
      if (nextName) { name = nextName; nextName = null; }
      if (type !== '0' && type !== '\0' && type !== '5') { pos += size + pad512(size).length; continue; }
      const norm = path.posix.normalize(name);
      if (norm.startsWith('/') || norm.split('/').includes('..') || !(norm === 'retrohub-backup.json' || /^(library|bios)\/[^/]+(\/[^/]+)?$/.test(norm))) throw new HttpError(400, 'Unerlaubter Pfad im Archiv: ' + name.slice(0, 80));
      if (type === '5') { pos += size + pad512(size).length; continue; }
      const target = path.join(dest, norm); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o750 });
      const out = fs.openSync(target, 'w', 0o640); let left = size, p2 = pos;
      try { while (left > 0) { const n = Math.min(left, 1 << 20); fs.writeSync(out, readExact(fd, n, p2)); p2 += n; left -= n; } } finally { fs.closeSync(out); }
      pos += size + pad512(size).length; count++;
    }
  } finally { fs.closeSync(fd); }
  return count;
}
route('POST', '/api/admin/restore/full', { role: 'admin', raw: true }, (req, u) => new Promise((resolve, reject) => {
  const tmp = path.join(DATA, '.restore-' + crypto.randomBytes(6).toString('hex') + '.tar'), stage = tmp.replace(/\.tar$/, '');
  const cleanup = () => { try { fs.rmSync(tmp, { force: true }); fs.rmSync(stage, { recursive: true, force: true }); } catch (e) { /* weg */ } };
  const out = fs.createWriteStream(tmp, { mode: 0o600 }); req.pipe(out);
  req.on('error', () => { cleanup(); reject(new HttpError(400, 'Upload abgebrochen')); });
  out.on('finish', () => {
    try {
      fs.mkdirSync(stage, { mode: 0o700 }); const n = extractTar(tmp, stage);
      const jf = path.join(stage, 'retrohub-backup.json'); if (!fs.existsSync(jf)) throw new HttpError(400, 'Archiv enthält keine retrohub-backup.json');
      let b; try { b = JSON.parse(fs.readFileSync(jf, 'utf8')); } catch (e) { throw new HttpError(400, 'retrohub-backup.json ist beschädigt'); }
      const d = validateBackup(b); const before = store.backup('vor-vollrestore');
      for (const [dir, sub] of [[LIB_DIR, 'library'], [BIOS_DIR, 'bios']]) {
        const old = dir + '.alt-' + Date.now(); if (fs.existsSync(dir)) fs.renameSync(dir, old);
        if (fs.existsSync(path.join(stage, sub))) fs.renameSync(path.join(stage, sub), dir); else fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
        fs.rmSync(old, { recursive: true, force: true });
      }
      store.replace(d); if (Array.isArray(b.saves)) restoreSaves(b.saves);
      audit(u, 'vollrestore', n + ' Dateien, Sicherung vorher: ' + before);
      for (const ws of sockets.keys()) ws.close(4002, 'Daten wiederhergestellt');
      for (const c of [...couches.values()]) closeCouch(c);
      cleanup(); resolve({ ok: true, files: n, backupBefore: before, users: Object.keys(d.users).length, games: Object.keys(d.library || {}).length });
    } catch (e) { cleanup(); reject(e instanceof HttpError ? e : new HttpError(400, e.message)); }
  });
}));
/* Spiele nachladen (Hintergrundjob) */
const job = { running: false, log: [], code: null, startedAt: null };
route('GET', '/api/admin/games/job', { role: 'admin' }, () => ({ running: job.running, code: job.code, startedAt: job.startedAt, log: job.log.slice(-60) }));
route('POST', '/api/admin/games/install', { role: 'admin' }, (req, u, b) => {
  if (job.running) fail(409, 'Läuft bereits');
  const only = Array.isArray(b.only) ? b.only.filter((x) => /^[a-z0-9_-]+$/.test(x)).slice(0, 50) : [];
  Object.assign(job, { running: true, log: [], code: null, startedAt: now() });
  const ch = spawn(process.execPath, [GAMES_TOOL, 'install', '--sources', SOURCES, '--data', DATA].concat(only.length ? ['--only', only.join(',')] : []), { stdio: ['ignore', 'pipe', 'pipe'] });
  const add = (d) => { String(d).split('\n').filter(Boolean).forEach((l) => job.log.push(l)); if (job.log.length > 400) job.log.splice(0, job.log.length - 400); };
  ch.stdout.on('data', add); ch.stderr.on('data', add);
  ch.on('close', (code) => { job.running = false; job.code = code; audit(u, 'emulatoren-nachgeladen', (only.join(', ') || 'alle') + ', Exitcode ' + code); broadcast({ t: 'library' }); });
  audit(u, 'emulatoren-nachladen-gestartet', only.join(', ') || 'alle'); return { started: true };
});

/* ---------- Echtzeit: Sockets, Präsenz, Couch-Modus ---------- */
const sockets = new Map();        // ws -> { uid, couch }
const userSockets = new Map();    // uid -> Set(ws)
const couches = new Map();        // id -> Couch-Session
const userCouch = new Map();      // uid -> couchId (als Controller)
const leaveTimers = new Map();
function sendTo(uid, msg) { for (const ws of userSockets.get(uid) || []) ws.send(msg); }
function broadcast(msg, filter) { for (const [ws, s] of sockets) { const u = D().users[s.uid]; if (u && (!filter || filter(u))) ws.send(msg); } }
function pushFriends(...ids) { for (const id of ids) sendTo(id, { t: 'friends' }); }
function presence(uid, online) { for (const f of friendIds(uid)) sendTo(f, { t: 'presence', id: uid, online }); }
function lobbyTitleOf(uid) { const c = couches.get(userCouch.get(uid)); return c ? 'Couch: ' + c.gameTitle : null; }
function newCode() { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c; do { c = ''; for (let i = 0; i < 4; i++) c += A[crypto.randomInt(A.length)]; } while ([...couches.values()].some((x) => x.code === c)); return c; }
const MAX_PADS = 4;
function couchView(c) { return { id: c.id, code: c.code, hostId: c.hostId, hostName: displayOf(c.hostId), gameId: c.gameId, gameTitle: c.gameTitle, system: c.system, displays: c.displays.size, players: c.players.map((p) => ({ id: p.id, display: displayOf(p.id), color: (D().users[p.id] || {}).color, slot: p.slot, online: userSockets.has(p.id) })) }; }
function pushCouch(c) { const v = { t: 'couch', couch: couchView(c) }; for (const ws of c.displays) ws.send(v); for (const p of c.players) sendTo(p.id, v); }
function closeCouch(c) { couches.delete(c.id); for (const p of c.players) { userCouch.delete(p.id); sendTo(p.id, { t: 'couch', couch: null, closed: true }); } for (const ws of c.displays) ws.send({ t: 'couch', couch: null, closed: true, display: true }); }
function leaveCouch(uid) {
  const c = couches.get(userCouch.get(uid)); userCouch.delete(uid); if (!c) return;
  c.players = c.players.filter((p) => p.id !== uid); sendTo(uid, { t: 'couch', couch: null });
  if (!c.players.length && !c.displays.size) couches.delete(c.id); else pushCouch(c);
}
function handleWs(ws, s, m) {
  const u = D().users[s.uid]; if (!u) return ws.close(4001);
  switch (m.t) {
    case 'ping': return ws.send({ t: 'pong' });
    case 'couch.create': {
      const g = lib()[String(Number(m.gameId))]; if (!g || !canSee(u, g)) throw new Error('Spiel nicht gefunden');
      if (s.couch) { const old = couches.get(s.couch); if (old && old.hostId === u.id) closeCouch(old); }
      const c = { id: newId('c'), code: newCode(), hostId: u.id, gameId: g.id, gameTitle: g.title, system: g.system, displays: new Set([ws]), players: [], createdAt: now() };
      couches.set(c.id, c); s.couch = c.id; pushCouch(c); return;
    }
    case 'couch.attach': { const c = couches.get(m.id); if (!c || c.hostId !== u.id) throw new Error('Couch-Session nicht gefunden'); c.displays.add(ws); s.couch = c.id; pushCouch(c); return; }
    case 'couch.close': { const c = couches.get(s.couch); if (c && c.hostId === u.id) closeCouch(c); s.couch = null; return; }
    case 'couch.join': {
      const code = clean(m.code, 4).toUpperCase(); const c = [...couches.values()].find((x) => x.code === code);
      if (!c) throw new Error('Kein Couch-Spiel mit Code ' + code + ' gefunden');
      if (userCouch.get(u.id) === c.id) return pushCouch(c);
      if (userCouch.has(u.id)) leaveCouch(u.id);
      const used = new Set(c.players.map((p) => p.slot)); let slot = 0; while (used.has(slot)) slot++;
      if (slot >= MAX_PADS) throw new Error('Alle ' + MAX_PADS + ' Controller sind belegt');
      c.players.push({ id: u.id, slot }); userCouch.set(u.id, c.id); pushCouch(c); return;
    }
    case 'couch.leave': return leaveCouch(u.id);
    case 'pad': {
      const c = couches.get(userCouch.get(u.id)); if (!c) return;
      const p = c.players.find((x) => x.id === u.id); const btn = Number(m.button), val = Number(m.value);
      if (!p || !Number.isInteger(btn) || btn < 0 || btn > 23 || !Number.isFinite(val)) return;
      const msg = { t: 'pad', slot: p.slot, button: btn, value: Math.max(-32767, Math.min(32767, Math.round(val))) };
      for (const d of c.displays) d.send(msg); return;
    }
    default: throw new Error('Unbekannte Nachricht');
  }
}

/* ---------- Netplay (kompatibel zum EmulatorJS-Netplay, läuft lokal; experimentell) ---------- */
const netRooms = new Map(); // sessionid -> { domain, gameId, name, max, password, owner, players: {userid: extra}, sockets: Set }
function netRoomList(domain, gameId, u) {
  const out = {};
  for (const [sid, r] of netRooms) if (canSee(u, lib()[String(r.gameId)] || {}) && (!domain || r.domain === domain) && (gameId === undefined || String(r.gameId) === String(gameId))) out[sid] = { room_name: r.name, current: Object.keys(r.players).length, max: r.max, password: !!r.password };
  return out;
}
function setupNetplay(httpServer) {
  let IOServer; try { IOServer = require('socket.io').Server; } catch (e) { log('Netplay nicht verfügbar (socket.io fehlt)'); return; }
  // Der Netplay-Abgleich sendet den kompletten Spielzustand (PSP bis ~40 MB)
  const io = new IOServer(httpServer, { path: '/socket.io/', serveClient: false, maxHttpBufferSize: 160 * 1048576, cors: { origin: false } });
  const nsp = io.of('/netplay');
  nsp.use((socket, next) => { const u = sessionUser(socket.request); if (!u) return next(new Error('Bitte anmelden')); socket.data.uid = u.id; next(); });
  nsp.on('connection', (socket) => {
    const leave = () => {
      const sid = socket.data.room; if (!sid) return; const r = netRooms.get(sid); socket.data.room = null; if (!r) return;
      delete r.players[socket.data.userid]; r.sockets.delete(socket.id); socket.leave(sid);
      if (!r.sockets.size || socket.id === r.owner) { nsp.to(sid).disconnectSockets(); netRooms.delete(sid); }
      else nsp.to(sid).emit('users-updated', r.players);
    };
    socket.on('open-room', (data, cb) => {
      cb = typeof cb === 'function' ? cb : () => {}; const ex = data && data.extra; if (!ex || !ex.sessionid || !ex.userid) return cb('Ungültige Anfrage');
      if (netRooms.has(ex.sessionid)) return cb('Raum existiert bereits');
      const g = lib()[String(Number(ex.game_id))]; if (!g || !canSee(D().users[socket.data.uid], g)) return cb('Spiel unbekannt');
      ex.player_name = displayOf(socket.data.uid);
      netRooms.set(ex.sessionid, { domain: clean(ex.domain, 120), gameId: g.id, gameTitle: g.title, name: clean(ex.room_name, 40) || 'Raum', max: Math.max(2, Math.min(8, Number(data.maxPlayers) || 2)), password: clean(data.password, 40), owner: socket.id, ownerUid: socket.data.uid, players: { [ex.userid]: ex }, sockets: new Set([socket.id]), createdAt: now() });
      socket.data.room = ex.sessionid; socket.data.userid = ex.userid; socket.join(ex.sessionid);
      cb(null); nsp.to(ex.sessionid).emit('users-updated', netRooms.get(ex.sessionid).players);
    });
    socket.on('join-room', (data, cb) => {
      cb = typeof cb === 'function' ? cb : () => {}; const ex = data && data.extra; if (!ex) return cb('Ungültige Anfrage');
      const r = netRooms.get(ex.sessionid); if (!r || !canSee(D().users[socket.data.uid], lib()[String(r.gameId)] || {})) return cb('Raum nicht gefunden');
      if (Object.keys(r.players).length >= r.max) return cb('Raum ist voll');
      if (r.password && String(data.password || '') !== r.password) return cb('Falsches Passwort');
      ex.player_name = displayOf(socket.data.uid); r.players[ex.userid] = ex; r.sockets.add(socket.id);
      socket.data.room = ex.sessionid; socket.data.userid = ex.userid; socket.join(ex.sessionid);
      cb(null, r.players); nsp.to(ex.sessionid).emit('users-updated', r.players);
    });
    socket.on('data-message', (data) => { const sid = socket.data.room; if (sid) socket.to(sid).emit('data-message', data); });
    socket.on('leave-room', leave); socket.on('disconnect', leave);
  });
  log('Netplay aktiv (Socket.IO, Namensraum /netplay, experimentell)');
}
route('GET', '/api/netplay/rooms', {}, (req, u) => ({ rooms: [...netRooms.entries()].filter(([, r]) => canSee(u, lib()[String(r.gameId)] || {})).map(([sid, r]) => ({ id: sid, name: r.name, gameId: r.gameId, gameTitle: r.gameTitle, host: displayOf(r.ownerUid), players: Object.keys(r.players).length, max: r.max, password: !!r.password, createdAt: r.createdAt })) }));

/* ---------- HTTP-Server ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/netplay/list') {
      if (!sessionUser(req)) fail(401, 'Bitte anmelden');
      const gid = url.searchParams.get('game_id'); return send(res, 200, netRoomList(url.searchParams.get('domain'), gid === null ? undefined : gid, sessionUser(req)));
    }
    if (!url.pathname.startsWith('/api/')) fail(404, 'Nicht gefunden');
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) fail(routes.some((x) => x.re.test(url.pathname)) ? 405 : 404, 'Nicht gefunden');
    if (req.method !== 'GET' && (req.headers['x-retrohub'] !== '1' || !sameOrigin(req))) fail(403, 'Ungültige Anfrageherkunft');
    const u = sessionUser(req);
    if (r.opts.auth !== false) need(u, r.opts.role);
    const params = {}; const mm = r.re.exec(url.pathname); r.keys.forEach((k, i) => { params[k] = decodeURIComponent(mm[i + 1]); });
    const body = req.method === 'GET' || r.opts.raw ? {} : await readBody(req, r.opts.limit || 64 * 1024);
    const out = await r.fn(req, u, body, res, params, url);
    if (out !== undefined && !res.headersSent) send(res, 200, out);
  } catch (e) {
    if (!(e instanceof HttpError)) log('Fehler', req.method, url.pathname, e && e.stack);
    if (!res.headersSent) send(res, e.code || 500, { error: e instanceof HttpError ? e.message : 'Interner Fehler' });
  }
});
server.on('upgrade', (req, sock, head) => {
  const up = new URL(req.url, 'http://x').pathname;
  if (up.startsWith('/socket.io/')) return; // Netplay (Socket.IO) übernimmt selbst
  if (up !== '/ws' || !sameOrigin(req)) { sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const u = sessionUser(req); if (!u) { sock.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
  const ws = wslib.accept(req, sock, head); if (!ws) return;
  const s = { uid: u.id, couch: null }; sockets.set(ws, s);
  let set = userSockets.get(u.id); const first = !set; if (!set) userSockets.set(u.id, set = new Set()); set.add(ws);
  clearTimeout(leaveTimers.get(u.id)); leaveTimers.delete(u.id);
  if (first) presence(u.id, true);
  ws.send({ t: 'hello', user: pub(u), version: VERSION });
  ws.on('message', (m) => {
    if (limited(m && m.t === 'pad' ? 'pad:' + u.id : 'ws:' + u.id, m && m.t === 'pad' ? 300 : 60, 1000)) return;
    try { handleWs(ws, s, m); } catch (e) { ws.send({ t: 'error', message: e.message || 'Fehler' }); }
  });
  ws.on('close', () => {
    sockets.delete(ws); set.delete(ws);
    for (const c of [...couches.values()]) if (c.displays.delete(ws)) { if (!c.displays.size && !c.players.length) couches.delete(c.id); else pushCouch(c); }
    if (!set.size) {
      userSockets.delete(u.id); presence(u.id, false);
      const c = couches.get(userCouch.get(u.id)); if (c) pushCouch(c);
      leaveTimers.set(u.id, setTimeout(() => { leaveTimers.delete(u.id); if (!userSockets.has(u.id)) leaveCouch(u.id); }, Number(process.env.RETROHUB_LEAVE_GRACE || 20000)));
    }
  });
});
setInterval(() => { for (const ws of sockets.keys()) { if (!ws.alive) { ws.close(1001, 'Zeitüberschreitung'); continue; } ws.alive = false; ws.ping(); } }, 30000).unref();

/* Tägliche Sicherung */
function autoBackup() { const b = store.listBackups()[0]; const ts = b ? fs.statSync(path.join(store.backupDir, b.name)).mtimeMs : 0; if (now() - ts > 864e5) log('Automatische Sicherung:', store.backup('auto')); }
setInterval(autoBackup, 3600e3).unref();

/* Migration aus 8.x: eigene, hochgeladene ROMs werden Spiele der neuen Bibliothek (inkl. Spielstände) */
function migrateUploads() {
  const old = D().roms || {}; const keys = Object.keys(old); if (!keys.length) { delete D().roms; delete D().romsHidden; return; }
  const legacy = { nes: '.nes', gb: '.gb', gba: '.gba', nds: '.nds', psp: '.iso' };
  fs.mkdirSync(LIB_DIR, { recursive: true, mode: 0o750 });
  for (const k of keys) {
    const r = old[k]; const sys = SYS[r.system]; const src = path.join(DATA, 'roms', r.id + (r.ext || legacy[r.system] || ''));
    if (!sys || !fs.existsSync(src)) continue;
    const name = safeName(r.title) + (r.ext || legacy[r.system] || ''), rel = crypto.randomBytes(8).toString('hex') + '-' + name;
    fs.renameSync(src, path.join(LIB_DIR, rel));
    const g = newGame({ id: r.addedBy }, sys, r.title, { desc: r.desc, players: (r.players || [1, 1])[1] }); g.files.push({ name, size: r.size, sha256: r.sha256, src: 'upload', path: rel });
    try { for (const uid of fs.readdirSync(SAVE_DIR)) { const from = path.join(SAVE_DIR, uid, 'rom-' + r.id); if (fs.existsSync(from)) fs.renameSync(from, path.join(SAVE_DIR, uid, 'g' + g.id)); } } catch (e) { /* keine Spielstände */ }
    log('Migriert: ' + r.title + ' → Spiel ' + g.id);
  }
  delete D().roms; delete D().romsHidden; store.save();
}
migrateUploads();
ensureSetupCode(); autoBackup();
setupNetplay(server);
server.listen(PORT, BIND, () => log('RetroHub-Server ' + VERSION + ' auf ' + BIND + ':' + PORT + ', Daten: ' + DATA));
function shutdown() { log('Beende …'); try { clearTimeout(store.timer); store.flush(); } catch (e) { log(e); } process.exit(0); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
