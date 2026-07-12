'use strict';

const REFRESH_MS = 30 * 1000;
const ALL_PROVIDERS = ['claude', 'codex', 'cursor'];
const SETTINGS_COOKIE = 'ai_usage_tools';
const THEME_COOKIE = 'ai_usage_theme';
const LAYOUT_COOKIE = 'ai_usage_layout';
const SETTINGS_MAX_AGE_SEC = 60 * 60 * 24 * 365; // 1 year
const THEME_OPTIONS = ['system', 'light', 'dark'];
// Legacy layout cookie values from older builds → compact bars-only.
const LEGACY_COMPACT_LAYOUTS = new Set(['dashboard', 'fit', 'compact']);

const PROVIDER_META = {
  claude: { name: 'Claude', logo: 'C', accent: 'var(--claude)', sub: 'Anthropic · Claude Code' },
  codex: { name: 'Codex', logo: 'Cx', accent: 'var(--codex)', sub: 'OpenAI · Codex CLI' },
  cursor: { name: 'Cursor', logo: 'Cu', accent: 'var(--cursor)', sub: 'Anysphere · Cursor IDE' },
};

// ---------- cookie helpers ----------
function readCookie(name) {
  const prefix = name + '=';
  for (const part of document.cookie.split(';')) {
    const s = part.trim();
    if (s.startsWith(prefix)) return decodeURIComponent(s.slice(prefix.length));
  }
  return null;
}

function writeCookie(name, value, maxAgeSec) {
  document.cookie =
    `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeSec}; SameSite=Lax`;
}

function defaultVisible() {
  return { claude: true, codex: true, cursor: true };
}

function loadVisibleTools() {
  const raw = readCookie(SETTINGS_COOKIE);
  if (!raw) return defaultVisible();
  try {
    const parsed = JSON.parse(raw);
    const out = defaultVisible();
    let any = false;
    for (const key of ALL_PROVIDERS) {
      if (typeof parsed[key] === 'boolean') {
        out[key] = parsed[key];
        if (parsed[key]) any = true;
      }
    }
    // Never leave the dashboard empty — fall back to all-on.
    return any ? out : defaultVisible();
  } catch {
    return defaultVisible();
  }
}

function saveVisibleTools(vis) {
  writeCookie(SETTINGS_COOKIE, JSON.stringify(vis), SETTINGS_MAX_AGE_SEC);
}

let visibleTools = loadVisibleTools();

function visibleKeys() {
  return ALL_PROVIDERS.filter((k) => visibleTools[k]);
}

// ---------- cookie-backed theme (system | light | dark) ----------
function loadTheme() {
  const raw = readCookie(THEME_COOKIE);
  return THEME_OPTIONS.includes(raw) ? raw : 'system';
}

function applyTheme(theme) {
  const t = THEME_OPTIONS.includes(theme) ? theme : 'system';
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  return t;
}

function saveTheme(theme) {
  const t = applyTheme(theme);
  writeCookie(THEME_COOKIE, t, SETTINGS_MAX_AGE_SEC);
  return t;
}

let currentTheme = applyTheme(loadTheme());

// ---------- cookie-backed layout (default | compact) ----------
function normalizeLayout(raw) {
  if (raw === 'default') return 'default';
  if (LEGACY_COMPACT_LAYOUTS.has(raw)) return 'compact';
  return 'default';
}

function loadLayout() {
  return normalizeLayout(readCookie(LAYOUT_COOKIE));
}

function applyLayout(layout) {
  const L = normalizeLayout(layout);
  if (L === 'compact') document.documentElement.setAttribute('data-layout', 'compact');
  else document.documentElement.removeAttribute('data-layout');
  return L;
}

function saveLayout(layout) {
  const L = applyLayout(layout);
  writeCookie(LAYOUT_COOKIE, L, SETTINGS_MAX_AGE_SEC);
  return L;
}

function isCompactLayout() {
  return currentLayout === 'compact';
}

let currentLayout = applyLayout(loadLayout());

// ---------- helpers ----------
function fmtCompact(n) {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
  return String(Math.round(n));
}

function fmtMoney(n) {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1000) return '$' + Math.round(n).toLocaleString();
  return '$' + n.toFixed(2);
}

