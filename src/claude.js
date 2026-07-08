// Claude Code (Anthropic subscription) usage reader.
//
// Two layers:
//   1. LIVE rate-limit % via the undocumented endpoint the /usage meter uses:
//        GET https://api.anthropic.com/api/oauth/usage
//        headers: Authorization: Bearer <oauth accessToken>
//                 anthropic-beta: oauth-2025-04-20
//                 User-Agent: claude-code/<version>   (a real UA is REQUIRED; a
//                 missing/fake one lands you in an aggressively 429'd bucket)
//      Returns five_hour.utilization, seven_day.utilization (+ resets_at each),
//      and a limits[] array. Undocumented + version-fragile -> allowed to fail.
//   2. STABLE local token totals summed from ~/.claude/projects/**/<session>.jsonl
//      assistant-message `message.usage` blocks. Always available, no network.
//
// The OAuth token is read from the same place Claude Code stores it (pass-through
// auth, no separate login):
//   macOS         -> Keychain generic password, service "Claude Code-credentials"
//   Linux/Windows -> ~/.claude/.credentials.json
// Shape: { claudeAiOauth: { accessToken, refreshToken, expiresAt(ms), scopes,
//                           subscriptionType, rateLimitTier } }

import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { listFilesRecursive, readJsonlLines, safeStat } from './util.js';

const execFileP = promisify(execFile);

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';

// Poll the live endpoint no more than this often; it 429s aggressive callers.
const MIN_ENDPOINT_INTERVAL_MS = 180 * 1000;
let _lastEndpointCall = 0;
let _cachedUsage = null;
let _cachedUsageAt = 0;

