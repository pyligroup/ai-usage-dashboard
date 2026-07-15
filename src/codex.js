// Codex (OpenAI ChatGPT plan) usage reader.
//
// Primary, no-network source: the per-turn rate-limit snapshot Codex persists to
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
// Each turn writes an event_msg with payload.type === "token_count", whose payload
// carries both info.total_token_usage and a `rate_limits` object with `primary` /
// `secondary` windows (used_percent, resets_at as unix epoch seconds, and
// window_minutes). Historically:
//   primary   -> 5-hour window  (window_minutes 300)
//   secondary -> weekly window  (window_minutes 10080)
// Recent Codex builds sometimes put the weekly window in `primary` with
// `secondary: null` — classify by window_minutes, not slot name.
//
// As of ~2026-07-12 OpenAI temporarily removed the 5-hour usage limit for some
// plans; newest snapshots may be weekly-only (primary.window_minutes 10080,
// secondary null). Do NOT backfill a missing fiveHour from an older same-day
// snapshot that still had window_minutes 300 — that stale 100% is misleading.
// Walk newest→oldest until the first non-null rate_limits object, then take
// only the windows present there. When 5h returns in a recent payload, it
// shows again via window_minutes classification.
//
// We deliberately do NOT call the live chatgpt.com/backend-api endpoint or refresh
// the OAuth token: refreshing independently races Codex's own refresh-token rotation
// and can revoke the login. The persisted snapshot is only as fresh as the last
// Codex run that *wrote* a rollout — `codex exec --ephemeral` (and anything else
// that skips session persistence) still burns plan quota server-side but leaves
// no local rate_limits for us to read. Needs no auth; never invent a live %.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readJsonlLines, listFilesRecursive, safeStat } from './util.js';

const CODEX_DIR = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const SESSIONS_DIR = path.join(CODEX_DIR, 'sessions');

// How far back to scan rollout files for the newest non-null rate_limits.
// Recent Codex builds sometimes write `rate_limits: null`, so we may need to
// walk back through several recent files/events before finding a usable blob.
const LOOKBACK_DAYS = 14;

function normalizeWindow(win) {
  if (!win || typeof win !== 'object') return null;
  const used = typeof win.used_percent === 'number' ? win.used_percent : null;
  if (used === null) return null;
  // resets_at is unix epoch seconds; older schema used resets_in_seconds.
  let resetsAt = null;
  if (typeof win.resets_at === 'number') {
    resetsAt = win.resets_at * 1000;
  } else if (typeof win.resets_in_seconds === 'number') {
    resetsAt = Date.now() + win.resets_in_seconds * 1000;
  }
  return {
    usedPercent: used,
    windowMinutes: typeof win.window_minutes === 'number' ? win.window_minutes : null,
    resetsAt,
  };
}