function severityColor(pct) {
  if (pct == null) return 'var(--text-faint)';
  if (pct >= 90) return 'var(--danger)';
  if (pct >= 70) return 'var(--warn)';
  return 'var(--ok)';
}

function fmtReset(resetsAt) {
  if (!resetsAt) return '';
  const ms = resetsAt - Date.now();
  if (ms <= 0) return 'resetting…';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `resets in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs < 24) return `resets in ${hrs}h ${rem}m`;
  const days = Math.floor(hrs / 24);
  const remH = hrs % 24;
  return `resets in ${days}d ${remH}h`;
}

// "how long ago" for a past timestamp (ms). Returns e.g. "2m ago", "3h ago".
function fmtAge(tsMs) {
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

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

// Dollars from a major-unit number (Claude extraUsage) or USD cents (Cursor).
function fmtSpendPair(used, limit, { cents = false } = {}) {
  if (used == null && limit == null) return '';
  const scale = cents ? 0.01 : 1;
  const u = used == null ? null : used * scale;
  const l = limit == null ? null : limit * scale;
  if (u != null && l != null) return `${fmtMoney(u)} of ${fmtMoney(l)}`;
  if (u != null) return `${fmtMoney(u)} used`;
  return `${fmtMoney(l)} limit`;
}

// Claude usage-credits meter caption: configured pool + remaining.
// e.g. "$11.38 of $20.00 · $8.62 left"
function fmtCreditsHint(eu) {
  if (!eu) return '';
  const parts = [];
  const pair = fmtSpendPair(eu.used, eu.limit);
  if (pair) parts.push(pair);
  if (eu.remaining != null) parts.push(`${fmtMoney(eu.remaining)} left`);
  return parts.join(' · ');
}

// ---------- sparkline ----------
function sparkline(dailyMap, accent) {
  const days = [];
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const v = dailyMap[key];
    days.push(typeof v === 'number' ? v : v?.totalTokens || 0);
  }
  const w = 300;
  const h = 44;
  const max = Math.max(1, ...days);
  const step = w / (days.length - 1);
  const pts = days.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 4) - 2).toFixed(1)}`);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('class', 'spark');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const area = document.createElementNS(svg.namespaceURI, 'polygon');
  area.setAttribute('points', `0,${h} ${pts.join(' ')} ${w},${h}`);
  area.setAttribute('fill', accent);
  area.setAttribute('opacity', '0.12');
  const line = document.createElementNS(svg.namespaceURI, 'polyline');
  line.setAttribute('points', pts.join(' '));
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', accent);
  line.setAttribute('stroke-width', '1.6');
  line.setAttribute('stroke-linejoin', 'round');
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(area, line);
  return svg;
}

// ---------- provider card ----------
function limitRow(name, win, sourceText, valueHint) {
  if (!win) {
    return el('div', { class: 'limit-row' }, [
      el('div', { class: 'limit-top' }, [
        el('span', { class: 'limit-name' }, name),
        el('span', { class: 'limit-pct', style: 'color:var(--text-faint)' }, '—'),
      ]),
      el('div', { class: 'bar' }, [el('span', { style: 'width:0' })]),
      el('div', { class: 'limit-reset' }, 'no data'),
    ]);
  }
  const pct = win.usedPercent;
  const color = severityColor(pct);
  const pctLabel =
    pct == null
      ? el('span', { class: 'limit-pct', style: 'color:var(--text-faint)' }, '—')
      : el('span', { class: 'limit-pct', style: `color:${color}` }, `${Math.round(pct)}%`);
  const metaParts = [valueHint, fmtReset(win.resetsAt)].filter(Boolean);
  return el('div', { class: 'limit-row' }, [
    el('div', { class: 'limit-top' }, [
      el('span', { class: 'limit-name' }, name),
      pctLabel,
    ]),
    el('div', { class: 'bar' }, [
      el('span', {
        style: `width:${pct == null ? 0 : Math.min(100, pct)}%;background:${color}`,
      }),
    ]),
    el('div', { class: 'limit-reset' }, [
      metaParts.join(' · ') || ' ',
      sourceText ? el('span', { class: 'limit-src' }, ` · ${sourceText}`) : null,
    ]),
  ]);
}

