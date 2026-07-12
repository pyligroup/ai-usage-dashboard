// Cursor (Anysphere) usage reader.
//
// Two layers:
//   1. LIVE plan % + token totals via Cursor's undocumented dashboard endpoints:
//        GET  https://cursor.com/api/usage-summary
//        POST https://cursor.com/api/dashboard/get-aggregated-usage-events
//      Auth is the WorkOS session cookie built from the JWT Cursor already stores
//      locally (see getCursorCredential). Undocumented + version-fragile → allowed
//      to fail; we degrade to membership metadata from the local state DB.
//   2. STABLE local membership metadata from Cursor's state.vscdb ItemTable
//      (cursorAuth/stripeMembershipType, cachedEmail, …). Always available when
//      Cursor has been signed in; no network.
//
// Auth sources (read-only, never refresh/write):
//   1. CURSOR_ACCESS_TOKEN env override (raw JWT or "sub::jwt" / "user_…::jwt")
//   2. Cursor IDE state DB → ItemTable key cursorAuth/accessToken
//        macOS:   ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
//        Linux:   ~/.config/Cursor/User/globalStorage/state.vscdb
//        Windows: %APPDATA%/Cursor/User/globalStorage/state.vscdb
//   3. macOS Keychain service "cursor-access-token" (cursor-agent CLI) — often
//      staler than the IDE DB; tried last.
//
// Cookie format required by cursor.com: WorkosCursorSessionToken=<sub>::<jwt>
// where <sub> may be the full JWT `sub` claim or the trailing `user_…` segment.
//
// IMPORTANT: Cursor does NOT have Claude/Codex-style 5-hour / weekly windows.
// Its meter is a billing-cycle plan allowance (plus optional auto/API splits).
// The UI must label these as plan/billing-cycle — never as "5-hour" or "weekly".

import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { safeStat } from './util.js';

const execFileP = promisify(execFile);

const USAGE_SUMMARY_URL = 'https://cursor.com/api/usage-summary';
const AGGREGATED_URL = 'https://cursor.com/api/dashboard/get-aggregated-usage-events';
const AUTH_ME_URL = 'https://cursor.com/api/auth/me';

// Same throttle posture as Claude — undocumented endpoints, don't hammer them.
const MIN_ENDPOINT_INTERVAL_MS = 180 * 1000;
let _lastEndpointCall = 0;
let _cachedLive = null;
let _cachedLiveAt = 0;