// Return the newest rollout files first, limited to the lookback window, so we
// can stop at the first non-null rate_limits object.
async function recentRolloutFiles() {
  let files;
  try {
    files = await listFilesRecursive(SESSIONS_DIR, (name) => name.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const withStat = [];
  for (const f of files) {
    const st = await safeStat(f);
    if (st && st.mtimeMs >= cutoff) withStat.push({ f, mtimeMs: st.mtimeMs });
  }
  withStat.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withStat.map((x) => x.f);
}

// Map primary/secondary slots into fiveHour / weekly using window_minutes when
// present. Slot names alone are unreliable after Codex started writing weekly
// (10080) into `primary` with `secondary: null`.
function classifyWindows(primary, secondary) {
  const byMinutes = (mins) =>
    [primary, secondary].find((w) => w && w.windowMinutes === mins) || null;
  let fiveHour = byMinutes(300);
  let weekly = byMinutes(10080);

  if (!fiveHour && !weekly) {
    // No recognizable window_minutes — fall back to historical slot mapping.
    return { fiveHour: primary, weekly: secondary };
  }
  // Don't reassign a window already classified by minutes into the wrong label.
  if (!fiveHour && primary && primary.windowMinutes !== 10080) fiveHour = primary;
  if (!weekly && secondary && secondary.windowMinutes !== 300) weekly = secondary;
  return { fiveHour, weekly };
}

function extractRateLimits(obj) {
  // token_count events may appear as {type:'event_msg', payload:{type:'token_count', rate_limits, info}}
  const payload = obj?.payload && typeof obj.payload === 'object' ? obj.payload : obj;
  if (!payload) return null;
  const rl = payload.rate_limits;
  if (!rl || typeof rl !== 'object') return null;
  const primary = normalizeWindow(rl.primary);
  const secondary = normalizeWindow(rl.secondary);
  if (!primary && !secondary) return null;
  const { fiveHour, weekly } = classifyWindows(primary, secondary);
  return {
    fiveHour,
    weekly,
    planType: rl.plan_type ?? null,
    capturedAt: obj?.timestamp ? Date.parse(obj.timestamp) || null : null,
  };
}

// Take fiveHour / weekly from the newest non-null rate_limits only (newest→
// oldest across files and within each file). Skip `rate_limits: null` and keep
// walking, but do NOT backfill a missing window from an older snapshot — a
// weekly-only payload means fiveHour is absent (null), not "use yesterday's
// 5h at 100%". When OpenAI restores the 5-hour window, a recent payload with
// window_minutes 300 will populate fiveHour again. `capturedAt` / planType
// come from that same newest usable snapshot.
export async function getCodexRateLimits() {
  const files = await recentRolloutFiles();

  for (const f of files) {
    const lines = await readJsonlLines(f);
    for (let i = lines.length - 1; i >= 0; i--) {
      const rl = extractRateLimits(lines[i]);
      if (!rl) continue; // rate_limits null / unparseable — try older event
      if (!rl.fiveHour && !rl.weekly) continue;
      return {
        fiveHour: rl.fiveHour || null,
        weekly: rl.weekly || null,
        planType: rl.planType ?? null,
        capturedAt: rl.capturedAt,
      };
    }
  }

  return null;
}

// Fields on Codex total_token_usage / last_token_usage that we aggregate.
const USAGE_FIELDS = [
  'total_tokens',
  'input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'cached_input_tokens',
];

function emptyUsage() {
  return {
    total_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    cached_input_tokens: 0,
  };
}

// Non-negative field-wise delta between two cumulative usage snapshots.
function usageDelta(curr, prev) {
  const out = emptyUsage();
  for (const k of USAGE_FIELDS) {
    out[k] = Math.max(0, (curr?.[k] || 0) - (prev?.[k] || 0));
  }
  return out;
}

function addUsage(acc, delta) {
  for (const k of USAGE_FIELDS) acc[k] = (acc[k] || 0) + (delta[k] || 0);
}

// Aggregate token usage from rollout token_count events across a rolling window.
// total_token_usage is cumulative *for that session*. Taking the final total for
// any file whose mtime falls in the window over-counts resumed/long-running
// sessions that started before the cutoff. Instead we walk events and sum
// in-window deltas (last cumulative in window minus last cumulative before it).
export async function getCodexTokenUsage({ days = 30 } = {}) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let files;
  try {
    files = await listFilesRecursive(SESSIONS_DIR, (name) => name.endsWith('.jsonl'));
  } catch {
    return { totalTokens: 0, inputTokens: 0, outputTokens: 0, sessions: 0, daily: {} };
  }

  const sessionAcc = emptyUsage();
  let sessions = 0;
  const daily = {}; // yyyy-mm-dd -> total tokens

  for (const f of files) {
    const st = await safeStat(f);
    // mtime gate: sessions with no activity in the window can't contribute.
    // Resumed sessions bump mtime, so they still get scanned; deltas below
    // exclude pre-window cumulative totals.
    if (!st || st.mtimeMs < cutoff) continue;
    const lines = await readJsonlLines(f);

    let prev = null; // last cumulative snapshot (may be before cutoff)
    let sawInWindow = false;
    const fileAcc = emptyUsage();

    for (const obj of lines) {
      const payload = obj?.payload && typeof obj.payload === 'object' ? obj.payload : obj;
      const ttu = payload?.info?.total_token_usage;
      if (!ttu || typeof ttu.total_tokens !== 'number') continue;

      const tsMs = obj?.timestamp ? Date.parse(obj.timestamp) || null : null;
      // Missing timestamps: treat as in-window (file already passed the mtime gate).
      const inWindow = tsMs == null || tsMs >= cutoff;

      if (inWindow) {
        // No prior snapshot → session started in-window; take the cumulative as-is.
        // Otherwise add only the growth since the previous event (which may be
        // the last pre-cutoff baseline).
        const delta = prev ? usageDelta(ttu, prev) : pickUsage(ttu);
        addUsage(fileAcc, delta);
        const day = new Date(tsMs || st.mtimeMs).toISOString().slice(0, 10);
        daily[day] = (daily[day] || 0) + (delta.total_tokens || 0);
        sawInWindow = true;
      }
      prev = ttu;
    }

    if (!sawInWindow) continue;
    // Count a session only when it contributed tokens inside the window.
    if ((fileAcc.total_tokens || 0) <= 0) continue;
    sessions += 1;
    addUsage(sessionAcc, fileAcc);
  }

  return {
    totalTokens: sessionAcc.total_tokens,
    inputTokens: sessionAcc.input_tokens,
    outputTokens: sessionAcc.output_tokens,
    reasoningTokens: sessionAcc.reasoning_output_tokens,
    cachedInputTokens: sessionAcc.cached_input_tokens,
    sessions,
    daily,
  };
}

function pickUsage(ttu) {
  const out = emptyUsage();
  for (const k of USAGE_FIELDS) out[k] = ttu?.[k] || 0;
  return out;
}

export async function getCodexAccountInfo() {
  // plan_type is on the rate-limit snapshot; fall back to auth.json claim if needed.
  try {
    const authRaw = await fs.readFile(path.join(CODEX_DIR, 'auth.json'), 'utf8');
    const auth = JSON.parse(authRaw);
    const mode = auth.auth_mode || null;
    return { authMode: mode, accountId: auth?.tokens?.account_id || null };
  } catch {
    return { authMode: null, accountId: null };
  }
}

export async function getCodex() {
  const [rateLimits, tokens, account] = await Promise.all([
    getCodexRateLimits(),
    getCodexTokenUsage({ days: 30 }),
    getCodexAccountInfo(),
  ]);
  return {
    provider: 'codex',
    label: 'Codex',
    available: !!(rateLimits || tokens.sessions > 0),
    planType: rateLimits?.planType || null,
    rateLimits, // { fiveHour, weekly, planType, capturedAt } | null
    tokens, // aggregate token usage
    account,
    source: rateLimits ? 'local-rollout' : 'local-tokens-only',
  };
}