// A labelled stat tile with a plain-language caption of what it represents.
function stat(label, value, caption, opts = {}) {
  const v = el('div', { class: 'stat-v' }, value);
  return el('div', { class: 'stat', title: opts.tip || caption || '' }, [
    el('div', { class: 'stat-k' }, label),
    v,
    caption ? el('div', { class: 'stat-cap' }, caption) : null,
  ]);
}

const STACK_MQ = window.matchMedia('(max-width: 1024px)');
// Keep in sync with --stack-bp / @media (max-width: 1024px) in styles.css.
// ≤1024: 1-col + token accordion; ≥1025: multi-col full detail.

function isStackedViewport() {
  return STACK_MQ.matches;
}

// Keep accordion state in sync with the stack breakpoint:
// wide → always open (full detail); narrow → collapsed by default.
function syncCardExtrasOpen() {
  const stacked = isStackedViewport();
  for (const d of document.querySelectorAll('details.card-extra')) {
    d.open = !stacked;
  }
}

STACK_MQ.addEventListener('change', syncCardExtrasOpen);

function buildLimitsPanel(key, p, { compact = false } = {}) {
  const rl = p?.rateLimits;
  const isClaude = key === 'claude';
  const isCursor = key === 'cursor';
  const isCodex = key === 'codex';
  const hasLimits = !!rl;

  const limitsPanel = el('div', { class: 'card-panel card-limits' });
  if (!compact) {
    limitsPanel.append(
      el('div', { class: 'section-label' }, isCursor ? 'Subscription plan usage' : 'Subscription rate limits'),
    );
  }

  if (isCursor) {
    const limitSrc = hasLimits ? (rl.stale ? 'live (cached)' : 'live') : null;
    const plan = rl?.plan;
    limitsPanel.append(limitRow('Plan (billing cycle)', plan, limitSrc));
    limitsPanel.append(limitRow('Auto models', rl?.auto, limitSrc));
    limitsPanel.append(limitRow('API / named models', rl?.api, limitSrc));
    const od = rl?.onDemand;
    if (od?.enabled) {
      limitsPanel.append(
        limitRow(
          'On-demand credits',
          od,
          limitSrc,
          fmtSpendPair(od.used, od.limit, { cents: true }) || 'billing cycle',
        ),
      );
    }
    if (!hasLimits) {
      const why =
        p.liveError === 'no-credential'
          ? 'No Cursor session found — sign in to the Cursor app, then refresh.'
          : p.liveError
            ? `Live limits unavailable (${p.liveError}).`
            : 'Live plan % unavailable.';
      limitsPanel.append(el('div', { class: 'note' }, why));
    }
  } else {
    const limitSrc = hasLimits
      ? isClaude
        ? rl.stale
          ? 'live (cached)'
          : 'live'
        : `saved ${fmtAge(rl.capturedAt)}`
      : null;
    limitsPanel.append(limitRow('5-hour window', rl?.fiveHour, limitSrc));
    limitsPanel.append(limitRow('Weekly window', rl?.weekly, limitSrc));
    if (rl?.opusWeekly) limitsPanel.append(limitRow('Weekly (Opus)', rl.opusWeekly, limitSrc));
    // Dynamic scoped windows from Anthropic limits[] (labels from API).
    if (isClaude && Array.isArray(rl?.scoped)) {
      for (const sc of rl.scoped) {
        if (!sc) continue;
        limitsPanel.append(
          limitRow(sc.label || 'Scoped limit', sc, limitSrc),
        );
      }
    }
    if (isClaude && rl?.extraUsage) {
      const eu = rl.extraUsage;
      if (eu.enabled) {
        // Progress bar only while extra usage is on — caption shows $ used/limit/left.
        limitsPanel.append(
          limitRow(
            'Usage credits',
            eu,
            limitSrc,
            fmtCreditsHint(eu) || 'monthly extra usage',
          ),
        );
        if (!compact) {
          limitsPanel.append(
            el(
              'div',
              { class: 'note' },
              'Usage credits are a monthly spend cap for extra usage after you hit plan rate limits — not the 5-hour / weekly windows.',
            ),
          );
        }
      } else if (eu.balance != null && !compact) {
        // Extra usage off: no % bar. Still show a real balance when Anthropic returns one.
        limitsPanel.append(
          el(
            'div',
            { class: 'note' },
            `Usage credit balance: ${fmtMoney(eu.balance)} (extra usage off — not a rate-limit window).`,
          ),
        );
      }
    }

    if (!hasLimits) {
      const why =
        p.liveError === 'no-credential'
          ? 'No CLI credential found — showing local token totals only.'
          : p.liveError
            ? `Live limits unavailable (${p.liveError}) — showing local token totals.`
            : 'Live rate-limit % unavailable — showing local token totals.';
      limitsPanel.append(el('div', { class: 'note' }, why));
    } else if (isCodex && !compact) {
      limitsPanel.append(
        el(
          'div',
          { class: 'note' },
          'These are from Codex’s last on-disk snapshot, so they only change when you actually run Codex.',
        ),
      );
    }
  }

  return limitsPanel;
}

