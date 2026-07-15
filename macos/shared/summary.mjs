// Display helpers for macOS clients (SwiftBar + Übersicht display rules).
// Pure functions over the normalized GET /api/usage payload — no credentials,
// no provider fetches. Keep labels aligned with public/app.js:
//   Claude / Codex → binding max(fiveHour, weekly[, opusWeekly]) in the bar;
//                    dropdown still shows each window separately
//   Cursor         → plan (headline) + auto  (never "5-hour")
//   Codex          → snapshot age from capturedAt (never "live")

export const USAGE_URL = 'http://127.0.0.1:4317/api/usage';
export const DASHBOARD_URL = 'http://127.0.0.1:4317/';

/** Official product pages opened from the SwiftBar provider rows. */
export const PRODUCT_URLS = {
  claude: 'https://claude.ai/settings/usage',
  codex: 'https://chatgpt.com/codex/settings/usage',
  cursor: 'https://cursor.com/dashboard/spending',
};

/** Format a usedPercent for the menu bar / widget. Missing → em dash. */
export function fmtPct(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return `${Math.round(Number(n))}%`;
}

/** Human age from a ms epoch (matches public/app.js fmtAge). */
export function fmtAge(tsMs) {
  if (!tsMs) return 'unknown';
  const ms = Date.now() - tsMs;
  if (ms < 0) return 'just now';
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs < 24) return `${hrs}h ${rem}m ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h ago`;
}

/** Codex provenance chip text — never "live". Flag old snapshots that may lag. */
export function codexAge(capturedAt) {
  const age = fmtAge(capturedAt);
  if (!capturedAt || Date.now() - capturedAt > 60 * 60 * 1000) {
    return `snapshot · ${age} · may lag`;
  }
  return `snapshot · ${age}`;
}

/** Highest non-null usedPercent among windows — the limit that actually binds. */
export function bindingPct(...windows) {
  let max = null;
  for (const w of windows) {
    const n = w?.usedPercent;
    if (n == null || Number.isNaN(Number(n))) continue;
    const v = Number(n);
    if (max == null || v > max) max = v;
  }
  return max;
}

/**
 * Headline % for the menu-bar compact line.
 * Claude/Codex: max of 5-hour / weekly / opus-weekly (so a maxed weekly isn't
 * hidden behind a fresh 5-hour session). Cursor: billing-cycle plan.
 */
export function headlinePct(key, provider) {
  if (!provider?.available || !provider.rateLimits) return null;
  const rl = provider.rateLimits;
  if (key === 'cursor') return rl.plan?.usedPercent ?? null;
  return bindingPct(rl.fiveHour, rl.weekly, rl.opusWeekly);
}

/**
 * Compact menu-bar title — short label only; all numbers live in the dropdown.
 */
export function compactLine(_payload) {
  return 'AI';
}

/**
 * Structured rows for dropdowns / widgets.
 * Each row: { key, label, headlineLabel, headlinePct, secondaryLabel, secondaryPct, caption }
 */
export function providerSummaries(payload) {
  const p = payload?.providers || {};
  return [
    summarizeClaude(p.claude),
    summarizeCodex(p.codex),
    summarizeCursor(p.cursor),
  ];
}

function summarizeClaude(provider) {
  const rl = provider?.rateLimits;
  const ok = provider?.available && rl;
  return {
    key: 'claude',
    label: 'Claude',
    headlineLabel: '5-hour',
    headlinePct: ok ? rl.fiveHour?.usedPercent ?? null : null,
    secondaryLabel: 'weekly',
    secondaryPct: ok ? rl.weekly?.usedPercent ?? null : null,
    caption: ok
      ? rl.stale
        ? 'live (cached)'
        : rl.fetchedAt
          ? `live · ${fmtAge(rl.fetchedAt)}`
          : 'live'
      : provider?.error
        ? 'unavailable'
        : 'no data',
  };
}

function summarizeCodex(provider) {
  const rl = provider?.rateLimits;
  const ok = provider?.available && rl;
  return {
    key: 'codex',
    label: 'Codex',
    headlineLabel: '5-hour',
    headlinePct: ok ? rl.fiveHour?.usedPercent ?? null : null,
    secondaryLabel: 'weekly',
    secondaryPct: ok ? rl.weekly?.usedPercent ?? null : null,
    // Always snapshot — never "live"
    caption: ok ? codexAge(rl.capturedAt) : provider?.error ? 'unavailable' : 'no data',
  };
}

function summarizeCursor(provider) {
  const rl = provider?.rateLimits;
  const ok = provider?.available && rl;
  return {
    key: 'cursor',
    label: 'Cursor',
    headlineLabel: 'plan',
    headlinePct: ok ? rl.plan?.usedPercent ?? null : null,
    secondaryLabel: 'auto',
    secondaryPct: ok ? rl.auto?.usedPercent ?? null : null,
    caption: ok
      ? rl.stale
        ? 'live (cached)'
        : rl.fetchedAt
          ? `live · ${fmtAge(rl.fetchedAt)}`
          : 'live'
      : provider?.error
        ? 'unavailable'
        : 'no data',
  };
}
