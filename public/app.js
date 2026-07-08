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
function summaryTile({ provider, label, pct, resetsAt, missing }) {
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
  tile.append(el('div', { class: 'tile-sub' }, fmtReset(resetsAt) || ' '));
  const bar = el('div', { class: 'tile-bar' });
  bar.append(el('span', { style: `width:${Math.min(100, pct)}%;background:${color}` }));
  tile.append(bar);
  return tile;
}

function renderSummary(providers) {
  const grid = document.getElementById('summary-grid');
  grid.innerHTML = '';
  for (const key of ['claude', 'codex']) {
    const p = providers[key];
    const rl = p && p.rateLimits;
    // 5-hour tile
    grid.append(
      summaryTile({
        provider: key,
        label: '5-hour',
        pct: rl?.fiveHour?.usedPercent,
        resetsAt: rl?.fiveHour?.resetsAt,
        missing: !rl?.fiveHour,
      }),
    );
    // weekly tile
    grid.append(
      summaryTile({
        provider: key,
        label: 'weekly',
        pct: rl?.weekly?.usedPercent,
        resetsAt: rl?.weekly?.resetsAt,
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
function limitRow(name, win) {
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
    el('div', { class: 'limit-reset' }, fmtReset(win.resetsAt) || ' '),
  ]);
}

function providerCard(key, p) {
  const meta = PROVIDER_META[key];
  const card = el('div', { class: 'card', style: `--accent:${meta.accent}` });

  // header
  const isLive = p?.source === 'live-endpoint' || p?.source === 'local-rollout';
  const subText = key === 'claude'
    ? [p?.subscriptionType ? p.subscriptionType.toUpperCase() : null, meta.sub].filter(Boolean).join(' · ')
    : [p?.planType ? p.planType.toUpperCase() : null, meta.sub].filter(Boolean).join(' · ');
  const chipText = isLive ? 'live' : 'tokens only';
  const chipCls = isLive ? 'chip live' : 'chip fallback';
  card.append(
    el('div', { class: 'card-head' }, [
      el('div', { class: 'card-logo', style: `background:${meta.accent}` }, meta.logo),
      el('div', {}, [
        el('div', { class: 'card-title' }, meta.name),
        el('div', { class: 'card-sub' }, subText),
      ]),
      el('span', { class: chipCls }, chipText),
    ]),
  );

  const body = el('div', { class: 'card-body' });

  if (!p || !p.available) {
    body.append(el('div', { class: 'unavailable' }, `No ${meta.name} data found on this machine.`));
    card.append(body);
    return card;
  }

  // rate limits
  const rl = p.rateLimits;
  body.append(limitRow('5-hour window', rl?.fiveHour));
  body.append(limitRow('Weekly window', rl?.weekly));
  if (rl?.opusWeekly) body.append(limitRow('Weekly (Opus)', rl.opusWeekly));

  if (!rl) {
    const why = p.liveError === 'no-credential'
      ? 'No CLI credential found — showing local token totals only.'
      : p.liveError
        ? `Live limits unavailable (${p.liveError}) — showing local token totals.`
        : 'Live rate-limit % unavailable — showing local token totals.';
    body.append(el('div', { class: 'note' }, why));
  }

  body.append(el('div', { class: 'divider' }));

  // token stats (last 30d)
  const t = p.tokens || {};
  const stats = el('div', { class: 'stats' });
  stats.append(
    el('div', { class: 'stat' }, [
      el('div', { class: 'stat-k' }, 'Tokens · 30d'),
      el('div', { class: 'stat-v' }, fmtCompact(t.totalTokens)),
    ]),
  );
  stats.append(
    el('div', { class: 'stat' }, [
      el('div', { class: 'stat-k' }, 'Sessions · 30d'),
      el('div', { class: 'stat-v' }, fmtCompact(t.sessions)),
    ]),
  );
  if (key === 'claude') {
    stats.append(
      el('div', { class: 'stat' }, [
        el('div', { class: 'stat-k' }, 'Output tokens'),
        el('div', { class: 'stat-v' }, fmtCompact(t.outputTokens)),
      ]),
    );
    stats.append(
      el('div', { class: 'stat' }, [
        el('div', { class: 'stat-k' }, 'API-equiv value'),
        el('div', { class: 'stat-v' }, [fmtMoney(t.estCostUSD), ' ', el('small', {}, 'incl.')]),
      ]),
    );
  } else {
    stats.append(
      el('div', { class: 'stat' }, [
        el('div', { class: 'stat-k' }, 'Output tokens'),
        el('div', { class: 'stat-v' }, fmtCompact(t.outputTokens)),
      ]),
    );
    stats.append(
      el('div', { class: 'stat' }, [
        el('div', { class: 'stat-k' }, 'Input tokens'),
        el('div', { class: 'stat-v' }, fmtCompact(t.inputTokens)),
      ]),
    );
  }
  body.append(stats);

  // sparkline
  if (t.daily && Object.keys(t.daily).length) {
    body.append(el('div', { class: 'section-label' }, 'Daily tokens · 30 days'));
    body.append(sparkline(t.daily, meta.accent));
  }

  // per-model breakdown (Claude only — Codex logs don't split by model here)
  if (key === 'claude' && t.byModel && Object.keys(t.byModel).length) {
    body.append(el('div', { class: 'section-label' }, 'By model'));
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
  }

  card.append(body);
  return card;
}

// ---------- fetch + render loop ----------
async function refresh() {
  const dot = document.getElementById('status-dot');
  const updated = document.getElementById('updated');
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

    const anyLive =
      providers.claude?.rateLimits || providers.codex?.rateLimits;
    dot.className = anyLive ? 'dot live' : 'dot';
    updated.textContent =
      'Updated ' + new Date(data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (err) {
    dot.className = 'dot error';
    updated.textContent = 'Connection error';
    console.error(err);
  }
}

refresh();
setInterval(refresh, REFRESH_MS);
// Refresh reset countdowns every 30s implicitly via full refresh; also re-render
// on tab focus for immediate freshness.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});