function buildTokensPanel(key, p) {
  const isClaude = key === 'claude';
  const isCursor = key === 'cursor';
  const tokensPanel = el('div', { class: 'card-panel card-tokens' });

  const tokenSrcLabel = isCursor ? 'from Cursor dashboard API' : 'counted from local logs';
  const tokenWindowLabel = isCursor
    ? p.tokens?.windowLabel || 'current period'
    : 'last 30 days';
  tokensPanel.append(
    el('div', { class: 'section-label' }, [
      `Token usage · ${tokenWindowLabel}`,
      el('span', { class: 'section-src' }, tokenSrcLabel),
    ]),
  );

  const t = p.tokens || {};
  const stats = el('div', { class: 'stats' });

  if (isClaude || isCursor) {
    // Cache reads dominate both Claude and Cursor totals — keep them distinct.
    const realWork = (t.inputTokens || 0) + (t.outputTokens || 0);
    const cacheReads = t.cacheReadTokens || 0;
    stats.append(
      stat('Real work', fmtCompact(realWork), 'prompts + replies (in + out)', {
        tip: 'Actual input + output tokens — the real prompt/response volume, excluding cached context.',
      }),
    );
    stats.append(
      stat('Cache reads', fmtCompact(cacheReads), 'cached context re-read', {
        tip: 'Cached context re-read on each turn. Large by design; it inflates the raw total but is not new work.',
      }),
    );
    stats.append(stat('Output', fmtCompact(t.outputTokens), 'tokens generated'));
    if (isClaude) {
      stats.append(stat('Sessions', fmtCompact(t.sessions), 'conversations in 30d'));
    } else {
      stats.append(
        stat('Est. cost', fmtMoney(t.estCostUSD), 'from Cursor totals', {
          tip: 'Sum of totalCents from Cursor’s aggregated usage events for this period — not a separate bill estimate.',
        }),
      );
    }
    tokensPanel.append(stats);

    if (isClaude) {
      tokensPanel.append(
        el(
          'div',
          {
            class: 'cost-note',
            title:
              'What these tokens would cost at pay-as-you-go API list prices. You are on a flat subscription — this is NOT a bill.',
          },
          [
            el('span', {}, 'If billed at API rates: '),
            el('strong', {}, fmtMoney(t.estCostUSD)),
            el('span', { class: 'cost-cap' }, ' — hypothetical; your subscription is flat-rate'),
          ],
        ),
      );
    }
  } else {
    // Codex's input_tokens is INCLUSIVE of cached_input_tokens.
    const cached = t.cachedInputTokens || 0;
    const realInput = Math.max(0, (t.inputTokens || 0) - cached);
    stats.append(
      stat('Real input', fmtCompact(realInput), 'sent, excluding cache', {
        tip: 'Input tokens minus cached input — the non-cached tokens you + tools actually sent.',
      }),
    );
    stats.append(stat('Output', fmtCompact(t.outputTokens), 'tokens Codex generated'));
    stats.append(
      stat('Cache reads', fmtCompact(cached), 'cached input re-read', {
        tip: 'Cached input tokens re-read across turns — included in Codex’s raw input count, shown separately here.',
      }),
    );
    stats.append(stat('Sessions', fmtCompact(t.sessions), 'conversations in 30d'));
    tokensPanel.append(stats);
  }

  return tokensPanel;
}

