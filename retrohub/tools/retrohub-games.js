#!/usr/bin/env node
'use strict';
/* RetroHub-Spielepakete: laden, in Quarantäne prüfen, freigeben.
   Befehle:
     install [--sources F] [--data DIR] [--mirror URL] [--cache DIR] [--only a,b]
     verify  [--data DIR]          installierte Spiele gegen Manifest prüfen
     list    [--sources F] [--data DIR]
     hash    <verzeichnis>         Inhalts-Prüfsumme berechnen (für Paketpflege)
   Prüfungen: feste Commit-Version, Inhalts-Prüfsumme (SHA-256 über alle Dateien), keine absoluten Pfade,
   kein "..", keine Links, Größen- und Dateianzahlgrenze, Einstiegsdatei vorhanden. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2); const cmd = args[0];
const opt = (k, d) => { const i = args.indexOf('--' + k); return i > 0 ? args[i + 1] : d; };
const ROOT = path.join(__dirname, '..');
const SOURCES = opt('sources', path.join(ROOT, 'games', 'sources.json'));
const DATA = opt('data', process.env.RETROHUB_DATA || '/var/lib/retrohub');
const GAMES = path.join(DATA, 'games'); const QUAR = path.join(DATA, 'quarantine');
const CACHE = opt('cache', path.join(DATA, 'games-cache')); const MANIFEST = path.join(DATA, 'games-manifest.json');
const MIRROR = opt('mirror', process.env.RETROHUB_GAMES_MIRROR || '');
const ROMS = path.join(DATA, 'roms'); const ROM_MANIFEST = path.join(DATA, 'roms-manifest.json');
const ROM_SYSTEMS = { nes: { ext: '.nes', max: 4 * 1024 * 1024, magic: 'NES\x1a' } };
const EMU = path.join(DATA, 'emu'); const EMU_MANIFEST = path.join(DATA, 'emu-manifest.json');
const MAX_BYTES = 80 * 1024 * 1024, MAX_FILES = 6000;
const say = (...a) => console.log(...a);

function contentHash(dir) {
  const files = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const p = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name;
      if (e.isSymbolicLink()) throw new Error('Link im Paket: ' + r);
      if (e.isDirectory()) walk(p, r); else if (e.isFile()) files.push([r, p]);
    }
  }(dir, ''));
  files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const h = crypto.createHash('sha256'); let bytes = 0;
  for (const [r, p] of files) { const buf = fs.readFileSync(p); bytes += buf.length; h.update(crypto.createHash('sha256').update(buf).digest('hex') + '  ' + r + '\n'); }
  return { hash: h.digest('hex'), files: files.length, bytes };
}
function readManifest() { try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch (e) { return { schema: 1, games: [] }; } }
function writeManifest(m) { const tmp = MANIFEST + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(m, null, 1), { mode: 0o644 }); fs.renameSync(tmp, MANIFEST); }
function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }

function download(url, dest, redirects) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : url.startsWith('http:') ? http : null;
    if (!mod) return reject(new Error('Nur http/https erlaubt: ' + url));
    const req = mod.get(url, { headers: { 'User-Agent': 'RetroHub-Games/9.0' }, timeout: 60000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume(); if ((redirects || 0) >= 5) return reject(new Error('Zu viele Weiterleitungen'));
        return resolve(download(new URL(res.headers.location, url).toString(), dest, (redirects || 0) + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' für ' + url)); }
      let size = 0; const out = fs.createWriteStream(dest + '.part', { mode: 0o644 });
      res.on('data', (c) => { size += c.length; if (size > MAX_BYTES) { req.destroy(new Error('Archiv größer als ' + MAX_BYTES / 1048576 + ' MB')); } });
      res.pipe(out);
      out.on('finish', () => { fs.renameSync(dest + '.part', dest); resolve(size); });
      res.on('error', reject); out.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung beim Download')));
    req.on('error', (e) => { try { fs.unlinkSync(dest + '.part'); } catch (x) { /* nichts */ } reject(e); });
  });
}

