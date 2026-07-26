#!/usr/bin/env node
// Terminal view of the usage dashboard — same data, same labels, ANSI instead
// of DOM. Zero dependencies (Node 20+ built-ins only), matching the rest of
// the project.
//
//   node tui.js               live-refreshing full detail (Ctrl-C / q to quit)
//   node tui.js --compact     bars-only, for a narrow tmux/herdr pane
//   node tui.js --once        print one frame and exit (pipeable)
//   node tui.js --tools=claude,cursor
//
// Data source: if a dashboard server is already listening it fetches
// /api/usage (sharing the server's ~15s cache); otherwise it calls the same
// src/ provider modules directly. Either way the numbers are identical to the
// browser's — this file adds no provider logic of its own, per the design rule
// in CLAUDE.md.

import process from 'node:process';
import { renderDashboard, setColorEnabled, ALL_PROVIDERS } from './src/tui.js';

const REFRESH_MS = 30 * 1000;
const PORT = Number(process.env.PORT) || 4317;

// Resolve the host the server is reachable at. Wildcards (0.0.0.0, ::) mean
// "all interfaces" — connect over loopback instead. server.js accepts HOST=::,
// so this has to handle IPv6 or the TUI silently falls back to slow direct
// reads against a server that is actually running.
function resolveHost(raw) {
  const h = (raw || '').trim();
  if (!h || h === '0.0.0.0' || h === '::' || h === '[::]') return '127.0.0.1';
  return h;
}

// IPv6 literals must be bracketed in a URL authority ("::1" -> "[::1]"),
// otherwise the colons are parsed as the port separator and `new URL()` throws.
function hostForUrl(h) {
  if (h.startsWith('[')) return h;
  return h.includes(':') ? `[${h}]` : h;
}

const HOST = resolveHost(process.env.HOST);
const SERVER_URL = `http://${hostForUrl(HOST)}:${PORT}/api/usage`;

// ---------- args ----------
function parseArgs(argv) {
  const opts = {
    compact: false,
    once: false,
    noServer: false,
    tools: ALL_PROVIDERS.slice(),
    color: null,
    interval: REFRESH_MS,
  };
  for (const arg of argv) {
    if (arg === '--compact' || arg === '-c') opts.compact = true;
    else if (arg === '--once' || arg === '-1' || arg === '--no-watch') opts.once = true;
    else if (arg === '--no-server') opts.noServer = true;
    else if (arg === '--no-color') opts.color = false;
    else if (arg === '--color') opts.color = true;
    else if (arg.startsWith('--tools=')) {
      const list = arg
        .slice('--tools='.length)
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => ALL_PROVIDERS.includes(s));
      // Never leave the view empty — fall back to all, same rule as the cookie.
      if (list.length) opts.tools = list;
    } else if (arg.startsWith('--interval=')) {
      const n = Number(arg.slice('--interval='.length));
      if (Number.isFinite(n) && n >= 5) opts.interval = n * 1000;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    }
  }
  return opts;
}

const HELP = `
  AI Usage Dashboard — terminal view

  Usage: node tui.js [options]         (or: npm run tui -- [options])

    -c, --compact        Bars-only layout (mirrors the web "Compact view")
    -1, --once           Print one frame and exit instead of watching
        --no-server      Don't auto-start the shared server; read locally
        --tools=a,b      Providers to show: claude, codex, cursor
        --interval=SEC   Poll interval when not streaming (default 30)
        --color          Force ANSI color   --no-color   Disable it
    -h, --help           This message

  While watching:  q / Ctrl-C quit  ·  r refresh now  ·  c toggle compact

  Shared source of truth: a single dashboard server owns every provider call
  and pushes one frame to all connected panes, so multiple terminals show the
  same numbers at the same instant instead of drifting on separate timers.
  The first TUI starts that server if it isn't already running (it keeps
  running after this pane exits, serving the others; \`--no-server\` opts out
  and reads local files in this process instead).
`;

const opts = parseArgs(process.argv.slice(2));

if (opts.help) {
  process.stdout.write(HELP + '\n');
  process.exit(0);
}

// Color on only for a real TTY, unless forced. Honors NO_COLOR (no-color.org).
const useColor =
  opts.color != null ? opts.color : Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
setColorEnabled(useColor);

// ---------- data ----------
// Direct provider modules are imported lazily: when the server is up we never
// need them, and importing them eagerly would pay the module cost for nothing.
let directLoader = null;
async function loadDirect() {
  if (!directLoader) {
    directLoader = Promise.all([
      import('./src/claude.js'),
      import('./src/codex.js'),
      import('./src/cursor.js'),
    ]).then(([claude, codex, cursor]) => ({ ...claude, ...codex, ...cursor }));
  }
  return directLoader;
}