function buildTrendPanel(key, p, accent) {
  const isClaude = key === 'claude';
  const isCursor = key === 'cursor';
  const isCodex = key === 'codex';
  const t = p.tokens || {};
  const trend = el('div', { class: 'card-trend' });

  if (t.daily && Object.keys(t.daily).length) {
    trend.append(
      el('div', { class: 'section-label' }, [
        isClaude ? 'Daily tokens' : 'Session tokens',
        el('span', { class: 'section-src' }, 'per day, 30 days'),
      ]),
    );
    trend.append(sparkline(t.daily, accent));
  } else if (isCursor) {
    trend.append(
      el('div', { class: 'note' }, 'Per-day sparkline isn’t shown for Cursor — the aggregated endpoint returns totals by model, not by day.'),
    );
  }

  if ((isClaude || isCursor) && t.byModel && Object.keys(t.byModel).length) {
    trend.append(
      el('div', { class: 'section-label' }, [
        'By model',
        el('span', { class: 'section-src' }, 'share of tokens (incl. cache)'),
      ]),
    );
    const models = el('div', { class: 'models' });
    const entries = Object.entries(t.byModel)
      .map(([m, v]) => [
        m,
        (v.inputTokens || 0) +
          (v.outputTokens || 0) +
          (v.cacheReadTokens || 0) +
          (v.cacheCreationTokens || 0) +
          (v.cacheWriteTokens || 0),
      ])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    const max = Math.max(1, ...entries.map((e) => e[1]));
    for (const [model, tot] of entries) {
      const short = model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
      models.append(
        el('div', { class: 'model-row' }, [
          el('span', { class: 'model-name', title: model }, short),
          el('span', { class: 'model-val' }, fmtCompact(tot)),
          el('div', { class: 'model-track' }, [el('span', { style: `width:${(tot / max) * 100}%` })]),
        ]),
      );
    }
    trend.append(models);
  } else if (isCodex) {
    trend.append(
      el('div', { class: 'note' }, 'Per-model breakdown isn’t shown for Codex — its logs don’t split tokens by model.'),
    );
  }

  return trend.childNodes.length ? trend : null;
}

function providerCard(key, p, { extraOpen } = {}) {
  const meta = PROVIDER_META[key];
  const compact = isCompactLayout();
  const card = el('div', {
    class: compact ? 'card card-compact' : 'card',
    style: `--accent:${meta.accent}`,
    'data-provider': key,
  });

  const rl = p?.rateLimits;
  const isClaude = key === 'claude';
  const isCursor = key === 'cursor';
  const hasLimits = !!rl;

  // Header chip is honest about provenance:
  //  Claude/Cursor -> "live"
  //  Codex         -> "snapshot Xm ago"
  let chipText, chipCls, chipTip;
  if (!hasLimits) {
    chipText = 'tokens only';
    chipCls = 'chip fallback';
    chipTip = 'Live rate-limit % unavailable — showing local/token totals only.';
  } else if (isClaude) {
    chipText = rl.stale ? 'live (cached)' : 'live';
    chipCls = 'chip live';
    chipTip = 'Fetched live from Anthropic (api.anthropic.com/api/oauth/usage), refreshed every few minutes.';
  } else if (isCursor) {
    chipText = rl.stale ? 'live (cached)' : 'live';
    chipCls = 'chip live';
    chipTip =
      'Fetched live from Cursor (cursor.com/api/usage-summary). Plan % matches Spending "Total Usage" (billing-cycle cutoff), not a 5-hour window.';
  } else {
    chipText = `snapshot · ${fmtAge(rl.capturedAt)}`;
    chipCls = 'chip snapshot';
    chipTip =
      'Read from the snapshot Codex wrote to disk on its last run. Not fetched live — it only updates when you use Codex.';
  }

  let subText;
  if (isClaude) {
    subText = [p?.subscriptionType ? p.subscriptionType.toUpperCase() : null, meta.sub].filter(Boolean).join(' · ');
  } else if (isCursor) {
    subText = [p?.membershipType ? p.membershipType.toUpperCase() : null, meta.sub].filter(Boolean).join(' · ');
  } else {
    subText = [p?.planType ? p.planType.toUpperCase() : null, meta.sub].filter(Boolean).join(' · ');
  }

  card.append(
    el('div', { class: 'card-head' }, [
      el('div', { class: 'card-logo', style: `background:${meta.accent}` }, meta.logo),
      el('div', {}, [
        el('div', { class: 'card-title' }, meta.name),
        el('div', { class: 'card-sub' }, subText),
      ]),
      el('span', { class: chipCls, title: chipTip }, chipText),
    ]),
  );

  const body = el('div', { class: 'card-body' });

  if (!p || !p.available) {
    body.append(el('div', { class: 'unavailable' }, `No ${meta.name} data found on this machine.`));
    card.append(body);
    return card;
  }

  // Limits always live on the card (no separate summary strip).
  body.append(buildLimitsPanel(key, p, { compact }));

  // Compact: bars-only glanceable overview — no tokens / sparklines / accordion.
  if (compact) {
    card.append(body);
    return card;
  }

  const tokensPanel = buildTokensPanel(key, p);
  const trend = buildTrendPanel(key, p, meta.accent);

  // Tokens sit inside <details> (accordion on narrow). Trend is a sibling of
  // details so it is a real .card-body grid item — Chromium ignores
  // grid-column when the element is nested under display:contents on
  // <details>, which trapped the footer in the tokens column on wide cards.
  // Narrow CSS hides .card-trend when the accordion is closed.
  // Preserve user-expanded accordion across 30s refreshes when stacked.
  const extra = el('details', { class: 'card-extra' });
  const wantOpen = isStackedViewport() ? !!extraOpen : true;
  if (wantOpen) extra.setAttribute('open', '');
  extra.append(
    el('summary', { class: 'card-extra-summary' }, 'Token usage & more'),
  );
  const extraBody = el('div', { class: 'card-extra-body' });
  extraBody.append(tokensPanel);
  extra.append(extraBody);
  body.append(extra);
  if (trend) body.append(trend);

  card.append(body);
  return card;
}

