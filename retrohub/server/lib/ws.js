'use strict';
// Minimaler WebSocket-Server nach RFC 6455 (nur Textframes, Ping/Pong, Close). Keine Fremdpakete.
const crypto = require('crypto');
const { EventEmitter } = require('events');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 64 * 1024;

class Socket extends EventEmitter {
  constructor(sock) {
    super();
    this.sock = sock; this.buf = Buffer.alloc(0); this.frag = null; this.open = true; this.alive = true;
    sock.setNoDelay(true);
    sock.on('data', (d) => this._onData(d));
    sock.on('close', () => this._closed());
    sock.on('error', () => this._closed());
  }
  _closed() { if (!this.open) return; this.open = false; this.emit('close'); }
  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    if (this.buf.length > MAX_PAYLOAD * 2 + 16) return this.close(1009, 'zu groß');
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; const hi = this.buf.readUInt32BE(2); len = this.buf.readUInt32BE(6); off = 10; if (hi) return this.close(1009, 'zu groß'); }
      if (!masked) return this.close(1002, 'Client-Frames müssen maskiert sein');
      if (len > MAX_PAYLOAD) return this.close(1009, 'zu groß');
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const data = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      if (op === 0x8) { this.close(1000); return; }
      if (op === 0x9) { this._send(0xA, data); continue; }
      if (op === 0xA) { this.alive = true; continue; }
      if (op === 0x1 || op === 0x2) { if (fin) this._msg(data); else this.frag = [data]; continue; }
      if (op === 0x0 && this.frag) {
        this.frag.push(data);
        if (this.frag.reduce((s, b) => s + b.length, 0) > MAX_PAYLOAD) return this.close(1009, 'zu groß');
        if (fin) { const all = Buffer.concat(this.frag); this.frag = null; this._msg(all); }
        continue;
      }
      return this.close(1002, 'Protokollfehler');
    }
  }
  _msg(data) { let m; try { m = JSON.parse(data.toString('utf8')); } catch (e) { return; } if (m && typeof m === 'object') this.emit('message', m); }
  _send(op, payload) {
    if (!this.open) return;
    const len = payload.length; let head;
    if (len < 126) head = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
    try { this.sock.write(Buffer.concat([head, payload])); } catch (e) { this._closed(); }
  }
  send(obj) { this._send(0x1, Buffer.from(JSON.stringify(obj), 'utf8')); }
  ping() { this._send(0x9, Buffer.alloc(0)); }
  close(code = 1000, reason = '') {
    if (!this.open) return;
    const r = Buffer.from(reason, 'utf8'); const p = Buffer.alloc(2 + r.length); p.writeUInt16BE(code, 0); r.copy(p, 2);
    this._send(0x8, p); this.open = false; this.emit('close');
    setTimeout(() => { try { this.sock.destroy(); } catch (e) { /* bereits zu */ } }, 100);
  }
}

function accept(req, sock, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13') {
    sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return null;
  }
  const accepted = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accepted + '\r\n\r\n');
  const ws = new Socket(sock);
  if (head && head.length) ws._onData(head);
  return ws;
}
module.exports = { accept };
