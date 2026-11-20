'use strict';
// Kleine JSON-Datenbank mit atomaren Schreibvorgängen (tmp + fsync + rename) und täglicher Sicherung.
const fs = require('fs');
const path = require('path');

const EMPTY = () => ({
  schema: 1, settings: { registration: 'closed', createdAt: new Date().toISOString() },
  users: {}, sessions: {}, favorites: {}, progress: {}, stats: {}, friendships: [],
  messages: {}, notifications: {}, tournaments: [], audit: [], roms: {}, romsHidden: []
});

class Store {
  constructor(dir) {
    this.dir = dir; this.file = path.join(dir, 'db.json'); this.backupDir = path.join(dir, 'backups');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.mkdirSync(this.backupDir, { recursive: true, mode: 0o700 });
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : EMPTY();
    const base = EMPTY(); for (const k of Object.keys(base)) if (this.data[k] === undefined) this.data[k] = base[k];
    this.timer = null; this.flush();
  }
  save() { if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 150); }
  flush() {
    const tmp = this.file + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, JSON.stringify(this.data)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.file);
  }
  snapshot(includeSessions) { const d = JSON.parse(JSON.stringify(this.data)); if (!includeSessions) d.sessions = {}; return d; }
  backup(reason) {
    const name = 'retrohub-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + reason + '.json';
    const file = path.join(this.backupDir, name);
    fs.writeFileSync(file, JSON.stringify({ app: 'RetroHub', kind: 'server-backup', createdAt: new Date().toISOString(), data: this.snapshot(false) }), { mode: 0o600 });
    const all = fs.readdirSync(this.backupDir).filter((f) => f.endsWith('.json')).sort();
    while (all.length > 14) fs.unlinkSync(path.join(this.backupDir, all.shift()));
    return name;
  }
  listBackups() {
    return fs.readdirSync(this.backupDir).filter((f) => f.endsWith('.json')).sort().reverse()
      .map((f) => ({ name: f, size: fs.statSync(path.join(this.backupDir, f)).size }));
  }
  replace(data) {
    const base = EMPTY(); for (const k of Object.keys(base)) if (data[k] === undefined) data[k] = base[k];
    data.sessions = {}; this.data = data; this.flush();
  }
}
module.exports = { Store };
