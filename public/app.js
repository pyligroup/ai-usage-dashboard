'use strict';

const REFRESH_MS = 30 * 1000;
const PROVIDER_META = {
  claude: { name: 'Claude', logo: 'C', accent: 'var(--claude)', sub: 'Anthropic · Claude Code' },
  codex: { name: 'Codex', logo: 'Cx', accent: 'var(--codex)', sub: 'OpenAI · Codex CLI' },
};

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

// ---------- summary strip ----------
// Each provider's rate-limit % has a different provenance. Say so plainly.
function limitSourceText(provider, rateLimits) {
  if (provider === 'claude') {
    return rateLimits?.stale
      ? 'live fetch (using last good value)'
      : 'live from Anthropic just now';
  }
  // codex — from the on-disk snapshot Codex last wrote
  const age = fmtAge(rateLimits?.capturedAt);
  return `snapshot Codex saved ${age}`;
}

function summaryTile({ provider, label, pct, resetsAt, sourceText, missing }) {
  const meta = PROVIDER_META[provider];
  const color = severityColor(pct);
  const tile = el('div', { class: 'tile', style: `--accent:${meta.accent}` });
  tile.append(
    el('div', { class: 'tile-head' }, [
      el('span', { class: 'tile-badge' }, meta.name),
      el('span', { class: 'tile-label' }, label),
    ]),
  );
  if (missing) {
    tile.append(el('div', { class: 'tile-value', style: 'color:var(--text-faint);font-size:20px' }, '—'));
    tile.append(el('div', { class: 'tile-sub' }, 'no live data'));
    return tile;
  }
  tile.append(
    el('div', { class: 'tile-value', style: `color:${color}` }, [
      String(Math.round(pct)),
      el('span', { class: 'pct' }, '%'),
    ]),
  );
  tile.append(el('div', { class: 'tile-sub' }, fmtReset(resetsAt) || ' '));
  const bar = el('div', { class: 'tile-bar' });
  bar.append(el('span', { style: `width:${Math.min(100, pct)}%;background:${color}` }));
  tile.append(bar);
  // provenance line — small, muted, always present
  tile.append(el('div', { class: 'tile-src' }, sourceText));
  return tile;
}