async function readCredentialFile() {
  try {
    const raw = await fs.readFile(path.join(CLAUDE_DIR, '.credentials.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readKeychainCredential() {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execFileP('security', [
      'find-generic-password',
      '-s',
      'Claude Code-credentials',
      '-w',
    ]);
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}

// Return { accessToken, subscriptionType, rateLimitTier, expiresAt } or null.
export async function getClaudeCredential() {
  // Prefer the file if present (Linux/Windows, or a user override); fall back to
  // the macOS Keychain.
  const cred = (await readCredentialFile()) || (await readKeychainCredential());
  const oauth = cred?.claudeAiOauth;
  if (!oauth?.accessToken) return null;
  return {
    accessToken: oauth.accessToken,
    subscriptionType: oauth.subscriptionType || null,
    rateLimitTier: oauth.rateLimitTier || null,
    expiresAt: oauth.expiresAt || null,
  };
}

// Best-effort read of the installed Claude Code version for a realistic UA.
async function detectClaudeVersion() {
  try {
    const { stdout } = await execFileP('claude', ['--version'], { timeout: 4000 });
    const m = stdout.match(/(\d+\.\d+\.\d+)/);
    if (m) return m[1];
  } catch {
    // ignore
  }
  return '2.0.0';
}

function pickWindow(win) {
  if (!win || typeof win !== 'object') return null;
  const util =
    typeof win.utilization === 'number'
      ? win.utilization
      : typeof win.percent === 'number'
        ? win.percent
        : null;
  if (util === null) return null;
  // The /api/oauth/usage endpoint returns utilization already as a percent
  // (e.g. 21, 85), confirmed live. Clamp to [0,100] defensively.
  const usedPercent = Math.max(0, Math.min(100, util));
  let resetsAt = null;
  if (typeof win.resets_at === 'string') resetsAt = Date.parse(win.resets_at) || null;
  else if (typeof win.resets_at === 'number')
    resetsAt = win.resets_at < 1e12 ? win.resets_at * 1000 : win.resets_at;
  return { usedPercent, resetsAt };
}

// Call the live usage endpoint (rate-limited + cached). Returns normalized windows
// or null if unavailable/failed.
export async function getClaudeLiveUsage(cred) {
  const now = Date.now();
  if (_cachedUsage && now - _cachedUsageAt < MIN_ENDPOINT_INTERVAL_MS) {
    return _cachedUsage;
  }
  if (now - _lastEndpointCall < MIN_ENDPOINT_INTERVAL_MS && _cachedUsage) {
    return _cachedUsage;
  }
  if (!cred?.accessToken) return null;

  _lastEndpointCall = now;
  const version = await detectClaudeVersion();
  let res;
  try {
    res = await fetch(USAGE_ENDPOINT, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${cred.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': `claude-code/${version}`,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    return _cachedUsage; // network error -> keep last good if any
  }

  if (!res.ok) {
    // 401 (expired token) / 429 (throttled) / schema change -> degrade gracefully.
    return _cachedUsage
      ? { ..._cachedUsage, stale: true }
      : { error: `HTTP ${res.status}`, fiveHour: null, weekly: null };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return _cachedUsage;
  }

  const fiveHour = pickWindow(data.five_hour);
  const weekly = pickWindow(data.seven_day);
  const opusWeekly = pickWindow(data.seven_day_opus);
  const normalized = {
    fiveHour,
    weekly,
    opusWeekly,
    raw: {
      // keep a few extra fields the UI may surface, but don't depend on them
      spendPercent: typeof data?.spend?.percent === 'number' ? data.spend.percent : null,
    },
    fetchedAt: now,
    stale: false,
  };
  _cachedUsage = normalized;
  _cachedUsageAt = now;
  return normalized;
}

const PRICING = {
  // USD per 1M tokens. Approximate list pricing; used only to estimate cost for the
  // local-token layer (subscription usage has no per-call cost, so this is an
  // "equivalent API cost" figure). Keyed by substring match on the model id.
  opus: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

function priceFor(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('opus')) return PRICING.opus;
  if (m.includes('haiku')) return PRICING.haiku;
  if (m.includes('sonnet')) return PRICING.sonnet;
  return PRICING.sonnet; // sensible default
}

// Sum token usage from local session JSONL over a rolling window.
export async function getClaudeTokenUsage({ days = 30 } = {}) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const empty = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    estCostUSD: 0,
    byModel: {},
    daily: {},
    sessions: 0,
  };
  let files;
  try {
    files = await listFilesRecursive(PROJECTS_DIR, (name) => name.endsWith('.jsonl'));
  } catch {
    return empty;
  }

  const acc = { ...empty, byModel: {}, daily: {} };
  const seenSessions = new Set();

  for (const f of files) {
    const st = await safeStat(f);
    if (!st || st.mtimeMs < cutoff) continue;
    const lines = await readJsonlLines(f);
    for (const obj of lines) {
      const ts = obj?.timestamp ? Date.parse(obj.timestamp) : null;
      if (ts && ts < cutoff) continue;
      const msg = obj?.message;
      const usage = msg?.usage;
      if (!usage || typeof usage !== 'object') continue;
      const model = msg.model || 'unknown';
      if (model === '<synthetic>') continue;

      const input = usage.input_tokens || 0;
      const output = usage.output_tokens || 0;
      const cacheRead = usage.cache_read_input_tokens || 0;
      const cacheCreate = usage.cache_creation_input_tokens || 0;

      acc.inputTokens += input;
      acc.outputTokens += output;
      acc.cacheReadTokens += cacheRead;
      acc.cacheCreationTokens += cacheCreate;

      const p = priceFor(model);
      const cost =
        (input / 1e6) * p.input +
        (output / 1e6) * p.output +
        (cacheCreate / 1e6) * p.cacheWrite +
        (cacheRead / 1e6) * p.cacheRead;
      acc.estCostUSD += cost;

      const bm = (acc.byModel[model] ||= {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estCostUSD: 0,
      });
      bm.inputTokens += input;
      bm.outputTokens += output;
      bm.cacheReadTokens += cacheRead;
      bm.cacheCreationTokens += cacheCreate;
      bm.estCostUSD += cost;

      if (obj?.sessionId) seenSessions.add(obj.sessionId);

      const day = new Date(ts || st.mtimeMs).toISOString().slice(0, 10);
      const d = (acc.daily[day] ||= { totalTokens: 0, estCostUSD: 0 });
      const lineTotal = input + output + cacheRead + cacheCreate;
      d.totalTokens += lineTotal;
      d.estCostUSD += cost;
    }
  }

  acc.totalTokens =
    acc.inputTokens + acc.outputTokens + acc.cacheReadTokens + acc.cacheCreationTokens;
  acc.sessions = seenSessions.size;
  return acc;
}

export async function getClaude() {
  const cred = await getClaudeCredential();
  const [live, tokens] = await Promise.all([
    getClaudeLiveUsage(cred),
    getClaudeTokenUsage({ days: 30 }),
  ]);

  const hasLive = !!(live && (live.fiveHour || live.weekly));
  return {
    provider: 'claude',
    label: 'Claude',
    available: !!(hasLive || tokens.totalTokens > 0),
    subscriptionType: cred?.subscriptionType || null,
    rateLimitTier: cred?.rateLimitTier || null,
    rateLimits: hasLive
      ? {
          fiveHour: live.fiveHour,
          weekly: live.weekly,
          opusWeekly: live.opusWeekly || null,
          stale: !!live.stale,
        }
      : null,
    liveError: live && live.error ? live.error : !cred ? 'no-credential' : null,
    tokens,
    source: hasLive ? 'live-endpoint' : 'local-tokens-only',
  };
}
