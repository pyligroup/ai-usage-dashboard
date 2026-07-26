// Local usage dashboard server. No dependencies — Node 20+ built-ins only.
//
// Serves the static dashboard from ./public and exposes:
//   GET /api/usage         -> combined Claude + Codex + Cursor usage JSON
//   GET /api/usage/stream  -> same payload pushed over SSE on one shared cadence
//   GET /api/health        -> { ok: true }
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

// ---------- shared usage stream (SSE) ----------
//
// Terminal clients subscribe here instead of polling. The server owns ONE
// refresh cadence and pushes the same frame to every subscriber at the same
// instant, so N panes can't drift onto different sides of the cache boundary
// and show different numbers — which is exactly what independent 30s timers did.
//
// /api/usage stays a plain poll endpoint for the browser and macOS clients;
// this is purely additive.
const STREAM_INTERVAL_MS = 30 * 1000;
// Heartbeat between broadcasts. SSE comment lines (": ...") carry no data and
// are ignored by the client parser, but they prove the connection is alive —
// which is the only way a client can tell a healthy idle stream from a
// half-open socket that will never error. Also prunes dead subscribers early,
// since a failed write is what reveals them.
const STREAM_HEARTBEAT_MS = 10 * 1000;
/** @type {Set<{res: import('node:http').ServerResponse}>} */
const subscribers = new Set();
let streamTimer = null;
let heartbeatTimer = null;
let _lastFrame = null;

function frameFor(payload) {
  return {
    ...payload,
    // Tell clients when the next push lands so their countdowns agree with the
    // server's cadence instead of each running its own clock.
    nextRefreshAt: Date.now() + STREAM_INTERVAL_MS,
    streamIntervalMs: STREAM_INTERVAL_MS,
  };
}

function writeEvent(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

async function broadcast() {
  if (!subscribers.size) return;
  let payload;
  try {
    payload = await buildUsage();
  } catch (err) {
    for (const sub of subscribers) writeEvent(sub.res, 'error', { error: String(err) });
    return;
  }
  const frame = frameFor(payload);
  _lastFrame = frame;
  for (const sub of subscribers) {
    if (!writeEvent(sub.res, 'usage', frame)) subscribers.delete(sub);
  }
}

// The broadcast timer only runs while someone is listening — an idle dashboard
// server shouldn't be scanning the filesystem or hitting live endpoints.
function ensureStreamTimer() {
  if (!subscribers.size) return;
  if (!streamTimer) {
    streamTimer = setInterval(() => {
      broadcast().catch(() => {});
    }, STREAM_INTERVAL_MS);
    if (streamTimer.unref) streamTimer.unref();
  }
  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(() => {
      for (const sub of subscribers) {
        try {
          sub.res.write(': hb\n\n');
        } catch {
          subscribers.delete(sub);
        }
      }
      stopStreamTimerIfIdle();
    }, STREAM_HEARTBEAT_MS);
    if (heartbeatTimer.unref) heartbeatTimer.unref();
  }
}

function stopStreamTimerIfIdle() {
  if (subscribers.size) return;
  if (streamTimer) {
    clearInterval(streamTimer);
    streamTimer = null;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

async function handleStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Some proxies/stacks hold the first bytes; a comment flushes headers.
  res.write(': connected\n\n');

  const sub = { res };
  subscribers.add(sub);
  ensureStreamTimer();

  const drop = () => {
    subscribers.delete(sub);
    stopStreamTimerIfIdle();
  };
  req.on('close', drop);
  req.on('error', drop);
  res.on('error', drop);

  // Send immediately so a joining pane paints at once rather than waiting up to
  // a full interval. Reuses the cache, so a second pane joining costs nothing.
  try {
    const payload = await buildUsage();
    const frame = frameFor(payload);
    _lastFrame = frame;
    writeEvent(res, 'usage', frame);
  } catch (err) {
    writeEvent(res, 'error', { error: String(err) });
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
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
    // Shared push stream for terminal clients — see handleStream().
    if (url.pathname === '/api/usage/stream') {
      await handleStream(req, res);
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