async function fetchFromServer() {
  // Short timeout: if the server is slow or absent, fall back rather than hang.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(SERVER_URL, { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchDirect() {
  const { getClaude, getCodex, getCursor } = await loadDirect();
  // Same shape and same per-provider error containment as server.js buildUsage().
  const [claude, codex, cursor] = await Promise.all([
    getClaude().catch((err) => ({ provider: 'claude', label: 'Claude', available: false, error: String(err) })),
    getCodex().catch((err) => ({ provider: 'codex', label: 'Codex', available: false, error: String(err) })),
    getCursor().catch((err) => ({ provider: 'cursor', label: 'Cursor', available: false, error: String(err) })),
  ]);
  return { generatedAt: new Date().toISOString(), providers: { claude, codex, cursor } };
}

async function getUsage() {
  try {
    const payload = await fetchFromServer();
    // Server-backed: this TUI shares the server's ~15s aggregate cache and its
    // per-provider throttles with every other client (browser, other TUIs,
    // SwiftBar). One set of live calls covers all of them.
    return { payload, source: `via ${HOST}:${PORT} · shared cache` };
  } catch {
    // Direct: this process owns its own module-level caches, so a second
    // instance duplicates the filesystem scan and the live endpoint calls.
    // `npm start` is the fix — the hint says so rather than silently costing.
    const payload = await fetchDirect();
    return { payload, source: 'reading local files directly · run `npm start` to share one cache' };
  }
}

// Set once teardown starts, so the stream's reconnect loop and any in-flight
// retry stop rescheduling. Declared here because connectStream() below reads it.
let exiting = false;

// ---------- shared server lifecycle ----------
async function serverIsUp() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(`http://${hostForUrl(HOST)}:${PORT}/api/health`, {
      cache: 'no-store',
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Start the shared dashboard server if nothing is listening yet.
 *
 * The server is the single source of truth: it owns every provider call, the
 * caches, and the one broadcast cadence all panes render from. Auto-starting it
 * means the first TUI you open bootstraps the shared process and the rest just
 * subscribe — rather than each pane fetching independently on its own timer.
 *
 * Detached + unref'd so it survives this pane and keeps serving the others.
 * That is a process outliving its terminal, so we say so in the footer and
 * `--no-server` opts out entirely.
 *
 * @returns {Promise<'already-running'|'started'|'failed'|'skipped'>}
 */
async function ensureServer() {
  if (opts.noServer) return 'skipped';
  if (await serverIsUp()) return 'already-running';

  try {
    const { spawn } = await import('node:child_process');
    const serverPath = new URL('./server.js', import.meta.url).pathname;
    const child = spawn(process.execPath, [serverPath], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PORT: String(PORT), HOST },
    });
    child.unref();
  } catch {
    return 'failed';
  }

  // Wait for it to accept connections rather than assuming it's ready.
  for (let i = 0; i < 40; i++) {
    if (await serverIsUp()) return 'started';
    await new Promise((r) => setTimeout(r, 250));
  }
  return 'failed';
}

// ---------- usage stream (SSE) ----------
// Subscribe to the server's shared broadcast instead of polling. Every pane
// receives the same frame at the same instant, so panes can't drift onto
// different sides of the cache boundary and disagree.
let streamAbort = null;
let streamRetryTimer = null;

function stopStream() {
  if (streamAbort) {
    streamAbort.abort();
    streamAbort = null;
  }
  if (streamRetryTimer) {
    clearTimeout(streamRetryTimer);
    streamRetryTimer = null;
  }
}

function scheduleStreamRetry(onFrame, delayMs) {
  if (exiting) return;
  if (streamRetryTimer) clearTimeout(streamRetryTimer);
  streamRetryTimer = setTimeout(() => {
    streamRetryTimer = null;
    connectStream(onFrame).catch(() => {});
  }, delayMs);
}

/**
 * Open the SSE stream and invoke onFrame(payload) for each pushed frame.
 * Resolves once connected; reconnects with backoff if the server goes away.
 */