// ---------- skeletons (shown before first data arrives) ----------
function skeletonCard() {
  const compact = isCompactLayout();
  const limits = el('div', { class: 'card-panel card-limits' }, [
    el('span', { class: 'sk sk-line', style: 'width:42%' }),
    el('div', { class: 'sk sk-bar-lg' }),
    el('span', { class: 'sk sk-line', style: 'width:34%' }),
    el('div', { class: 'sk sk-bar-lg' }),
  ]);

  if (compact) {
    return el('div', { class: 'card card-compact skeleton' }, [
      el('div', { class: 'card-head' }, [
        el('div', { class: 'sk sk-logo' }),
        el('div', { style: 'flex:1;min-width:0' }, [
          el('div', { class: 'sk sk-line', style: 'width:35%;margin-bottom:6px' }),
          el('div', { class: 'sk sk-line', style: 'width:55%' }),
        ]),
      ]),
      el('div', { class: 'card-body' }, [limits]),
    ]);
  }

  const stats = el('div', { class: 'stats' }, [
    0, 1, 2, 3,
  ].map(() =>
    el('div', { class: 'stat' }, [
      el('span', { class: 'sk sk-line', style: 'width:55%' }),
      el('span', { class: 'sk sk-num' }),
    ]),
  ));

  const tokens = el('div', { class: 'card-panel card-tokens' }, [
    el('div', { class: 'section-label' }, [
      el('span', { class: 'sk sk-line', style: 'width:48%' }),
    ]),
    stats,
  ]);

  const trend = el('div', { class: 'card-trend' }, [
    el('div', { class: 'section-label' }, [
      el('span', { class: 'sk sk-line', style: 'width:40%' }),
    ]),
    el('div', { class: 'sk sk-spark' }),
  ]);

  // Mirror live cards: tokens in .card-extra, trend as .card-body sibling
  // so wide layouts can span the footer across both columns.
  const extra = el('details', { class: 'card-extra' });
  if (!isStackedViewport()) extra.setAttribute('open', '');
  extra.append(el('summary', { class: 'card-extra-summary' }, 'Token usage & more'));
  extra.append(el('div', { class: 'card-extra-body' }, [tokens]));

  return el('div', { class: 'card skeleton' }, [
    el('div', { class: 'card-head' }, [
      el('div', { class: 'sk sk-logo' }),
      el('div', { style: 'flex:1;min-width:0' }, [
        el('div', { class: 'sk sk-line', style: 'width:35%;margin-bottom:6px' }),
        el('div', { class: 'sk sk-line', style: 'width:55%' }),
      ]),
    ]),
    el('div', { class: 'card-body' }, [limits, extra, trend]),
  ]);
}

function renderSkeletons() {
  const container = document.getElementById('providers');
  container.innerHTML = '';
  for (const _ of visibleKeys()) container.append(skeletonCard());
}