function renderSummary(providers) {
  const grid = document.getElementById('summary-grid');
  grid.innerHTML = '';
  for (const key of ['claude', 'codex']) {
    const p = providers[key];
    const rl = p && p.rateLimits;
    const src = rl ? limitSourceText(key, rl) : 'no data';
    grid.append(
      summaryTile({
        provider: key,
        label: '5-hour limit',
        pct: rl?.fiveHour?.usedPercent,
        resetsAt: rl?.fiveHour?.resetsAt,
        sourceText: src,
        missing: !rl?.fiveHour,
      }),
    );
    grid.append(
      summaryTile({
        provider: key,
        label: 'weekly limit',
        pct: rl?.weekly?.usedPercent,
        resetsAt: rl?.weekly?.resetsAt,
        sourceText: src,
        missing: !rl?.weekly,
      }),
    );
  }
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
function limitRow(name, win, sourceText) {
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
  return el('div', { class: 'limit-row' }, [
    el('div', { class: 'limit-top' }, [
      el('span', { class: 'limit-name' }, name),
      el('span', { class: 'limit-pct', style: `color:${color}` }, `${Math.round(pct)}%`),
    ]),
    el('div', { class: 'bar' }, [
      el('span', { style: `width:${Math.min(100, pct)}%;background:${color}` }),
    ]),
    el('div', { class: 'limit-reset' }, [
      fmtReset(win.resetsAt) || ' ',
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

function providerCard(key, p) {
  const meta = PROVIDER_META[key];
  const card = el('div', { class: 'card', style: `--accent:${meta.accent}` });

  const rl = p?.rateLimits;
  const isClaude = key === 'claude';
  const hasLimits = !!rl;

  // Header chip is honest about provenance:
  //  Claude -> "live" (fetched from Anthropic)
  //  Codex  -> "snapshot Xm ago" (read from disk, only as fresh as your last Codex run)
  let chipText, chipCls, chipTip;
  if (!hasLimits) {
    chipText = 'tokens only';
    chipCls = 'chip fallback';
    chipTip = 'Live rate-limit % unavailable — showing local token totals only.';
  } else if (isClaude) {
    chipText = rl.stale ? 'live (cached)' : 'live';
    chipCls = 'chip live';
    chipTip = 'Fetched live from Anthropic (api.anthropic.com/api/oauth/usage), refreshed every few minutes.';
  } else {
    chipText = `snapshot · ${fmtAge(rl.capturedAt)}`;
    chipCls = 'chip snapshot';
    chipTip =
      'Read from the snapshot Codex wrote to disk on its last run. Not fetched live — it only updates when you use Codex.';
  }

  const subText = isClaude
    ? [p?.subscriptionType ? p.subscriptionType.toUpperCase() : null, meta.sub].filter(Boolean).join(' · ')
    : [p?.planType ? p.planType.toUpperCase() : null, meta.sub].filter(Boolean).join(' · ');

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

  // ----- Rate limits (with per-provider provenance line) -----
  body.append(el('div', { class: 'section-label' }, 'Subscription rate limits'));
  const limitSrc = hasLimits
    ? isClaude
      ? rl.stale ? 'live (cached)' : 'live'
      : `saved ${fmtAge(rl.capturedAt)}`
    : null;
  body.append(limitRow('5-hour window', rl?.fiveHour, limitSrc));
  body.append(limitRow('Weekly window', rl?.weekly, limitSrc));
  if (rl?.opusWeekly) body.append(limitRow('Weekly (Opus)', rl.opusWeekly, limitSrc));

  if (!hasLimits) {
    const why = p.liveError === 'no-credential'
      ? 'No CLI credential found — showing local token totals only.'
      : p.liveError
        ? `Live limits unavailable (${p.liveError}) — showing local token totals.`
        : 'Live rate-limit % unavailable — showing local token totals.';
    body.append(el('div', { class: 'note' }, why));
  } else if (!isClaude) {
    body.append(
      el('div', { class: 'note' }, 'These are from Codex’s last on-disk snapshot, so they only change when you actually run Codex.'),
    );
  }

  body.append(el('div', { class: 'divider' }));

  // ----- Token usage (all computed locally from session logs, last 30 days) -----
  body.append(
    el('div', { class: 'section-label' }, [
      'Token usage · last 30 days',
      el('span', { class: 'section-src' }, 'counted from local logs'),
    ]),
  );

  const t = p.tokens || {};
  const stats = el('div', { class: 'stats' });

  if (isClaude) {
    // The headline "total" is dominated by cache reads (same context re-read each
    // turn). Split it so the real work isn't buried under the cache figure.
    const realWork = (t.inputTokens || 0) + (t.outputTokens || 0);
    const cacheReads = t.cacheReadTokens || 0;
    stats.append(
      stat('Real work', fmtCompact(realWork), 'prompts + replies (in + out)', {
        tip: 'Actual input + output tokens — the real prompt/response volume, excluding cached context.',
      }),
    );
    stats.append(
      stat('Cache reads', fmtCompact(cacheReads), 'cached context re-read', {
        tip: 'Cached context re-read on each turn. Large by design and cheap; it inflates the raw total but is not new work.',
      }),
    );
    stats.append(
      stat('Output', fmtCompact(t.outputTokens), 'tokens Claude generated'),
    );
    stats.append(
      stat('Sessions', fmtCompact(t.sessions), 'conversations in 30d'),
    );
    body.append(stats);

    // Cost, clearly framed as a hypothetical, on its own line.
    body.append(
      el('div', { class: 'cost-note', title: 'What these tokens would cost at pay-as-you-go API list prices. You are on a flat subscription — this is NOT a bill.' }, [
        el('span', {}, 'If billed at API rates: '),
        el('strong', {}, fmtMoney(t.estCostUSD)),
        el('span', { class: 'cost-cap' }, ' — hypothetical; your subscription is flat-rate'),
      ]),
    );
  } else {
    // Codex's input_tokens is INCLUSIVE of cached_input_tokens, so show real
    // (non-cached) input separately from cache reads — mirroring the Claude card,
    // so "Input" isn't inflated by cached context.
    const cached = t.cachedInputTokens || 0;
    const realInput = Math.max(0, (t.inputTokens || 0) - cached);
    stats.append(
      stat('Real input', fmtCompact(realInput), 'sent, excluding cache', {
        tip: 'Input tokens minus cached input — the non-cached tokens you + tools actually sent.',
      }),
    );
    stats.append(
      stat('Output', fmtCompact(t.outputTokens), 'tokens Codex generated'),
    );
    stats.append(
      stat('Cache reads', fmtCompact(cached), 'cached input re-read', {
        tip: 'Cached input tokens re-read across turns — included in Codex’s raw input count, shown separately here.',
      }),
    );
    stats.append(
      stat('Sessions', fmtCompact(t.sessions), 'conversations in 30d'),
    );
    body.append(stats);
  }

  // sparkline
  // Claude: attributed per message timestamp → true per-day.
  // Codex: rollout token counts are cumulative per session, so each session's
  // total lands on its last-active day — label it honestly as by-session, not
  // an exact per-day breakdown.
  if (t.daily && Object.keys(t.daily).length) {
    body.append(
      el('div', { class: 'section-label' }, [
        isClaude ? 'Daily tokens' : 'Session tokens',
        el('span', { class: 'section-src' }, isClaude ? 'per day, 30 days' : 'by session end-day, 30 days'),
      ]),
    );
    body.append(sparkline(t.daily, meta.accent));
  }

  // per-model breakdown (Claude only — Codex logs don't split tokens by model)
  if (isClaude && t.byModel && Object.keys(t.byModel).length) {
    body.append(
      el('div', { class: 'section-label' }, [
        'By model',
        el('span', { class: 'section-src' }, 'share of tokens (incl. cache)'),
      ]),
    );
    const models = el('div', { class: 'models' });
    const entries = Object.entries(t.byModel)
      .map(([m, v]) => [m, (v.inputTokens || 0) + (v.outputTokens || 0) + (v.cacheReadTokens || 0) + (v.cacheCreationTokens || 0)])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    const max = Math.max(1, ...entries.map((e) => e[1]));
    for (const [model, tot] of entries) {
      const short = model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
      models.append(
        el('div', { class: 'model-row' }, [
          el('span', { class: 'model-name' }, short),
          el('span', { class: 'model-val' }, fmtCompact(tot)),
          el('div', { class: 'model-track' }, [el('span', { style: `width:${(tot / max) * 100}%` })]),
        ]),
      );
    }
    body.append(models);
  } else if (!isClaude) {
    body.append(
      el('div', { class: 'note' }, 'Per-model breakdown isn’t shown for Codex — its logs don’t split tokens by model.'),
    );
  }

  card.append(body);
  return card;
}

// ---------- skeletons (shown before first data arrives) ----------
function skeletonTile() {
  return el('div', { class: 'tile skeleton-tile' }, [
    el('div', { class: 'tile-head' }, [
      el('span', { class: 'sk sk-badge' }),
      el('span', { class: 'sk sk-label' }),
    ]),
    el('span', { class: 'sk sk-value' }),
    el('span', { class: 'sk sk-sub' }),
    el('div', { class: 'tile-bar' }, [el('span', { class: 'sk-bar' })]),
    el('span', { class: 'sk sk-src' }),
  ]);
}

function skeletonCard() {
  const body = el('div', { class: 'card-body' }, [
    el('span', { class: 'sk sk-line', style: 'width:40%' }),
    el('div', { class: 'sk sk-bar-lg' }),
    el('span', { class: 'sk sk-line', style: 'width:30%' }),
    el('div', { class: 'sk sk-bar-lg' }),
    el('div', { class: 'divider' }),
    el('div', { class: 'stats' }, [0, 1, 2, 3].map(() => el('div', { class: 'stat' }, [el('span', { class: 'sk sk-line', style: 'width:55%' }), el('span', { class: 'sk sk-num' })]))),
  ]);
  return el('div', { class: 'card skeleton' }, [
    el('div', { class: 'card-head' }, [
      el('div', { class: 'sk sk-logo' }),
      el('div', { style: 'flex:1' }, [
        el('div', { class: 'sk sk-line', style: 'width:35%;margin-bottom:6px' }),
        el('div', { class: 'sk sk-line', style: 'width:55%' }),
      ]),
    ]),
    body,
  ]);
}

function renderSkeletons() {
  const grid = document.getElementById('summary-grid');
  grid.innerHTML = '';
  for (let i = 0; i < 4; i++) grid.append(skeletonTile());
  const container = document.getElementById('providers');
  container.innerHTML = '';
  container.append(skeletonCard(), skeletonCard());
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
let hasRenderedData = false;

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

    renderSummary(providers);

    const container = document.getElementById('providers');
    container.innerHTML = '';
    container.append(providerCard('claude', providers.claude));
    container.append(providerCard('codex', providers.codex));
    hasRenderedData = true;

    const anyLive = providers.claude?.rateLimits || providers.codex?.rateLimits;
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

renderSkeletons();
refresh();
setInterval(refresh, REFRESH_MS);
setInterval(tickCountdown, 1000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});