async function connectStream(onFrame, attempt = 0) {
  if (exiting) return false;
  stopStream();
  const ctrl = new AbortController();
  streamAbort = ctrl;

  let res;
  try {
    res = await fetch(`http://${hostForUrl(HOST)}:${PORT}/api/usage/stream`, {
      cache: 'no-store',
      signal: ctrl.signal,
      headers: { Accept: 'text/event-stream' },
    });
    if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
  } catch {
    // Server down or restarting — back off, then try again. Capped so a long
    // outage doesn't spin, and the poll fallback keeps the pane alive meanwhile.
    scheduleStreamRetry(onFrame, Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)));
    return false;
  }

  // Consume the event stream in the background; this function's job is done
  // once the connection is open.
  (async () => {
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        // SSE frames are separated by a blank line.
        let sep;
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          let event = 'message';
          const dataLines = [];
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
            // ':' comment lines (keep-alive) are ignored.
          }
          if (!dataLines.length) continue;
          try {
            const data = JSON.parse(dataLines.join('\n'));
            if (event === 'usage') onFrame(data);
          } catch {
            /* ignore malformed frame; the next one will arrive */
          }
        }
      }
    } catch {
      /* stream ended or aborted — handled below */
    }
    if (!exiting && streamAbort === ctrl) {
      scheduleStreamRetry(onFrame, 1000);
    }
  })();

  return true;
}

// ---------- terminal ----------
const ALT_ON = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';
const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
const HOME_CLEAR = '\x1b[H\x1b[2J\x1b[3J';

const isTTY = Boolean(process.stdout.isTTY);
const watching = !opts.once && isTTY;

function termWidth() {
  return process.stdout.columns || 100;
}

let state = {
  payload: null,
  source: null,
  error: false,
  nextRefreshAt: 0,
  compact: opts.compact,
  serverStartedByUs: false,
};

function draw() {
  const lines = renderDashboard(state.payload, {
    width: termWidth(),
    compact: state.compact,
    tools: opts.tools,
    now: Date.now(),
    nextRefreshAt: watching ? state.nextRefreshAt : 0,
    watch: watching,
    error: state.error,
    source: state.source,
  });
  if (watching) {
    // Redraw the whole frame in one write so the terminal never shows a
    // half-painted dashboard.
    process.stdout.write(HOME_CLEAR + lines.join('\n') + '\n');
  } else {
    process.stdout.write(lines.join('\n') + '\n');
  }
}

async function refresh() {
  state.nextRefreshAt = Date.now() + opts.interval;
  try {
    const { payload, source } = await getUsage();
    state.payload = payload;
    state.source = source;
    state.error = false;
  } catch (err) {
    state.error = true;
    state.source = String(err && err.message ? err.message : err);
  }
  draw();
}

/**
 * Apply a frame pushed by the shared server. The server sends nextRefreshAt so
 * every pane's countdown matches its cadence rather than each running its own.
 */
function applyFrame(frame) {
  state.payload = frame;
  state.error = false;
  state.nextRefreshAt = frame.nextRefreshAt || Date.now() + opts.interval;
  state.source = state.serverStartedByUs
    ? `via ${HOST}:${PORT} · shared stream (started here)`
    : `via ${HOST}:${PORT} · shared stream`;
  draw();
}

let refreshTimer = null;
let tickTimer = null;

function cleanup() {
  if (exiting) return;
  exiting = true;
  clearInterval(refreshTimer);
  clearInterval(tickTimer);
  // Drop the SSE subscription so the server can stop its broadcast timer once
  // the last pane goes away.
  stopStream();
  if (watching) {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(CURSOR_SHOW + ALT_OFF);
  }
}

process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    cleanup();
    process.exit(0);
  });
}

async function main() {
  if (!watching) {
    // One-shot: don't start a background server for a single frame — use
    // whatever is already running, else read locally.
    await refresh();
    process.exit(state.error ? 1 : 0);
  }

  // Bootstrap the shared source of truth before painting, so the first frame
  // already comes from the server rather than this process.
  const serverState = await ensureServer();
  state.serverStartedByUs = serverState === 'started';

  process.stdout.write(ALT_ON + CURSOR_HIDE);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (key) => {
      if (key === 'q' || key === '') {
        cleanup();
        process.exit(0);
      } else if (key === 'r') {
        refresh();
      } else if (key === 'c') {
        state.compact = !state.compact;
        draw();
      }
    });
  }

  process.stdout.on('resize', draw);

  draw(); // paint the header immediately; data lands on the first frame

  // Prefer the shared stream: one server owns the fetching, every pane renders
  // the same pushed frame. Polling stays as the fallback when there's no server
  // (--no-server, or a start that failed).
  const streamed = !opts.noServer && (await connectStream(applyFrame));

  if (!streamed) {
    await refresh();
    refreshTimer = setInterval(refresh, opts.interval);
  }

  // Repaint every second so the countdown and reset timers stay live between
  // frames — the same cadence as the web countdown.
  tickTimer = setInterval(draw, 1000);
}

main().catch((err) => {
  cleanup();
  process.stderr.write(`ai-usage-dashboard tui: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
