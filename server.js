// Local usage dashboard server. No dependencies — Node 20+ built-ins only.
//
// Serves the static dashboard from ./public and exposes:
//   GET /api/usage   -> combined Claude + Codex + Cursor usage JSON
//   GET /api/health  -> { ok: true }
//
// All the fragile provider logic lives in ./src. The frontend just polls /api/usage.

import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getClaude } from './src/claude.js';
import { getCodex } from './src/codex.js';
import { getCursor } from './src/cursor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 4317;
const HOST = process.env.HOST || '127.0.0.1';

/** Non-loopback IPv4 addresses for LAN URL hints when binding 0.0.0.0. */
function lanIPv4Addresses() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

// Filesystem scans are cheap but not free; cache the aggregate briefly so a
// 30s-polling browser (or several tabs) doesn't re-walk the logs every request.
const AGG_TTL_MS = 15 * 1000;
let _aggCache = null;
let _aggAt = 0;
// Coalesce concurrent /api/usage builds. Without this, a slow Claude/Codex
// JSONL scan + browser/SwiftBar polling stampedes into N parallel full walks
// (GBs of parse work) and the process never finishes — UI stuck on Loading.
let _aggInflight = null;

async function buildUsage() {
  const now = Date.now();
  if (_aggCache && now - _aggAt < AGG_TTL_MS) return _aggCache;
  if (_aggInflight) return _aggInflight;

  _aggInflight = (async () => {
    try {
      const [claude, codex, cursor] = await Promise.all([
        getClaude().catch((err) => ({ provider: 'claude', label: 'Claude', available: false, error: String(err) })),
        getCodex().catch((err) => ({ provider: 'codex', label: 'Codex', available: false, error: String(err) })),
        getCursor().catch((err) => ({ provider: 'cursor', label: 'Cursor', available: false, error: String(err) })),
      ]);

      const payload = { generatedAt: new Date().toISOString(), providers: { claude, codex, cursor } };
      _aggCache = payload;
      _aggAt = Date.now();
      return payload;
    } finally {
      _aggInflight = null;
    }
  })();

  return _aggInflight;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

async function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  if (urlPath === '/') urlPath = '/index.html';
  // Prevent path traversal.
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === '/api/usage') {
      const payload = await buildUsage();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
      return;
    }
    await serveStatic(req, res);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
  }
});

server.listen(PORT, HOST, () => {
  const localUrl = `http://${HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST}:${PORT}`;
  console.log(`\n  AI Usage Dashboard`);
  console.log(`  Local:   ${localUrl}`);
  if (HOST === '0.0.0.0' || HOST === '::') {
    const lan = lanIPv4Addresses();
    if (lan.length) {
      for (const ip of lan) console.log(`  Network: http://${ip}:${PORT}`);
    } else {
      console.log(`  Network: (no LAN IPv4 found; still listening on ${HOST}:${PORT})`);
    }
    console.log(`\n  Bound to ${HOST} — reachable on your LAN. Anyone on the network can`);
    console.log(`  open the URLs above (this reads local AI credentials / usage).`);
  } else if (HOST === '127.0.0.1' || HOST === '::1') {
    console.log(`\n  Localhost-only. For other machines: HOST=0.0.0.0 npm start`);
  }
  console.log('\n  Press Ctrl+C to stop.\n');
});