function checkTarListing(archive) {
  const out = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const lines = out.split('\n').filter(Boolean); if (lines.length > MAX_FILES) throw new Error('Zu viele Dateien (' + lines.length + ')');
  for (const l of lines) {
    const type = l[0];
    if (type === 'l' || type === 'h') throw new Error('Archiv enthält Links: ' + l.slice(0, 120));
    if (!['-', 'd'].includes(type)) throw new Error('Unerwarteter Eintragstyp: ' + l.slice(0, 120));
  }
  const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
  for (const n of names) if (n.startsWith('/') || n.split('/').includes('..')) throw new Error('Unsicherer Pfad im Archiv: ' + n);
  const tops = new Set(names.map((n) => n.split('/')[0])); if (tops.size !== 1) throw new Error('Archiv hat kein eindeutiges Wurzelverzeichnis');
  return [...tops][0];
}

const EXT_RE = [/<script[^>]+src\s*=\s*["'](?:https?:)?\/\/[^"']+/gi, /<link[^>]+href\s*=\s*["'](?:https?:)?\/\/[^"']+/gi, /@import\s+url\(\s*["']?(?:https?:)?\/\/[^)"']+/gi];
function scanExternal(dir) {
  const hits = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(html?|css)$/i.test(e.name) && fs.statSync(p).size < 2e6) {
        const t = fs.readFileSync(p, 'utf8');
        for (const re of EXT_RE) for (const m of t.match(re) || []) hits.push(path.relative(dir, p) + ': ' + m.replace(/\s+/g, ' ').slice(0, 100));
      }
    }
  }(dir));
  return [...new Set(hits)].slice(0, 20);
}
function normalizePerms(dir) {
  (function walk(d) { fs.chmodSync(d, 0o755); for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else fs.chmodSync(p, 0o644); } }(dir));
}

async function installOne(src, manifest) {
  const prev = manifest.games.find((g) => g.id === src.id);
  if (prev && prev.contentHash === src.contentHash && fs.existsSync(path.join(GAMES, src.id, src.entry))) { say('  = ' + src.title + ': bereits installiert'); return 'skip'; }
  if (!/^[a-z0-9-]+$/.test(src.id) || !/^[0-9a-f]{40}$/.test(src.commit) || !/^[0-9a-f]{64}$/.test(src.contentHash)) throw new Error('Quellenangabe unvollständig oder ungültig');
  fs.mkdirSync(CACHE, { recursive: true });
  const archive = path.join(CACHE, src.id + '-' + src.commit + '.tar.gz');
  if (!fs.existsSync(archive)) {
    const url = MIRROR ? MIRROR.replace(/\/$/, '') + '/' + src.id + '-' + src.commit + '.tar.gz' : 'https://codeload.github.com/' + src.repo + '/tar.gz/' + src.commit;
    say('  ↓ ' + src.title + ': lade ' + url);
    const size = await download(url, archive); say('    ' + (size / 1048576).toFixed(1) + ' MB geladen');
  } else say('  ↻ ' + src.title + ': aus Zwischenspeicher ' + archive);
  const top = checkTarListing(archive);
  const q = path.join(QUAR, src.id + '-' + crypto.randomBytes(4).toString('hex')); fs.mkdirSync(q, { recursive: true });
  try {
    execFileSync('tar', ['-xzf', archive, '-C', q, '--no-same-owner', '--no-same-permissions']);
    const dir = path.join(q, top);
    for (const ex of src.exclude || []) { if (ex.includes('..') || ex.startsWith('/')) throw new Error('Ungültige Ausschlussregel'); rmrf(path.join(dir, ex)); }
    const ch = contentHash(dir);
    if (ch.hash !== src.contentHash) { try { fs.unlinkSync(archive); } catch (e) { /* weg */ } throw new Error('Inhalts-Prüfsumme stimmt nicht (erwartet ' + src.contentHash.slice(0, 12) + '…, erhalten ' + ch.hash.slice(0, 12) + '…) – Paket abgelehnt'); }
    if (!fs.existsSync(path.join(dir, src.entry))) throw new Error('Einstiegsdatei fehlt: ' + src.entry);
    const warnings = scanExternal(dir);
    normalizePerms(dir);
    fs.mkdirSync(GAMES, { recursive: true }); fs.chmodSync(GAMES, 0o755);
    const target = path.join(GAMES, src.id), old = target + '.old';
    rmrf(old); if (fs.existsSync(target)) fs.renameSync(target, old);
    fs.renameSync(dir, target); rmrf(old);
    manifest.games = manifest.games.filter((g) => g.id !== src.id);
    manifest.games.push({ id: src.id, title: src.title, entry: src.entry, repo: src.repo, commit: src.commit, license: src.license, contentHash: ch.hash, files: ch.files, bytes: ch.bytes, warnings, installedAt: new Date().toISOString() });
    writeManifest(manifest);
    say('  ✔ ' + src.title + ': geprüft und freigegeben (' + ch.files + ' Dateien, ' + (ch.bytes / 1048576).toFixed(1) + ' MB' + (warnings.length ? ', ' + warnings.length + ' externe Verweise – werden durch CSP blockiert' : '') + ')');
    return 'ok';
  } finally { rmrf(q); }
}


