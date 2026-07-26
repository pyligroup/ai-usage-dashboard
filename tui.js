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
  const opts = { compact: false, once: false, tools: ALL_PROVIDERS.slice(), color: null, interval: REFRESH_MS };
  for (const arg of argv) {
    if (arg === '--compact' || arg === '-c') opts.compact = true;
    else if (arg === '--once' || arg === '-1' || arg === '--no-watch') opts.once = true;
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
        --tools=a,b      Providers to show: claude, codex, cursor
        --interval=SEC   Refresh interval when watching (default 30)
        --color          Force ANSI color   --no-color   Disable it
    -h, --help           This message

  While watching:  q / Ctrl-C quit  ·  r refresh now  ·  c toggle compact

  Reads a running dashboard server at ${SERVER_URL} when available,
  otherwise loads the same provider modules directly.

  Running several of these at once? Start \`npm start\` first. Every TUI then
  shares that one server's cache — cheap, and the live Claude/Cursor endpoints
  get hit once for everybody instead of once per instance.
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

let state = { payload: null, source: null, error: false, nextRefreshAt: 0, compact: opts.compact };

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

let refreshTimer = null;
let tickTimer = null;
let exiting = false;

function cleanup() {
  if (exiting) return;
  exiting = true;
  clearInterval(refreshTimer);
  clearInterval(tickTimer);
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
    await refresh();
    // --once (or piped output): one frame, then exit with the connection status.
    process.exit(state.error ? 1 : 0);
  }

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

  draw(); // paint the header immediately; data lands on the first refresh
  await refresh();

  refreshTimer = setInterval(refresh, opts.interval);
  // Repaint every second so the countdown and reset timers stay live between
  // fetches — the same cadence as the web countdown.
  tickTimer = setInterval(draw, 1000);
}

main().catch((err) => {
  cleanup();
  process.stderr.write(`ai-usage-dashboard tui: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
