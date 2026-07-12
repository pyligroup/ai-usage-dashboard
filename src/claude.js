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
//      optional seven_day_opus, spend / extra_usage (monthly usage-credit cap),
//      and limits[] (session / weekly_all mirrors + optional weekly_scoped /
//      model-scoped windows — normalized as rateLimits.scoped). Undocumented +
//      version-fragile -> allowed to fail.
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

// Convert { amount_minor, exponent } (or credit-count + decimal_places) to a
// major-unit number (e.g. USD dollars). Returns null if shape is unknown.
function moneyFromMinor(obj, fallbackExponent = 2) {
  if (!obj || typeof obj !== 'object') return null;
  if (typeof obj.amount_minor !== 'number') return null;
  const exp =
    typeof obj.exponent === 'number'
      ? obj.exponent
      : typeof obj.decimal_places === 'number'
        ? obj.decimal_places
        : fallbackExponent;
  return obj.amount_minor / Math.pow(10, exp);
}

// Monthly usage credits / extra-usage spend cap. These are NOT the 5-hour or
// weekly subscription windows — Anthropic's disclaimer: "Usage credits cover
// you when you hit your plan limits." Prefer `spend` (has percent + money),
// fall back to `extra_usage` (used_credits / monthly_limit).
//
// When extra usage is disabled (`spend.enabled` / `extra_usage.is_enabled`
// false): do NOT expose a % meter. Still surface `spend.balance` when the API
// returns a real money object (same amount_minor/exponent shape as used/limit).
function pickExtraUsage(spend, extra) {
  const enabled =
    (spend && typeof spend.enabled === 'boolean' ? spend.enabled : null) ??
    (extra && typeof extra.is_enabled === 'boolean' ? extra.is_enabled : null);

  let used = moneyFromMinor(spend?.used);
  let limit = moneyFromMinor(spend?.limit);
  // Observed null when enabled; when present, same money shape as used/limit.
  const balance = moneyFromMinor(spend?.balance);
  const currency =
    spend?.used?.currency ||
    spend?.limit?.currency ||
    spend?.balance?.currency ||
    (typeof extra?.currency === 'string' ? extra.currency : null) ||
    'USD';
  const decimals =
    typeof spend?.used?.exponent === 'number'
      ? spend.used.exponent
      : typeof spend?.balance?.exponent === 'number'
        ? spend.balance.exponent
        : typeof extra?.decimal_places === 'number'
          ? extra.decimal_places
          : 2;

  if (used == null && typeof extra?.used_credits === 'number') {
    used = extra.used_credits / Math.pow(10, decimals);
  }
  if (limit == null && typeof extra?.monthly_limit === 'number') {
    limit = extra.monthly_limit / Math.pow(10, decimals);
  }

  const remaining =
    used != null && limit != null ? Math.max(0, +(limit - used).toFixed(decimals)) : null;

  // Disabled: no progress bar — only a balance note when the API provides one.
  if (enabled === false) {
    if (balance == null) return null;
    return {
      enabled: false,
      usedPercent: null,
      used: null,
      limit: null,
      remaining: null,
      balance,
      currency,
      resetsAt: null,
    };
  }

  let usedPercent =
    typeof spend?.percent === 'number'
      ? spend.percent
      : typeof extra?.utilization === 'number'
        ? extra.utilization
        : null;
  if (usedPercent == null && used != null && limit != null && limit > 0) {
    usedPercent = (used / limit) * 100;
  }
  if (usedPercent != null) usedPercent = Math.max(0, Math.min(100, usedPercent));

  // Only surface when the account has a real credit pool, spend meter, or balance.
  if (used == null && limit == null && usedPercent == null && balance == null) {
    return null;
  }

  return {
    enabled: enabled !== false,
    usedPercent,
    used,
    limit,
    remaining,
    balance,
    currency,
    // Monthly pool — no per-window resets_at on spend/extra_usage today.
    resetsAt: null,
  };
}