function stateDbPath() {
  if (process.env.CURSOR_STATE_DB) return process.env.CURSOR_STATE_DB;
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  // Linux / other
  return path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

function decodeJwtPayload(token) {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const padded = part + '='.repeat((4 - (part.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// Resolve a usable session JWT + cookie identity from an env override string.
function parseTokenOverride(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t) return null;
  // Already "sub::jwt" or "user_…::jwt"
  if (t.includes('::')) {
    const idx = t.indexOf('::');
    const id = t.slice(0, idx);
    const jwt = t.slice(idx + 2);
    if (!jwt || !id) return null;
    return { accessToken: jwt, cookieId: id };
  }
  const payload = decodeJwtPayload(t);
  if (!payload?.sub) return null;
  const sub = String(payload.sub);
  const cookieId = sub.includes('|') ? sub.split('|').pop() : sub;
  return { accessToken: t, cookieId, sub };
}

async function readKeyFromStateDb(key) {
  const db = stateDbPath();
  const st = await safeStat(db);
  if (!st) return null;

  // Prefer system sqlite3; Android platform-tools sqlite3 is often first on PATH
  // and can be quirky, so try absolute macOS/Linux path first.
  const candidates =
    process.platform === 'win32'
      ? ['sqlite3']
      : ['/usr/bin/sqlite3', 'sqlite3'];

  // Escape single quotes for SQL string literal.
  const sqlKey = String(key).replace(/'/g, "''");
  const sql = `SELECT value FROM ItemTable WHERE key='${sqlKey}' LIMIT 1;`;

  // Spaces in "Application Support" break bare file: URIs — percent-encode the path.
  const dbUri = `file:${encodeURI(db).replace(/#/g, '%23')}?mode=ro`;

  for (const bin of candidates) {
    try {
      // mode=ro avoids lock fights with a running Cursor.
      const { stdout } = await execFileP(bin, [dbUri, sql], {
        timeout: 5000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const val = stdout.trim();
      if (val) return val;
    } catch {
      // try next binary / fall through
    }
  }

  // Python fallback (stdlib sqlite3) — common on macOS/Linux when CLI is missing.
  try {
    const { stdout } = await execFileP(
      process.platform === 'win32' ? 'python' : 'python3',
      [
        '-c',
        'import sqlite3,sys; c=sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True); '
        + 'r=c.execute("SELECT value FROM ItemTable WHERE key=?", (sys.argv[2],)).fetchone(); '
        + 'print(r[0] if r else "")',
        db,
        key,
      ],
      { timeout: 5000, maxBuffer: 2 * 1024 * 1024 },
    );
    const val = stdout.trim();
    if (val) return val;
  } catch {
    // ignore
  }
  return null;
}

async function readKeychainAccessToken() {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execFileP('security', [
      'find-generic-password',
      '-s',
      'cursor-access-token',
      '-a',
      'cursor-user',
      '-w',
    ]);
    const t = stdout.trim();
    return t || null;
  } catch {
    return null;
  }
}

// Return { accessToken, cookieId, membershipType, email, subscriptionStatus } or null.
export async function getCursorCredential() {
  const fromEnv = parseTokenOverride(process.env.CURSOR_ACCESS_TOKEN);
  let accessToken = fromEnv?.accessToken || null;
  let cookieId = fromEnv?.cookieId || null;

  if (!accessToken) {
    accessToken = await readKeyFromStateDb('cursorAuth/accessToken');
  }
  if (!accessToken) {
    accessToken = await readKeychainAccessToken();
  }
  if (!accessToken) return null;

  const payload = decodeJwtPayload(accessToken);
  const sub = payload?.sub ? String(payload.sub) : null;
  if (!cookieId) {
    cookieId = sub?.includes('|') ? sub.split('|').pop() : sub;
  }
  if (!cookieId) return null;

  const membershipType = (await readKeyFromStateDb('cursorAuth/stripeMembershipType')) || null;
  const subscriptionStatus = (await readKeyFromStateDb('cursorAuth/stripeSubscriptionStatus')) || null;
  const email = (await readKeyFromStateDb('cursorAuth/cachedEmail')) || null;

  return {
    accessToken,
    cookieId,
    sub,
    membershipType,
    subscriptionStatus,
    email,
  };
}

function sessionCookie(cred) {
  // cursor.com accepts both full sub and trailing user_…; user_… is the safer
  // universal form used by community tools.
  return `WorkosCursorSessionToken=${cred.cookieId}::${cred.accessToken}`;
}

function pickPercent(...vals) {
  for (const v of vals) {
    if (typeof v === 'number' && !Number.isNaN(v)) {
      // Some fields are already 0–100; autoPercentUsed in usage-summary is too.
      return Math.max(0, Math.min(100, v));
    }
  }
  return null;
}

function parseIsoMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    // Sometimes epoch-ms as string (get-current-period-usage).
    if (/^\d+$/.test(v)) {
      const n = Number(v);
      return n < 1e12 ? n * 1000 : n;
    }
    return Date.parse(v) || null;
  }
  return null;
}

function toInt(v) {
  if (typeof v === 'number' && !Number.isNaN(v)) return Math.round(v);
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Math.round(Number(v));
  return 0;
}

async function cursorFetch(url, { method = 'GET', body = null, cred } = {}) {
  const headers = {
    Cookie: sessionCookie(cred),
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0 (compatible; ai-usage-dashboard/1.0)',
  };
  let data = undefined;
  if (body != null) {
    data = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
    // POST dashboard endpoints require Origin (CSRF).
    headers.Origin = 'https://cursor.com';
  }
  const res = await fetch(url, { method, headers, body: data });
  return res;
}

// Live plan usage + 30d token aggregates. Cached/throttled like Claude.
export async function getCursorLiveUsage(cred) {
  const now = Date.now();
  if (_cachedLive && now - _cachedLiveAt < MIN_ENDPOINT_INTERVAL_MS) {
    return _cachedLive;
  }
  if (now - _lastEndpointCall < MIN_ENDPOINT_INTERVAL_MS && _cachedLive) {
    return _cachedLive;
  }
  if (!cred?.accessToken) return null;

  _lastEndpointCall = now;

  let summaryRes;
  try {
    summaryRes = await cursorFetch(USAGE_SUMMARY_URL, { cred });
  } catch {
    return _cachedLive; // network error → keep last good
  }

  if (!summaryRes.ok) {
    return _cachedLive
      ? { ..._cachedLive, stale: true }
      : { error: `HTTP ${summaryRes.status}`, rateLimits: null, tokens: null };
  }

  let summary;
  try {
    summary = await summaryRes.json();
  } catch {
    return _cachedLive;
  }

  const plan = summary?.individualUsage?.plan;
  const onDemand = summary?.individualUsage?.onDemand;
  const cycleEnd = parseIsoMs(summary?.billingCycleEnd);
  const cycleStart = parseIsoMs(summary?.billingCycleStart);

  // Headline plan % MUST be totalPercentUsed — that is what cursor.com/dashboard
  // Spending shows as "Total Usage" and what gates the included allowance.
  // used/limit is a separate unit (appears to be USD cents of the included pool,
  // e.g. 225/2000 = $2.25 of $20) and can disagree sharply with totalPercentUsed
  // because auto vs API models are weighted differently in the % meter.
  const planPct = pickPercent(plan?.totalPercentUsed);
  // auto/api splits are reported as already-percent fields (0–100).
  const autoPct = pickPercent(plan?.autoPercentUsed);
  const apiPct = pickPercent(plan?.apiPercentUsed);

  const rateLimits = {
    // Cursor-specific windows — NOT 5-hour / weekly.
    plan: planPct == null
      ? null
      : {
          usedPercent: planPct,
          resetsAt: cycleEnd,
          // used/limit/remaining look like USD cents of the included pool.
          used: typeof plan?.used === 'number' ? plan.used : null,
          limit: typeof plan?.limit === 'number' ? plan.limit : null,
          remaining: typeof plan?.remaining === 'number' ? plan.remaining : null,
        },
    auto: autoPct == null ? null : { usedPercent: autoPct, resetsAt: cycleEnd },
    api: apiPct == null ? null : { usedPercent: apiPct, resetsAt: cycleEnd },
    onDemand: onDemand?.enabled
      ? (() => {
          const used = typeof onDemand.used === 'number' ? onDemand.used : null;
          const limit = typeof onDemand.limit === 'number' ? onDemand.limit : null;
          // used/limit appear to be USD cents (same unit as plan.used/limit).
          let usedPercent = null;
          if (used != null && limit != null && limit > 0) {
            usedPercent = Math.max(0, Math.min(100, (used / limit) * 100));
          }
          return {
            enabled: true,
            usedPercent,
            used,
            limit,
            resetsAt: cycleEnd,
          };
        })()
      : null,
    billingCycleStart: cycleStart,
    billingCycleEnd: cycleEnd,
    membershipType: summary?.membershipType || null,
    isUnlimited: !!summary?.isUnlimited,
    stale: false,
    fetchedAt: now,
  };

  // Token aggregates for the current billing cycle when we know cycleStart;
  // otherwise fall back to a rolling 30d window. Do NOT clip a longer cycle to
  // 30 days — that drops early-cycle usage while the UI still says "current period".
  let tokens = emptyTokens();
  try {
    const end = now;
    const thirtyAgo = now - 30 * 24 * 60 * 60 * 1000;
    const start = cycleStart != null ? cycleStart : thirtyAgo;
    const windowLabel = cycleStart != null ? 'current period' : 'last 30 days';

    // Resolve numeric user id (optional filter; empty body also works but
    // scoping to self is clearer for team accounts).
    let userId = null;
    try {
      const meRes = await cursorFetch(AUTH_ME_URL, { cred });
      if (meRes.ok) {
        const me = await meRes.json();
        if (typeof me?.id === 'number') userId = me.id;
      }
    } catch {
      // optional
    }

    const body = {
      teamId: 0,
      startDate: String(start),
      endDate: String(end),
    };
    if (userId != null) body.userId = userId;

    const aggRes = await cursorFetch(AGGREGATED_URL, { method: 'POST', body, cred });
    if (aggRes.ok) {
      const agg = await aggRes.json();
      tokens = normalizeAggregated(agg);
      tokens.windowLabel = windowLabel;
      tokens.windowStart = start;
      tokens.windowEnd = end;
    }
  } catch {
    // tokens stay empty — plan % still useful
  }

  const normalized = {
    rateLimits,
    tokens,
    membershipType: summary?.membershipType || null,
    fetchedAt: now,
    stale: false,
  };
  _cachedLive = normalized;
  _cachedLiveAt = now;
  return normalized;
}

function emptyTokens() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    estCostUSD: 0,
    byModel: {},
    daily: {},
    sessions: 0,
    windowLabel: null,
    windowStart: null,
    windowEnd: null,
  };
}

function normalizeAggregated(agg) {
  const acc = emptyTokens();
  if (!agg || typeof agg !== 'object') return acc;

  acc.inputTokens = toInt(agg.totalInputTokens);
  acc.outputTokens = toInt(agg.totalOutputTokens);
  acc.cacheReadTokens = toInt(agg.totalCacheReadTokens);
  // cache write isn't always in the totals; sum from per-model if present
  let cacheWrite = 0;
  const byModel = {};
  for (const row of agg.aggregations || []) {
    const model = row?.modelIntent || 'unknown';
    const input = toInt(row.inputTokens);
    const output = toInt(row.outputTokens);
    const cacheRead = toInt(row.cacheReadTokens);
    const cacheW = toInt(row.cacheWriteTokens);
    cacheWrite += cacheW;
    const cents = typeof row.totalCents === 'number' ? row.totalCents : 0;
    // Cursor may return multiple aggregation rows per modelIntent — accumulate.
    const prev = byModel[model];
    if (prev) {
      prev.inputTokens += input;
      prev.outputTokens += output;
      prev.cacheReadTokens += cacheRead;
      prev.cacheWriteTokens += cacheW;
      prev.estCostUSD += cents / 100;
    } else {
      byModel[model] = {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheW,
        estCostUSD: cents / 100,
      };
    }
  }
  acc.cacheWriteTokens = cacheWrite;
  acc.byModel = byModel;
  acc.totalTokens = acc.inputTokens + acc.outputTokens + acc.cacheReadTokens + acc.cacheWriteTokens;
  acc.estCostUSD = typeof agg.totalCostCents === 'number' ? agg.totalCostCents / 100 : 0;
  // No session count on this endpoint — leave 0 rather than invent one.
  acc.sessions = 0;
  // No per-day breakdown without paginating filtered events — leave empty.
  acc.daily = {};
  return acc;
}

export async function getCursor() {
  const cred = await getCursorCredential();
  if (!cred) {
    return {
      provider: 'cursor',
      label: 'Cursor',
      available: false,
      error: 'no-credential',
      membershipType: null,
      rateLimits: null,
      tokens: emptyTokens(),
      source: 'none',
      liveError: 'no-credential',
    };
  }

  const live = await getCursorLiveUsage(cred).catch(() => null);
  const hasLimits = !!(live?.rateLimits?.plan || live?.rateLimits?.auto || live?.rateLimits?.api);
  const tokens = live?.tokens || emptyTokens();
  const hasTokens = tokens.totalTokens > 0;

  // Propagate top-level live.stale onto rateLimits so the UI chip/source text
  // can distinguish a fresh fetch from a kept-last-good cache hit.
  const rateLimits = hasLimits
    ? {
        ...live.rateLimits,
        stale: !!(live.stale || live.rateLimits.stale),
        fetchedAt: live.rateLimits.fetchedAt || live.fetchedAt || null,
      }
    : null;

  return {
    provider: 'cursor',
    label: 'Cursor',
    available: !!(hasLimits || hasTokens || cred.membershipType),
    membershipType: live?.membershipType || cred.membershipType || null,
    subscriptionStatus: cred.subscriptionStatus || null,
    email: cred.email || null,
    rateLimits,
    tokens,
    liveError: live && live.error ? live.error : null,
    source: hasLimits ? 'live-endpoint' : hasTokens ? 'live-tokens-only' : 'local-membership-only',
  };
}