function readRomManifest() { try { return JSON.parse(fs.readFileSync(ROM_MANIFEST, 'utf8')); } catch (e) { return { schema: 1, roms: [] }; } }
function writeRomManifest(m) { const tmp = ROM_MANIFEST + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(m, null, 1), { mode: 0o644 }); fs.renameSync(tmp, ROM_MANIFEST); }
async function installRom(src, manifest) {
  const sys = ROM_SYSTEMS[src.system]; if (!sys) throw new Error('System nicht unterstützt: ' + src.system);
  if (!/^[a-z0-9_-]+$/.test(src.id) || !/^[0-9a-f]{64}$/.test(src.sha256)) throw new Error('Quellenangabe ungültig');
  const target = path.join(ROMS, src.id + sys.ext);
  const prev = manifest.roms.find((r) => r.id === src.id);
  if (prev && prev.sha256 === src.sha256 && fs.existsSync(target)) { say('  = ' + src.title + ' (ROM): bereits installiert'); return 'skip'; }
  fs.mkdirSync(CACHE, { recursive: true }); fs.mkdirSync(QUAR, { recursive: true, mode: 0o700 });
  const cached = path.join(CACHE, src.id + '-' + src.sha256.slice(0, 12) + sys.ext);
  if (!fs.existsSync(cached)) {
    const url = MIRROR ? MIRROR.replace(/\/$/, '') + '/' + src.id + '-' + src.sha256.slice(0, 12) + sys.ext : src.url;
    say('  ↓ ' + src.title + ' (ROM): lade ' + url); await download(url, cached);
  } else say('  ↻ ' + src.title + ' (ROM): aus Zwischenspeicher');
  const q = path.join(QUAR, src.id + '-' + crypto.randomBytes(4).toString('hex') + sys.ext);
  fs.copyFileSync(cached, q);
  try {
    const buf = fs.readFileSync(q);
    if (buf.length > sys.max) throw new Error('ROM zu groß');
    if (buf.slice(0, 4).toString('binary') !== sys.magic) throw new Error('Kein gültiger ROM-Dateikopf');
    const h = crypto.createHash('sha256').update(buf).digest('hex');
    if (h !== src.sha256) { try { fs.unlinkSync(cached); } catch (e) { /* weg */ } throw new Error('Prüfsumme stimmt nicht (erwartet ' + src.sha256.slice(0, 12) + '…, erhalten ' + h.slice(0, 12) + '…) – ROM abgelehnt'); }
    fs.mkdirSync(ROMS, { recursive: true, mode: 0o750 });
    fs.renameSync(q, target); fs.chmodSync(target, 0o640);
    manifest.roms = manifest.roms.filter((r) => r.id !== src.id);
    manifest.roms.push({ id: src.id, title: src.title, system: src.system, cat: src.cat, desc: src.desc, players: src.players, license: src.license, source: src.source, sha256: h, size: buf.length, installedAt: new Date().toISOString() });
    writeRomManifest(manifest);
    say('  ✔ ' + src.title + ' (ROM): geprüft und freigegeben (' + (buf.length / 1024).toFixed(0) + ' KB)'); return 'ok';
  } finally { rmrf(q); }
}


