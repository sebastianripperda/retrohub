#!/usr/bin/env node
'use strict';
/* RetroHub-Verwaltung auf Kommandozeile (im Container als root):
     retrohub-cli list-users
     retrohub-cli reset-password <benutzername>   setzt ein Einmalpasswort
     retrohub-cli setup-code                      zeigt den Einrichtungscode (solange es kein Konto gibt)
   Der Dienst wird für Änderungen kurz angehalten, damit keine Schreibvorgänge kollidieren. */
const fs = require('fs'); const path = require('path'); const crypto = require('crypto'); const { execFileSync } = require('child_process');
const DATA = process.env.RETROHUB_DATA || '/var/lib/retrohub'; const DB = path.join(DATA, 'data', 'db.json');
const [cmd, arg] = process.argv.slice(2);
const svc = (a) => { try { execFileSync('systemctl', [a, 'retrohub'], { stdio: 'ignore' }); return true; } catch (e) { return false; } };
const load = () => JSON.parse(fs.readFileSync(DB, 'utf8'));
if (cmd === 'setup-code') { try { console.log(fs.readFileSync(path.join(DATA, 'data', 'setup-code'), 'utf8').trim()); } catch (e) { console.log('Kein Einrichtungscode – es existiert bereits ein Konto.'); } process.exit(0); }
if (cmd === 'list-users') { const d = load(); for (const u of Object.values(d.users)) console.log(u.name.padEnd(24), u.role.padEnd(6), u.disabled ? 'gesperrt' : 'aktiv', u.display); process.exit(0); }
if (cmd === 'reset-password' && arg) {
  const wasActive = svc('is-active'); if (wasActive) svc('stop');
  try {
    const d = load(); const u = Object.values(d.users).find((x) => x.name === arg.toLowerCase()); if (!u) { console.error('Konto nicht gefunden'); process.exit(1); }
    const pw = crypto.randomBytes(9).toString('base64url'); const salt = crypto.randomBytes(16);
    const k = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    u.pwHash = ['scrypt', 16384, 8, 1, salt.toString('base64'), k.toString('base64')].join('$'); u.disabled = false;
    for (const [s, v] of Object.entries(d.sessions)) if (v.userId === u.id) delete d.sessions[s];
    d.audit.push({ at: new Date().toISOString(), actor: 'cli', action: 'passwort-zurückgesetzt', detail: u.name });
    fs.writeFileSync(DB + '.tmp', JSON.stringify(d), { mode: 0o600 }); fs.renameSync(DB + '.tmp', DB);
    try { execFileSync('chown', ['retrohub:retrohub', DB]); } catch (e) { /* Testumgebung */ }
    console.log('Neues Einmalpasswort für ' + u.name + ': ' + pw);
  } finally { if (wasActive) svc('start'); }
  process.exit(0);
}
console.log('Aufruf: retrohub-cli list-users | reset-password <name> | setup-code'); process.exit(1);