// Kinds that mirror top-level five_hour / seven_day — skip unless they carry a
// scope (model display_name / surface) that adds distinct info.
const MIRROR_LIMIT_KINDS = new Set(['session', 'weekly_all']);

function humanizeLimitKind(kind) {
  if (!kind || typeof kind !== 'string') return 'Limit';
  return kind
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Label from scope.model.display_name / scope.surface, with a group hint.
// Never hardcode product names (e.g. "Fable") — they come from the API.
function scopedLimitLabel(entry) {
  const scope = entry?.scope;
  const modelName =
    (scope?.model && typeof scope.model.display_name === 'string' && scope.model.display_name) ||
    (typeof scope?.model === 'string' ? scope.model : null) ||
    null;
  const surface =
    typeof scope?.surface === 'string' && scope.surface.trim() ? scope.surface.trim() : null;
  const name = (modelName && modelName.trim()) || surface;
  const group = typeof entry?.group === 'string' ? entry.group : null;
  const kind = typeof entry?.kind === 'string' ? entry.kind : null;

  if (name) {
    if (group === 'weekly' || (kind && kind.startsWith('weekly'))) return `Weekly (${name})`;
    if (group === 'session' || kind === 'session') return `Session (${name})`;
    return name;
  }
  if (kind === 'weekly_scoped') return 'Weekly (scoped)';
  if (kind) return humanizeLimitKind(kind);
  if (group) return humanizeLimitKind(group);
  return 'Scoped limit';
}

function isOpusScopedDuplicate(entry, hasOpusWeekly) {
  if (!hasOpusWeekly) return false;
  const name = (
    (entry?.scope?.model && typeof entry.scope.model.display_name === 'string'
      ? entry.scope.model.display_name
      : '') || ''
  ).toLowerCase();
  if (name === 'opus' || name.includes('opus')) return true;
  const kind = (typeof entry?.kind === 'string' ? entry.kind : '').toLowerCase();
  return kind.includes('opus');
}

// Extra windows from limits[] beyond the primary five_hour / seven_day /
// seven_day_opus bars. Especially weekly_scoped (e.g. model-scoped weekly %).
function pickScopedLimits(limits, { hasOpusWeekly = false } = {}) {
  if (!Array.isArray(limits) || !limits.length) return [];
  const out = [];
  for (const entry of limits) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.is_active === false) continue;

    const kind = typeof entry.kind === 'string' ? entry.kind : null;
    const scope = entry.scope && typeof entry.scope === 'object' ? entry.scope : null;
    const hasScope = !!(
      scope &&
      ((scope.model &&
        typeof scope.model.display_name === 'string' &&
        scope.model.display_name.trim()) ||
        (typeof scope.model === 'string' && scope.model.trim()) ||
        (typeof scope.surface === 'string' && scope.surface.trim()))
    );

    // Skip plain session / weekly_all mirrors of five_hour / seven_day.
    if (kind && MIRROR_LIMIT_KINDS.has(kind) && !hasScope) continue;

    const isScopedKind = kind === 'weekly_scoped' || (kind && kind.includes('scoped'));
    if (!isScopedKind && !hasScope) continue;
    if (isOpusScopedDuplicate(entry, hasOpusWeekly)) continue;

    const pct =
      typeof entry.percent === 'number'
        ? entry.percent
        : typeof entry.utilization === 'number'
          ? entry.utilization
          : null;
    if (pct == null) continue;

    let resetsAt = null;
    if (typeof entry.resets_at === 'string') resetsAt = Date.parse(entry.resets_at) || null;
    else if (typeof entry.resets_at === 'number')
      resetsAt = entry.resets_at < 1e12 ? entry.resets_at * 1000 : entry.resets_at;

    const item = {
      label: scopedLimitLabel(entry),
      usedPercent: Math.max(0, Math.min(100, pct)),
      resetsAt,
      kind,
      group: typeof entry.group === 'string' ? entry.group : null,
    };
    if (typeof entry.severity === 'string' && entry.severity) item.severity = entry.severity;
    out.push(item);
  }
  return out;
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
      : { error: `HTTP ${res.status}`, fiveHour: null, weekly: null, scoped: [] };
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
  const extraUsage = pickExtraUsage(data.spend, data.extra_usage);
  const scoped = pickScopedLimits(data.limits, { hasOpusWeekly: !!opusWeekly });
  const normalized = {
    fiveHour,
    weekly,
    opusWeekly,
    extraUsage,
    scoped,
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

  // Claude Code writes one JSONL line per content block (assistant text + each
  // tool_use). Every line for a given assistant message repeats that message's
  // usage, but the value GROWS across the message's lines — early lines carry a
  // partial output_tokens and only the LAST line has the final total. So we must
  // collapse each (session, message) group to a SINGLE record holding its final
  // (max) usage: summing all lines over-counts ~2.4x; keeping the first line
  // under-counts ~12%. We collect the max usage per message here, then aggregate.
  const byMessage = new Map(); // key -> { input, output, cacheRead, cacheCreate, model, day }

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
      const day = new Date(ts || st.mtimeMs).toISOString().slice(0, 10);

      // Key by (session, message id) so each streamed message collapses to one
      // record. Fall back to requestId/uuid so a line missing `id` still keys
      // uniquely (worst case it counts as its own message — never over-counts).
      const id = msg.id || obj?.requestId || obj?.uuid || `${f}:${obj?.uuid || Math.random()}`;
      const key = `${obj?.sessionId || ''}:${id}`;

      const prev = byMessage.get(key);
      // Keep the line with the largest total usage — that's the final one.
      const total = input + output + cacheRead + cacheCreate;
      if (!prev || total > prev.total) {
        byMessage.set(key, { input, output, cacheRead, cacheCreate, total, model, day });
      }
      if (obj?.sessionId) seenSessions.add(obj.sessionId);
    }
  }

  // Aggregate one record per message.
  for (const m of byMessage.values()) {
    acc.inputTokens += m.input;
    acc.outputTokens += m.output;
    acc.cacheReadTokens += m.cacheRead;
    acc.cacheCreationTokens += m.cacheCreate;

    const p = priceFor(m.model);
    const cost =
      (m.input / 1e6) * p.input +
      (m.output / 1e6) * p.output +
      (m.cacheCreate / 1e6) * p.cacheWrite +
      (m.cacheRead / 1e6) * p.cacheRead;
    acc.estCostUSD += cost;

    const bm = (acc.byModel[m.model] ||= {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estCostUSD: 0,
    });
    bm.inputTokens += m.input;
    bm.outputTokens += m.output;
    bm.cacheReadTokens += m.cacheRead;
    bm.cacheCreationTokens += m.cacheCreate;
    bm.estCostUSD += cost;

    const d = (acc.daily[m.day] ||= { totalTokens: 0, estCostUSD: 0 });
    d.totalTokens += m.total;
    d.estCostUSD += cost;
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

  const hasScoped = !!(live?.scoped && live.scoped.length);
  const hasLive = !!(live && (live.fiveHour || live.weekly || live.extraUsage || hasScoped));
  return {
    provider: 'claude',
    label: 'Claude',
    available: !!(hasLive || tokens.totalTokens > 0),
    subscriptionType: cred?.subscriptionType || null,
    rateLimitTier: cred?.rateLimitTier || null,
    rateLimits: hasLive
      ? {
          fiveHour: live.fiveHour || null,
          weekly: live.weekly || null,
          opusWeekly: live.opusWeekly || null,
          // Model-/surface-scoped windows from limits[] (e.g. weekly_scoped).
          // Labels come from the API — never hardcoded product names.
          scoped: live.scoped || [],
          // Monthly usage-credit / extra-usage spend cap (when enabled).
          // Separate from 5-hour / weekly windows — covers overage after plan limits.
          extraUsage: live.extraUsage || null,
          stale: !!live.stale,
          fetchedAt: live.fetchedAt || null,
        }
      : null,
    liveError: live && live.error ? live.error : !cred ? 'no-credential' : null,
    tokens,
    source: hasLive ? 'live-endpoint' : 'local-tokens-only',
  };
}
