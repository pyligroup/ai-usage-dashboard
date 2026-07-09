// AI Usage — Übersicht desktop widget
// Polls the local dashboard via curl (more reliable than fetch in WKWebView).
// Display rules mirror macos/shared/summary.mjs (keep in sync):
//   Claude / Codex → binding max(5-hour, weekly) as the big number
//   Cursor         → plan headline + auto secondary (never "5-hour")
//   Codex          → "snapshot · age" from capturedAt (never "live")
//
// Install: symlink into Übersicht widgets folder (see macos/README.md).
// Requires `npm start` in ai-usage-dashboard → http://127.0.0.1:4317

export const refreshFrequency = 30 * 1000;

// Shell command — Übersicht runs this and passes stdout to updateState/render.
export const command = 'curl -sf --max-time 5 http://127.0.0.1:4317/api/usage';

export const className = `
  top: 48px;
  right: 24px;
  width: 320px;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
  color: rgba(255, 255, 255, 0.92);
  background: rgba(22, 24, 28, 0.78);
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 14px;
  padding: 12px 14px 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
  z-index: 50;
`;

export const initialState = { data: null, error: null };

export const updateState = (event, prev) => {
  // Übersicht passes { output, error } from the shell command.
  if (event.error) {
    return { data: null, error: String(event.error) };
  }
  const raw = (event.output || '').trim();
  if (!raw) {
    return { data: null, error: 'empty response — is npm start running?' };
  }
  try {
    return { data: JSON.parse(raw), error: null };
  } catch (err) {
    return { data: null, error: `bad JSON: ${err.message}` };
  }
};

function fmtPct(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return `${Math.round(Number(n))}%`;
}

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

function severityColor(pct) {
  if (pct == null) return 'rgba(255,255,255,0.35)';
  if (pct >= 90) return '#f87171';
  if (pct >= 70) return '#fbbf24';
  return '#4ade80';
}

function bindingPct(...windows) {
  let max = null;
  for (const w of windows) {
    const n = w?.usedPercent;
    if (n == null || Number.isNaN(Number(n))) continue;
    const v = Number(n);
    if (max == null || v > max) max = v;
  }
  return max;
}

function bindingLabel(rl, binding) {
  if (binding == null || !rl) return 'limit';
  const five = rl.fiveHour?.usedPercent;
  const week = rl.weekly?.usedPercent;
  const opus = rl.opusWeekly?.usedPercent;
  if (opus != null && Number(opus) === binding) return 'weekly (opus)';
  if (week != null && Number(week) === binding) return 'weekly';
  if (five != null && Number(five) === binding) return '5-hour';
  return 'limit';
}

function summarize(key, provider) {
  const rl = provider?.rateLimits;
  const ok = provider?.available && rl;

  if (key === 'cursor') {
    return {
      label: 'Cursor',
      accent: '#a78bfa',
      headlineLabel: 'plan',
      headlinePct: ok ? rl.plan?.usedPercent ?? null : null,
      secondaryText: ok
        ? `auto ${fmtPct(rl.auto?.usedPercent)}`
        : 'auto —',
      caption: ok
        ? rl.stale
          ? 'live (cached)'
          : rl.fetchedAt
            ? `live · ${fmtAge(rl.fetchedAt)}`
            : 'live'
        : 'no data',
    };
  }

  if (key === 'codex') {
    const bind = ok ? bindingPct(rl.fiveHour, rl.weekly) : null;
    return {
      label: 'Codex',
      accent: '#38bdf8',
      headlineLabel: ok ? bindingLabel(rl, bind) : 'limit',
      headlinePct: bind,
      secondaryText: ok
        ? `5h ${fmtPct(rl.fiveHour?.usedPercent)} · wk ${fmtPct(rl.weekly?.usedPercent)}`
        : '5h — · wk —',
      caption: ok ? `snapshot · ${fmtAge(rl.capturedAt)}` : 'no data',
    };
  }

  const bind = ok ? bindingPct(rl.fiveHour, rl.weekly, rl.opusWeekly) : null;
  return {
    label: 'Claude',
    accent: '#fb923c',
    headlineLabel: ok ? bindingLabel(rl, bind) : 'limit',
    headlinePct: bind,
    secondaryText: ok
      ? `5h ${fmtPct(rl.fiveHour?.usedPercent)} · wk ${fmtPct(rl.weekly?.usedPercent)}`
      : '5h — · wk —',
    caption: ok
      ? rl.stale
        ? 'live (cached)'
        : rl.fetchedAt
          ? `live · ${fmtAge(rl.fetchedAt)}`
          : 'live'
      : 'no data',
  };
}

function column(s) {
  const color = severityColor(s.headlinePct);
  return (
    <div key={s.label} style={{ flex: 1, minWidth: 0 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: s.accent,
          marginBottom: 4,
        }}
      >
        {s.label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 650, color, lineHeight: 1.1 }}>
        {fmtPct(s.headlinePct)}
      </div>
      <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', marginTop: 2 }}>
        {s.headlineLabel}
      </div>
      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', marginTop: 6 }}>
        {s.secondaryText}
      </div>
      <div
        style={{
          fontSize: 9,
          color: 'rgba(255,255,255,0.4)',
          marginTop: 6,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {s.caption}
      </div>
    </div>
  );
}

export const render = (state) => {
  if (state.error || !state.data) {
    return (
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>AI Usage</div>
        <div style={{ fontSize: 11, color: 'rgba(248,113,113,0.95)', lineHeight: 1.35 }}>
          Dashboard offline — run <code style={{ fontSize: 10 }}>npm start</code>
        </div>
        <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', marginTop: 6 }}>
          {state.error || 'no response'}
        </div>
      </div>
    );
  }

  const p = state.data.providers || {};
  const cols = [
    summarize('claude', p.claude),
    summarize('codex', p.codex),
    summarize('cursor', p.cursor),
  ];

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 10,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 650, letterSpacing: '0.02em' }}>AI Usage</div>
        <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)' }}>localhost:4317</div>
      </div>
      <div style={{ display: 'flex', gap: 12 }}>{cols.map(column)}</div>
    </div>
  );
};