function renderProviders(providers) {
  const container = document.getElementById('providers');
  // Remember which narrow-view accordions the user expanded so a 30s refresh
  // doesn't slam them shut.
  const openExtras = {};
  for (const card of container.querySelectorAll('.card[data-provider]')) {
    const key = card.getAttribute('data-provider');
    const details = card.querySelector('details.card-extra');
    if (key && details) openExtras[key] = details.open;
  }
  container.innerHTML = '';
  for (const key of visibleKeys()) {
    container.append(providerCard(key, providers[key], { extraOpen: openExtras[key] }));
  }
}

// ---------- settings modal ----------
let lastProviders = null;

function openSettings() {
  const modal = document.getElementById('settings-modal');
  const form = document.getElementById('settings-form');
  const hint = document.getElementById('settings-hint');
  const themeSelect = document.getElementById('theme-select');
  const compactCheck = document.getElementById('compact-check');
  if (!modal || !form) return;
  for (const input of form.querySelectorAll('input[name="tool"]')) {
    input.checked = !!visibleTools[input.value];
  }
  if (themeSelect) themeSelect.value = currentTheme;
  if (compactCheck) compactCheck.checked = currentLayout === 'compact';
  if (hint) hint.hidden = true;
  modal.hidden = false;
  document.body.classList.add('modal-open');
  const first = form.querySelector('input[name="tool"]');
  if (first) first.focus();
}

function closeSettings() {
  const modal = document.getElementById('settings-modal');
  if (!modal) return;
  modal.hidden = true;
  document.body.classList.remove('modal-open');
}

function initSettings() {
  const btn = document.getElementById('settings-btn');
  const modal = document.getElementById('settings-modal');
  const form = document.getElementById('settings-form');
  if (!btn || !modal || !form) return;

  btn.addEventListener('click', openSettings);
  modal.addEventListener('click', (e) => {
    if (e.target && e.target.getAttribute('data-close') === '1') closeSettings();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeSettings();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const next = { claude: false, codex: false, cursor: false };
    for (const input of form.querySelectorAll('input[name="tool"]')) {
      next[input.value] = !!input.checked;
    }
    const hint = document.getElementById('settings-hint');
    if (!ALL_PROVIDERS.some((k) => next[k])) {
      if (hint) hint.hidden = false;
      return;
    }
    if (hint) hint.hidden = true;
    visibleTools = next;
    saveVisibleTools(visibleTools);

    const themeSelect = document.getElementById('theme-select');
    const nextTheme = themeSelect ? themeSelect.value : 'system';
    currentTheme = saveTheme(nextTheme);

    const compactCheck = document.getElementById('compact-check');
    currentLayout = saveLayout(compactCheck && compactCheck.checked ? 'compact' : 'default');

    closeSettings();
    if (lastProviders) {
      renderProviders(lastProviders);
    } else {
      renderSkeletons();
    }
  });
}

// ---------- refresh countdown ----------
let nextRefreshAt = 0;
function tickCountdown() {
  const elc = document.getElementById('countdown');
  if (!elc) return;
  if (!nextRefreshAt) {
    elc.textContent = '';
    return;
  }
  const secs = Math.max(0, Math.round((nextRefreshAt - Date.now()) / 1000));
  elc.textContent = secs <= 0 ? 'refreshing…' : `next refresh in ${secs}s`;
}

// ---------- fetch + render loop ----------
async function refresh() {
  const dot = document.getElementById('status-dot');
  const updated = document.getElementById('updated');
  // Schedule the next tick's target up front so the countdown is accurate even
  // while this fetch is in flight.
  nextRefreshAt = Date.now() + REFRESH_MS;
  try {
    const res = await fetch('/api/usage', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const providers = data.providers || {};
    lastProviders = providers;

    renderProviders(providers);

    const anyLive = visibleKeys().some((k) => providers[k]?.rateLimits);
    dot.className = anyLive ? 'dot live' : 'dot';
    updated.textContent =
      'Updated ' + new Date(data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (err) {
    dot.className = 'dot error';
    updated.textContent = 'Connection error';
    console.error(err);
  }
  tickCountdown();
}

initSettings();
renderSkeletons();
refresh();
setInterval(refresh, REFRESH_MS);
setInterval(tickCountdown, 1000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});
