#!/usr/bin/env node
// VonFrey Browser Bridge — 原生消息宿主
// 双向：① 与 Edge 扩展走 stdio（native messaging 帧）
//       ② 与 Agent 走 Unix socket（不开 TCP 端口）
const net = require('net');
const fs = require('fs');

const SOCK = '/tmp/edgebridge.sock';
let nextId = 1;
const pending = new Map();   // id -> socket

// ---------- native messaging 帧 ----------
function writeFrame(obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(buf.length, 0);
  process.stdout.write(head);
  process.stdout.write(buf);
}

let inbuf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  inbuf = Buffer.concat([inbuf, chunk]);
  while (inbuf.length >= 4) {
    const len = inbuf.readUInt32LE(0);
    if (inbuf.length < 4 + len) break;
    const body = inbuf.subarray(4, 4 + len).toString('utf8');
    inbuf = inbuf.subarray(4 + len);
    let msg;
    try { msg = JSON.parse(body); } catch { continue; }
    try { require('fs').appendFileSync('/tmp/bridge_trace.log', new Date().toISOString()+' FROM_EXT '+body+'\n'); } catch {}
    if (msg.id === 0 && msg.ok === undefined) {
      // 纯事件帧（__tabs_event 等，无 ok 字段）：广播给所有连接
      for (const s of serverConnections) { try { s.write(JSON.stringify(msg) + '\n'); } catch {} }
      return;
    }
    if (msg.id === 0) {
      // __hello 的响应：给所有连接也发一份（任一 client 都能读到握手结果）
      for (const s of serverConnections) { try { s.write(JSON.stringify(msg) + '\n'); } catch {} }
      return;
    }
    const sock = pending.get(msg.id);
    if (sock) {
      pending.delete(msg.id);
      try { sock.write(JSON.stringify(msg) + '\n'); } catch {}
    }
  }
});

process.stdin.on('end', () => { cleanup(); process.exit(0); });

// ---------- agent 侧 Unix socket ----------
function cleanup() {
  try { fs.unlinkSync(SOCK); } catch {}
}
cleanup();

const serverConnections = new Set();
const server = net.createServer((sock) => {
  serverConnections.add(sock);
  sock.on('close', () => serverConnections.delete(sock));
  let buf = '';
  sock.on('data', (d) => {
    buf += d.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let req;
      try { req = JSON.parse(line); } catch { sock.write(JSON.stringify({ ok:false, error:'bad json' })+'\n'); continue; }
      const id = nextId++;
      pending.set(id, sock);
      writeFrame({ id, method: req.method, params: req.params || {}, match: req.match || null });
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); try { sock.write(JSON.stringify({ ok:false, error:'timeout' })+'\n'); } catch {} }
      }, 30000);
    }
  });
  sock.on('error', () => {});
});

server.listen(SOCK, () => {
  try { fs.chmodSync(SOCK, 0o600); } catch {}
});
server.on('error', () => { process.exit(1); });

process.on('SIGTERM', () => { cleanup(); process.exit(0); });
