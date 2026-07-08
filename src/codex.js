// Codex (OpenAI ChatGPT plan) usage reader.
//
// Primary, no-network source: the per-turn rate-limit snapshot Codex persists to
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
// Each turn writes an event_msg with payload.type === "token_count", whose payload
// carries both info.total_token_usage and a `rate_limits` object:
//   primary   -> 5-hour window  (window_minutes 300)
//   secondary -> weekly window  (window_minutes 10080)
// each with used_percent and resets_at (unix epoch seconds).
//
// We deliberately do NOT call the live chatgpt.com/backend-api endpoint or refresh
// the OAuth token: refreshing independently races Codex's own refresh-token rotation
// and can revoke the login. The persisted snapshot is fresh enough (updated every
// turn Codex runs) and needs no auth.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readJsonlLines, listFilesRecursive, safeStat } from './util.js';

const CODEX_DIR = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const SESSIONS_DIR = path.join(CODEX_DIR, 'sessions');

// How far back to scan rollout files when hunting for the freshest rate-limit
// snapshot. Recent Codex builds sometimes write `rate_limits: null`, so we may
// need to walk back through several recent files.
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

// Return the newest rollout files first, limited to the lookback window, so we can
// stop as soon as we find a non-null rate-limit snapshot.
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

function extractRateLimits(obj) {
  // token_count events may appear as {type:'event_msg', payload:{type:'token_count', rate_limits, info}}
  const payload = obj?.payload && typeof obj.payload === 'object' ? obj.payload : obj;
  if (!payload) return null;
  const rl = payload.rate_limits;
  if (!rl || typeof rl !== 'object') return null;
  const primary = normalizeWindow(rl.primary);
  const secondary = normalizeWindow(rl.secondary);
  if (!primary && !secondary) return null;
  return {
    fiveHour: primary,
    weekly: secondary,
    planType: rl.plan_type ?? null,
    capturedAt: obj?.timestamp ? Date.parse(obj.timestamp) || null : null,
  };
}

// Walk newest -> oldest lines within a file, since the latest snapshot is at the end.
async function latestRateLimitInFile(file) {
  const lines = await readJsonlLines(file);
  for (let i = lines.length - 1; i >= 0; i--) {
    const rl = extractRateLimits(lines[i]);
    if (rl) return rl;
  }
  return null;
}

export async function getCodexRateLimits() {
  const files = await recentRolloutFiles();
  for (const f of files) {
    const rl = await latestRateLimitInFile(f);
    if (rl) return rl;
  }
  return null;
}

// Aggregate token usage from rollout token_count events across a rolling window.
// total_token_usage in each event is cumulative *for that session*, so we take the
// max per session file and sum across sessions in the window.
export async function getCodexTokenUsage({ days = 30 } = {}) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let files;
  try {
    files = await listFilesRecursive(SESSIONS_DIR, (name) => name.endsWith('.jsonl'));
  } catch {
    return { totalTokens: 0, inputTokens: 0, outputTokens: 0, sessions: 0, daily: {} };
  }

  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cachedInputTokens = 0;
  let sessions = 0;
  const daily = {}; // yyyy-mm-dd -> total tokens

  for (const f of files) {
    const st = await safeStat(f);
    if (!st || st.mtimeMs < cutoff) continue;
    const lines = await readJsonlLines(f);
    // Find the last token_count with total_token_usage (cumulative for the session).
    let last = null;
    let lastTs = null;
    for (const obj of lines) {
      const payload = obj?.payload && typeof obj.payload === 'object' ? obj.payload : obj;
      const info = payload?.info;
      const ttu = info?.total_token_usage;
      if (ttu && typeof ttu.total_tokens === 'number') {
        last = ttu;
        lastTs = obj?.timestamp || lastTs;
      }
    }
    if (!last) continue;
    sessions += 1;
    totalTokens += last.total_tokens || 0;
    inputTokens += last.input_tokens || 0;
    outputTokens += last.output_tokens || 0;
    reasoningTokens += last.reasoning_output_tokens || 0;
    cachedInputTokens += last.cached_input_tokens || 0;
    const day = (lastTs ? new Date(lastTs) : new Date(st.mtimeMs)).toISOString().slice(0, 10);
    daily[day] = (daily[day] || 0) + (last.total_tokens || 0);
  }

  return { totalTokens, inputTokens, outputTokens, reasoningTokens, cachedInputTokens, sessions, daily };
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