function readEmuManifest() { try { return JSON.parse(fs.readFileSync(EMU_MANIFEST, 'utf8')); } catch (e) { return { schema: 1, packages: [] }; } }
async function installEmu(src, manifest) {
  if (!/^[a-z0-9_-]+$/.test(src.id) || !/^[0-9a-f]{64}$/.test(src.sha256)) throw new Error('Quellenangabe ungültig');
  const prev = manifest.packages.find((p) => p.id === src.id);
  const patchId = src.patches && src.patches.length ? crypto.createHash('sha256').update(JSON.stringify(src.patches)).digest('hex').slice(0, 16) : null;
  if (prev && prev.sha256 === src.sha256 && (prev.patchId || null) === patchId && src.files.every((f) => fs.existsSync(path.join(EMU, 'ejs', f.to)))) { say('  = ' + src.title + ': bereits installiert'); return 'skip'; }
  fs.mkdirSync(CACHE, { recursive: true }); fs.mkdirSync(QUAR, { recursive: true, mode: 0o700 });
  const cached = path.join(CACHE, src.id + '-' + src.sha256.slice(0, 12) + '.tgz');
  if (!fs.existsSync(cached)) {
    const url = MIRROR ? MIRROR.replace(/\/$/, '') + '/' + src.id + '-' + src.sha256.slice(0, 12) + '.tgz' : src.url;
    say('  ↓ ' + src.title + ': lade ' + url); await download(url, cached);
  } else say('  ↻ ' + src.title + ': aus Zwischenspeicher');
  const h = crypto.createHash('sha256').update(fs.readFileSync(cached)).digest('hex');
  if (h !== src.sha256) { try { fs.unlinkSync(cached); } catch (e) { /* weg */ } throw new Error('Prüfsumme stimmt nicht (erwartet ' + src.sha256.slice(0, 12) + '…, erhalten ' + h.slice(0, 12) + '…) – abgelehnt'); }
  checkTarListing(cached);
  const q = path.join(QUAR, src.id + '-' + crypto.randomBytes(4).toString('hex')); fs.mkdirSync(q, { recursive: true });
  try {
    execFileSync('tar', ['-xzf', cached, '-C', q, '--no-same-owner', '--no-same-permissions']);
    for (const f of src.files) {
      if (f.from.includes('..') || f.to.includes('..')) throw new Error('Ungültiger Pfad');
      const from = path.join(q, f.from), to = path.join(EMU, 'ejs', f.to);
      if (!fs.existsSync(from)) throw new Error('Datei fehlt im Paket: ' + f.from);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (fs.statSync(from).isDirectory()) { rmrf(to); fs.renameSync(from, to); normalizePerms(to); }
      else { fs.copyFileSync(from, to); fs.chmodSync(to, 0o644); }
    }
    // RetroHub-Korrekturen (z. B. Netplay): nur anwenden, wenn jede Fundstelle genau einmal vorkommt
    for (const pt of src.patches || []) {
      if (String(pt.file).includes('..')) throw new Error('Ungültiger Patch-Pfad');
      const fp = path.join(EMU, 'ejs', pt.file); let txt = fs.readFileSync(fp, 'utf8');
      const n = txt.split(pt.find).length - 1;
      if (n !== 1) throw new Error('Korrektur „' + pt.title + '“ passt nicht (' + n + ' Fundstellen statt 1) – abgelehnt');
      txt = txt.replace(pt.find, () => pt.replace); fs.writeFileSync(fp, txt); fs.chmodSync(fp, 0o644);
      say('    Korrektur angewendet: ' + pt.title);
    }
    (function fix(d) { fs.chmodSync(d, 0o755); for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) fix(path.join(d, e.name)); }(EMU));
    manifest.packages = manifest.packages.filter((p) => p.id !== src.id);
    manifest.packages.push({ id: src.id, title: src.title, core: src.core || null, license: src.license, sha256: h, patchId, installedAt: new Date().toISOString() });
    const tmp = EMU_MANIFEST + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(manifest, null, 1), { mode: 0o644 }); fs.renameSync(tmp, EMU_MANIFEST);
    say('  ✔ ' + src.title + ': geprüft und freigegeben'); return 'ok';
  } finally { rmrf(q); }
}

async function main() {
  if (cmd === 'hash') { const r = contentHash(args[1]); say(r.hash, r.files + ' Dateien', r.bytes + ' Bytes'); return 0; }
  const sources = JSON.parse(fs.readFileSync(SOURCES, 'utf8')).games;
  if (cmd === 'list') {
    const m = readManifest();
    for (const s of sources) { const i = m.games.find((g) => g.id === s.id); say((i ? '✔ ' : '· ') + s.id.padEnd(16) + s.title.padEnd(22) + s.license.padEnd(12) + (i ? 'installiert ' + i.installedAt : 'nicht installiert')); }
    const rm = readRomManifest(); for (const s of JSON.parse(fs.readFileSync(SOURCES, 'utf8')).roms || []) { const i = rm.roms.find((r) => r.id === s.id); say((i ? '✔ ' : '· ') + (s.id + ' (ROM)').padEnd(16) + s.title.padEnd(22) + s.license.padEnd(12) + (i ? 'installiert ' + i.installedAt : 'nicht installiert')); }
    return 0;
  }
  if (cmd === 'verify') {
    const m = readManifest(); let bad = 0;
    for (const g of m.games) { let ok = false; try { ok = contentHash(path.join(GAMES, g.id)).hash === g.contentHash; } catch (e) { ok = false; } say((ok ? '✔ ' : '✘ ') + g.id + (ok ? '' : ' – verändert oder beschädigt')); if (!ok) bad++; }
    for (const r of readRomManifest().roms) { let okr = false; try { okr = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROMS, r.id + '.' + 'nes'))).digest('hex') === r.sha256; } catch (e) { okr = false; } say((okr ? '✔ ' : '✘ ') + r.id + ' (ROM)' + (okr ? '' : ' – verändert oder beschädigt')); if (!okr) bad++; }
    return bad ? 2 : 0;
  }
  if (cmd !== 'install') { say('Aufruf: retrohub-games.js install|verify|list|hash'); return 1; }
  const only = (opt('only', '') || '').split(',').filter(Boolean);
  fs.mkdirSync(QUAR, { recursive: true, mode: 0o700 });
  const manifest = readManifest(); let ok = 0, skip = 0; const failed = [];
  say('Spielepakete: ' + sources.length + ' Quellen' + (MIRROR ? ', Spiegel ' + MIRROR : ''));
  for (const s of sources) {
    if (only.length && !only.includes(s.id)) continue;
    try { const r = await installOne(s, manifest); if (r === 'ok') ok++; else skip++; }
    catch (e) { failed.push(s.id); say('  ✘ ' + s.title + ': ' + e.message); }
  }
  const emuSources = JSON.parse(fs.readFileSync(SOURCES, 'utf8')).emulators || [];
  if (emuSources.length) {
    say('Emulatoren: ' + emuSources.length);
    const em = readEmuManifest();
    for (const s of emuSources) {
      if (only.length && !only.includes(s.id)) continue;
      try { const r = await installEmu(s, em); if (r === 'ok') ok++; else skip++; }
      catch (e) { failed.push(s.id); say('  ✘ ' + s.title + ': ' + e.message); }
    }
  }
  const romSources = JSON.parse(fs.readFileSync(SOURCES, 'utf8')).roms || [];
  if (romSources.length) {
    say('ROM-Quellen: ' + romSources.length);
    const rm = readRomManifest();
    for (const s of romSources) {
      if (only.length && !only.includes(s.id)) continue;
      try { const r = await installRom(s, rm); if (r === 'ok') ok++; else skip++; }
      catch (e) { failed.push(s.id); say('  ✘ ' + s.title + ' (ROM): ' + e.message); }
    }
  }
  say('Ergebnis: ' + ok + ' neu, ' + skip + ' vorhanden, ' + failed.length + ' fehlgeschlagen' + (failed.length ? ' (' + failed.join(', ') + ')' : ''));
  return failed.length ? 2 : 0;
}
main().then((c) => process.exit(c), (e) => { console.error('FEHLER: ' + e.message); process.exit(1); });
