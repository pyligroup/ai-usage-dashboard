// Terminal renderer for the usage dashboard.
//
// Pure formatting: takes the same normalized `providers` payload the browser
// gets from /api/usage and returns an array of ANSI-styled lines. No I/O, no
// process/tty access — `tui-entry` owns the terminal, this owns the pixels.
//
// The layout intentionally mirrors public/app.js section-for-section so the two
// views stay honest with each other. When you change a label, a caption, or a
// provenance chip in app.js, change it here too.

// ---------- ANSI ----------
// Truecolor where supported; the entry point sets `enabled=false` to strip all
// escapes when piping to a file or when NO_COLOR is set.
let COLOR = true;

export function setColorEnabled(on) {
  COLOR = !!on;
}

const ESC = '[';
function sgr(code, s) {
  return COLOR ? `${ESC}${code}m${s}${ESC}0m` : String(s);
}
function rgb(r, g, b, s) {
  return COLOR ? `${ESC}38;2;${r};${g};${b}m${s}${ESC}0m` : String(s);
}

const dim = (s) => sgr('2', s);
const bold = (s) => sgr('1', s);
const italic = (s) => sgr('3', s);

// Palette mirrors public/styles.css custom properties.
const C = {
  claude: [217, 119, 87], // --claude
  codex: [124, 168, 255], // --codex
  cursor: [167, 139, 250], // --cursor
  ok: [63, 185, 122], // --ok
  warn: [230, 168, 64], // --warn
  danger: [232, 90, 90], // --danger
  faint: [128, 128, 138], // --text-faint
};

const paint = (tuple, s) => rgb(tuple[0], tuple[1], tuple[2], s);

// `severityColor()` in app.js — identical thresholds.
function severityTuple(pct) {
  if (pct == null) return C.faint;
  if (pct >= 90) return C.danger;
  if (pct >= 70) return C.warn;
  return C.ok;
}

// East Asian Wide / Fullwidth ranges plus emoji — these occupy TWO terminal
// cells. Provider labels come from the APIs (model names, scoped-window labels),
// so we don't control them; counting UTF-16 units would under-measure a CJK or
// emoji label and let the line wrap, breaking the layout.
function isWideCodePoint(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, Kangxi
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana/Katakana/CJK compat
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compat forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // Misc symbols & pictographs, emoticons
    (cp >= 0x1f680 && cp <= 0x1f6ff) || // transport & map symbols (🚀)
    (cp >= 0x1f7e0 && cp <= 0x1f7eb) || // geometric shapes extended
    (cp >= 0x1f900 && cp <= 0x1f9ff) || // supplemental symbols & pictographs
    (cp >= 0x1fa70 && cp <= 0x1faff) || // symbols & pictographs extended-A
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+
  );
}

// Display width of one code point: 0 for combining marks / joiners, 2 for wide
// chars, else 1.
function charWidth(cp) {
  if (cp === 0x200d || cp === 0xfe0f || cp === 0xfe0e) return 0; // ZWJ, variation selectors
  if (cp >= 0x0300 && cp <= 0x036f) return 0; // combining diacriticals
  if (cp >= 0x1ab0 && cp <= 0x1aff) return 0;
  if (cp >= 0x20d0 && cp <= 0x20ff) return 0;
  return isWideCodePoint(cp) ? 2 : 1;
}

// Visible width in TERMINAL CELLS, ignoring ANSI escapes (which take zero
// columns) and accounting for wide / zero-width characters.
export function visibleWidth(s) {
  // eslint-disable-next-line no-control-regex
  const plain = String(s).replace(/\[[0-9;]*m/g, '');
  let w = 0;
  for (const ch of plain) w += charWidth(ch.codePointAt(0));
  return w;
}

// Take the longest prefix of plain (escape-free) text fitting `cells` columns, and
// return it with the remainder. Walks code points and counts display cells, so
// it never splits a surrogate pair or leaves half a wide char — the string-index
// slicing this replaces silently overflowed on CJK/emoji.
function sliceCells(str, cells) {
  let taken = '';
  let w = 0;
  let i = 0;
  while (i < str.length) {
    const cp = str.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (w + cw > cells) break;
    taken += ch;
    w += cw;
    i += ch.length;
  }
  // Guarantee forward progress: a single char wider than the budget still gets
  // emitted, otherwise the caller's while-loop would spin forever.
  if (!taken.length && i < str.length) {
    const ch = String.fromCodePoint(str.codePointAt(0));
    return [ch, str.slice(ch.length)];
  }
  return [taken, str.slice(i)];
}

function padEnd(s, width) {
  const gap = width - visibleWidth(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}

function padStart(s, width) {
  const gap = width - visibleWidth(s);
  return gap > 0 ? ' '.repeat(gap) + s : s;
}

// Truncate to a column budget without slicing an escape sequence in half or
// splitting a surrogate pair. Iterates by code point and counts display cells,
// so a wide (CJK/emoji) char consumes 2 of the budget and is dropped whole
// rather than leaving half a character behind.
function truncate(s, width) {
  if (visibleWidth(s) <= width) return s;
  const str = String(s);
  let out = '';
  let w = 0;
  let i = 0;
  const budget = width - 1; // leave a cell for the ellipsis
  while (i < str.length) {
    if (str[i] === '') {
      const end = str.indexOf('m', i);
      if (end === -1) break;
      out += str.slice(i, end + 1); // escapes are free
      i = end + 1;
      continue;
    }
    const cp = str.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (w + cw > budget) break;
    out += ch;
    w += cw;
    i += ch.length; // advances 2 for surrogate pairs
  }
  return out + (COLOR ? `${ESC}0m…` : '…');
}

// ---------- shared formatters (ported from public/app.js) ----------
export function fmtCompact(n) {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
  return String(Math.round(n));
}

export function fmtMoney(n) {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1000) return '$' + Math.round(n).toLocaleString();
  return '$' + n.toFixed(2);
}

export function fmtReset(resetsAt, now = Date.now()) {
  if (!resetsAt) return '';
  const ms = resetsAt - now;
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

export function fmtAge(tsMs, now = Date.now()) {
  if (!tsMs) return 'unknown';
  const ms = now - tsMs;
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

// Codex % only moves when a rollout with rate_limits lands on disk (see
// CLAUDE.md). Past ~1h, warn that ephemeral runs may have moved usage ahead.
const CODEX_STALE_MS = 60 * 60 * 1000;

function isCodexSnapshotStale(capturedAt, now) {
  if (!capturedAt) return true;
  return now - capturedAt > CODEX_STALE_MS;
}

function fmtSpendPair(used, limit, { cents = false } = {}) {
  if (used == null && limit == null) return '';
  const scale = cents ? 0.01 : 1;
  const u = used == null ? null : used * scale;
  const l = limit == null ? null : limit * scale;
  if (u != null && l != null) return `${fmtMoney(u)} of ${fmtMoney(l)}`;
  if (u != null) return `${fmtMoney(u)} used`;
  return `${fmtMoney(l)} limit`;
}

function fmtCreditsHint(eu) {
  if (!eu) return '';
  const parts = [];
  const pair = fmtSpendPair(eu.used, eu.limit);
  if (pair) parts.push(pair);
  if (eu.remaining != null) parts.push(`${fmtMoney(eu.remaining)} left`);
  return parts.join(' · ');
}

function fmtCursorCreditsHint(c) {
  if (!c || c.remaining == null) return '';
  const rem = fmtMoney(c.remaining * 0.01);
  if (c.total != null) return `${rem} / ${fmtMoney(c.total * 0.01)} remaining`;
  return `${rem} remaining`;
}

// Fraction of a fixed-length window elapsed right now — drives the pace marker.
// Mirrors windowElapsedFraction() in app.js.
function windowElapsedFraction(win, now) {
  if (!win || !win.resetsAt) return null;
  let startMs = null;
  if (typeof win.windowStartsAt === 'number') {
    startMs = win.windowStartsAt;
  } else if (typeof win.windowMinutes === 'number' && win.windowMinutes > 0) {
    startMs = win.resetsAt - win.windowMinutes * 60000;
  }
  if (startMs == null) return null;
  const total = win.resetsAt - startMs;
  if (!(total > 0)) return null;
  return Math.max(0, Math.min(1, (now - startMs) / total));
}

export const PROVIDER_META = {
  claude: { name: 'Claude', accent: C.claude, sub: 'Anthropic · Claude Code' },
  codex: { name: 'Codex', accent: C.codex, sub: 'OpenAI · Codex CLI' },
  cursor: { name: 'Cursor', accent: C.cursor, sub: 'Anysphere · Cursor IDE' },
};

export const ALL_PROVIDERS = ['claude', 'codex', 'cursor'];

// ---------- primitives ----------
// The web bar is a filled track with an absolutely-positioned pace marker. Here
// the marker replaces one cell of the track, drawn on top of fill or empty.
function bar(pct, width, elapsed) {
  const clamped = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const tuple = severityTuple(pct);
  const cells = [];
  for (let i = 0; i < width; i++) {
    cells.push(i < filled ? { ch: '█', fill: true } : { ch: '░', fill: false });
  }
  if (elapsed != null && width > 0) {
    const idx = Math.max(0, Math.min(width - 1, Math.round(elapsed * width) - (elapsed >= 1 ? 1 : 0)));
    cells[idx] = { ch: '┃', pace: true, fill: cells[idx].fill };
  }
  return cells
    .map((c) => {
      if (c.pace) return COLOR ? sgr('1', paint(C.faint, c.ch)) : c.ch;
      return c.fill ? paint(tuple, c.ch) : dim(c.ch);
    })
    .join('');
}

// Narrowest bar worth drawing beside its meta text. Below this the side-by-side
// layout is pointless — stack instead.
const MIN_SIDE_BAR = 18;

/**
 * One rate-limit / plan row. Mirrors limitRow() in public/app.js.
 *
 * The layout is chosen per row by whether the meta text actually fits beside
 * the bar — not by a fixed width threshold. A row whose meta is long (Cursor's
 * "resets in 13d 23h · 55% elapsed · live") stacks sooner than a short one, and
 * nothing is ever truncated into uselessness ("82% e…", "$…").
 *
 * Side-by-side, when it fits:
 *   name ......................  47%
 *   [bar]  hint · resets in Xh · Y% elapsed · source
 *
 * Stacked, when it doesn't — bar spans the pane, meta wraps beneath it, so the
 * pane can be collapsed horizontally and stay readable:
 *   name ................  47%
 *   [bar]
 *   hint · resets in Xh · Y% elapsed · source
 */
function limitRow(name, win, sourceText, valueHint, ctx) {
  const { width, now, compact } = ctx;
  const out = [];

  const pct = win ? win.usedPercent : null;
  const elapsed = win ? windowElapsedFraction(win, now) : null;

  let tail;
  if (win) {
    const metaParts = [valueHint, fmtReset(win.resetsAt, now)];
    if (elapsed != null) metaParts.push(`${Math.round(elapsed * 100)}% elapsed`);
    tail = [metaParts.filter(Boolean).join(' · '), sourceText].filter(Boolean).join(' · ');
  } else {
    tail = 'no data';
  }

  // Side-by-side needs: 2 indent + bar + 2 gap + meta. Work out the bar width
  // that leaves room for the whole meta string, and stack if that's too thin.
  const sideBarW = Math.min(46, width - 2 - 2 - visibleWidth(tail));
  const stackMeta = sideBarW < MIN_SIDE_BAR;

  // Stacked: keep the % next to its label instead of flinging it to the far
  // edge — a 40-col gap between "Weekly window" and "17%" is hard to read.
  const nameW = stackMeta
    ? Math.min(26, Math.max(12, width - 10))
    : Math.min(24, Math.max(14, Math.floor(width * 0.24)));

  const pctLabel = pct == null ? dim('—') : paint(severityTuple(pct), `${Math.round(pct)}%`);
  out.push(truncate(`  ${padEnd(bold(name), nameW)} ${padStart(pctLabel, 5)}`, width));

  const barCells = win
    ? bar(pct, stackMeta ? Math.max(8, width - 4) : sideBarW, elapsed)
    : dim('░'.repeat(stackMeta ? Math.max(8, width - 4) : Math.max(10, sideBarW)));

  if (stackMeta) {
    out.push(`  ${barCells}`);
    if (tail) out.push(...wrapPlain(tail, width, '  '));
  } else {
    out.push(truncate(`  ${barCells}  ${dim(tail)}`, width));
  }

  if (!compact) out.push('');
  return out;
}

// Returns an array of lines: the source hint sits on the right when it fits,
// and drops to its own line when the pane is too narrow to hold both.
function sectionLabel(text, srcText, width) {
  const left = bold(paint(C.faint, text.toUpperCase()));
  const right = srcText ? dim(srcText) : '';
  if (!right) return [truncate(`  ${left}`, width)];
  const gap = width - visibleWidth(left) - visibleWidth(right) - 4;
  if (gap < 2) return [truncate(`  ${left}`, width), ...wrapPlain(srcText, width, '  ')];
  return [`  ${left}${' '.repeat(gap)}${right}`];
}

// Wrap dimmed text to the content width. Breaks on " · " separators first so a
// wrapped meta line splits between fields rather than mid-phrase; falls back to
// spaces when a single field is itself too long.
function wrapPlain(text, width, indent = '  ') {
  const budget = Math.max(12, width - indent.length);
  const fields = String(text).split(' · ');
  const lines = [];
  let line = '';
  for (const f of fields) {
    const candidate = line ? `${line} · ${f}` : f;
    if (visibleWidth(candidate) <= budget) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    // A lone field wider than the pane still has to break somewhere. Break on a
    // space when there is one inside the budget, else hard-cut by CELLS —
    // slicing by string index overflowed on CJK (a 2-cell char counted as 1).
    if (visibleWidth(f) > budget) {
      let rest = f;
      while (visibleWidth(rest) > budget) {
        const [head, tailRest] = sliceCells(rest, budget);
        const cut = head.lastIndexOf(' ');
        if (cut > 0) {
          lines.push(head.slice(0, cut));
          rest = rest.slice(cut).trimStart();
        } else {
          lines.push(head);
          rest = tailRest.trimStart();
        }
      }
      line = rest;
    } else {
      line = f;
    }
  }
  if (line) lines.push(line);
  return lines.map((l) => `${indent}${dim(l)}`);
}

// Wrap a plain-text note to the content width, indented and dimmed. Measures in
// display cells and hard-breaks a single over-long token (e.g. an unspaced
// provider error string) so it can't run off the edge.
function note(text, width, indent = '  ') {
  const budget = Math.max(20, width - visibleWidth(indent) - 2);
  const lines = [];
  let line = '';
  const flush = () => {
    if (line.length) lines.push(line);
    line = '';
  };
  for (const word of String(text).split(/\s+/)) {
    if (!word.length) continue;
    if (!line.length) {
      // A word longer than the whole budget gets hard-split across lines.
      let rest = word;
      while (visibleWidth(rest) > budget) {
        const [head, tailRest] = sliceCells(rest, budget);
        lines.push(head);
        rest = tailRest;
      }
      line = rest;
    } else if (visibleWidth(line) + 1 + visibleWidth(word) <= budget) {
      line += ' ' + word;
    } else {
      flush();
      let rest = word;
      while (visibleWidth(rest) > budget) {
        const [head, tailRest] = sliceCells(rest, budget);
        lines.push(head);
        rest = tailRest;
      }
      line = rest;
    }
  }
  flush();
  return lines.map((l) => `${indent}${dim(l)}`);
}

// ---------- panels ----------
function limitsPanel(key, p, ctx) {
  const { width, now, compact } = ctx;
  const rl = p?.rateLimits;
  const isClaude = key === 'claude';
  const isCursor = key === 'cursor';
  const isCodex = key === 'codex';
  const hasLimits = !!rl;
  const out = [];

  if (!compact) {
    out.push(...sectionLabel(isCursor ? 'Subscription plan usage' : 'Subscription rate limits', '', width));
    out.push('');
  }

  if (isCursor) {
    const src = hasLimits ? (rl.stale ? 'live (cached)' : 'live') : null;
    out.push(...limitRow('Plan (billing cycle)', rl?.plan, src, '', ctx));
    out.push(...limitRow('Auto models', rl?.auto, src, '', ctx));
    out.push(...limitRow('API / named models', rl?.api, src, '', ctx));

    const od = rl?.onDemand;
    if (od?.enabled) {
      out.push(
        ...limitRow(
          'On-demand credits',
          od,
          src,
          fmtSpendPair(od.used, od.limit, { cents: true }) || 'billing cycle',
          ctx,
        ),
      );
    }
    // Promo/referral Credits — only when a balance remains (matches app.js).
    const credits = rl?.credits;
    if (credits && credits.remaining > 0) {
      out.push(...limitRow('Credits', credits, src, fmtCursorCreditsHint(credits), ctx));
      if (!compact) {
        out.push(
          ...note(
            'Account credits (promo/referral) apply after included plan usage and before on-demand charges — not the billing-cycle plan bar.',
            width,
          ),
          '',
        );
      }
    }
    if (!hasLimits) {
      const why =
        p.liveError === 'no-credential'
          ? 'No Cursor session found — sign in to the Cursor app, then refresh.'
          : p.liveError
            ? `Live limits unavailable (${p.liveError}).`
            : 'Live plan % unavailable.';
      out.push(...note(why, width), '');
    }
    return out;
  }

  const src = hasLimits
    ? isClaude
      ? rl.stale
        ? 'live (cached)'
        : 'live'
      : `saved ${fmtAge(rl.capturedAt, now)}`
    : null;

  // Codex: omit windows absent from the newest snapshot (weekly-only is normal
  // now). Claude keeps both rows so a missing live window reads as "—".
  if (isCodex) {
    if (rl?.fiveHour) out.push(...limitRow('5-hour window', rl.fiveHour, src, '', ctx));
    if (rl?.weekly) out.push(...limitRow('Weekly window', rl.weekly, src, '', ctx));
  } else {
    out.push(...limitRow('5-hour window', rl?.fiveHour, src, '', ctx));
    out.push(...limitRow('Weekly window', rl?.weekly, src, '', ctx));
  }

  if (rl?.opusWeekly) out.push(...limitRow('Weekly (Opus)', rl.opusWeekly, src, '', ctx));

  // Dynamic scoped windows — labels come from the API, never hardcoded.
  if (isClaude && Array.isArray(rl?.scoped)) {
    for (const sc of rl.scoped) {
      if (!sc) continue;
      out.push(...limitRow(sc.label || 'Scoped limit', sc, src, '', ctx));
    }
  }

  if (isClaude && rl?.extraUsage) {
    const eu = rl.extraUsage;
    if (eu.enabled) {
      out.push(...limitRow('Usage credits', eu, src, fmtCreditsHint(eu) || 'monthly extra usage', ctx));
      if (!compact) {
        out.push(
          ...note(
            'Usage credits are a monthly spend cap for extra usage after you hit plan rate limits — not the 5-hour / weekly windows.',
            width,
          ),
          '',
        );
      }
    } else if (eu.balance != null && !compact) {
      out.push(
        ...note(
          `Usage credit balance: ${fmtMoney(eu.balance)} (extra usage off — not a rate-limit window).`,
          width,
        ),
        '',
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
    out.push(...note(why, width), '');
  } else if (isCodex && !compact) {
    const staleHint = isCodexSnapshotStale(rl.capturedAt, now)
      ? ' This snapshot looks old — chatgpt.com/codex/settings/usage may already be higher if you ran `codex exec --ephemeral` (or other non-persisted sessions) since then.'
      : '';
    out.push(
      ...note(
        `From Codex's last on-disk rollout under ~/.codex/sessions. Updates only when a session writes rate_limits — not for \`codex exec --ephemeral\`.${staleHint}`,
        width,
      ),
      '',
    );
  }

  return out;
}

// A stat tile rendered as label / value / caption, laid out in columns.
function statsRow(stats, width) {
  const cols = width >= 92 ? 4 : width >= 62 ? 2 : 1;
  const colW = Math.floor((width - 4) / cols);
  const out = [];
  for (let i = 0; i < stats.length; i += cols) {
    const group = stats.slice(i, i + cols);
    let l1 = '  ';
    let l2 = '  ';
    let l3 = '  ';
    for (const s of group) {
      l1 += padEnd(dim(s.label.toUpperCase()), colW);
      l2 += padEnd(bold(s.value), colW);
      l3 += padEnd(dim(truncate(s.caption || '', colW - 1)), colW);
    }
    out.push(truncate(l1.trimEnd(), width));
    out.push(truncate(l2.trimEnd(), width));
    out.push(truncate(l3.trimEnd(), width));
    if (i + cols < stats.length) out.push('');
  }
  return out;
}

function tokensPanel(key, p, ctx) {
  const { width } = ctx;
  const isClaude = key === 'claude';
  const isCursor = key === 'cursor';
  const t = p.tokens || {};
  const out = [];

  const srcLabel = isCursor ? 'from Cursor dashboard API' : 'counted from local logs';
  const windowLabel = isCursor ? t.windowLabel || 'current period' : 'last 30 days';
  out.push(...sectionLabel(`Token usage · ${windowLabel}`, srcLabel, width));
  out.push('');

  const stats = [];
  if (isClaude || isCursor) {
    // Cache reads dominate both totals — keep them distinct, never blended.
    const realWork = (t.inputTokens || 0) + (t.outputTokens || 0);
    stats.push({ label: 'Real work', value: fmtCompact(realWork), caption: 'prompts + replies' });
    stats.push({ label: 'Cache reads', value: fmtCompact(t.cacheReadTokens || 0), caption: 'cached context re-read' });
    stats.push({ label: 'Output', value: fmtCompact(t.outputTokens), caption: 'tokens generated' });
    if (isClaude) {
      stats.push({ label: 'Sessions', value: fmtCompact(t.sessions), caption: 'conversations in 30d' });
    } else {
      stats.push({ label: 'Est. cost', value: fmtMoney(t.estCostUSD), caption: 'from Cursor totals' });
    }
  } else {
    // Codex's input_tokens is INCLUSIVE of cached_input_tokens.
    const cached = t.cachedInputTokens || 0;
    const realInput = Math.max(0, (t.inputTokens || 0) - cached);
    stats.push({ label: 'Real input', value: fmtCompact(realInput), caption: 'sent, excluding cache' });
    stats.push({ label: 'Output', value: fmtCompact(t.outputTokens), caption: 'tokens Codex generated' });
    stats.push({ label: 'Cache reads', value: fmtCompact(cached), caption: 'cached input re-read' });
    stats.push({ label: 'Sessions', value: fmtCompact(t.sessions), caption: 'conversations in 30d' });
  }
  out.push(...statsRow(stats, width));

  if (isClaude) {
    out.push('');
    const costLine = `  ${dim('If billed at API rates:')} ${bold(fmtMoney(t.estCostUSD))} ${dim('— hypothetical; your subscription is flat-rate')}`;
    if (visibleWidth(costLine) <= width) {
      out.push(costLine);
    } else {
      // Never truncate this one — dropping "hypothetical" would leave a bare
      // dollar figure reading like a bill, which is exactly what it isn't.
      out.push(`  ${dim('If billed at API rates:')} ${bold(fmtMoney(t.estCostUSD))}`);
      out.push(...wrapPlain('hypothetical; your subscription is flat-rate', width, '  '));
    }
  }
  return out;
}

// Braille sparkline of the last 30 days. Two samples per cell (left/right dots)
// so a 30-day series fits in 15 columns at full resolution.
const BRAILLE_LEVELS = [
  [0x00, 0x40, 0x44, 0x46, 0x47],
  [0x00, 0x80, 0xa0, 0xb0, 0xb8],
];

function sparkline(dailyMap, accent, now) {
  const days = [];
  const today = new Date(now);
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const v = dailyMap[key];
    days.push(typeof v === 'number' ? v : v?.totalTokens || 0);
  }
  const max = Math.max(1, ...days);
  let s = '';
  for (let i = 0; i < days.length; i += 2) {
    const a = Math.round((days[i] / max) * 4);
    const b = Math.round(((days[i + 1] ?? 0) / max) * 4);
    s += String.fromCharCode(0x2800 | BRAILLE_LEVELS[0][a] | BRAILLE_LEVELS[1][b]);
  }
  return { line: paint(accent, s), max };
}

function trendPanel(key, p, ctx) {
  const { width, now } = ctx;
  const isClaude = key === 'claude';
  const isCursor = key === 'cursor';
  const isCodex = key === 'codex';
  const t = p.tokens || {};
  const out = [];

  if (t.daily && Object.keys(t.daily).length) {
    out.push(...sectionLabel(isClaude ? 'Daily tokens' : 'Session tokens', 'per day, 30 days', width));
    out.push('');
    const { line, max } = sparkline(t.daily, PROVIDER_META[key].accent, now);
    out.push(truncate(`  ${line}  ${dim(`peak ${fmtCompact(max)}/day`)}`, width));
    out.push('');
  } else if (isCursor) {
    out.push(
      ...note(
        "Per-day sparkline isn't shown for Cursor — the aggregated endpoint returns totals by model, not by day.",
        width,
      ),
      '',
    );
  }

  if ((isClaude || isCursor) && t.byModel && Object.keys(t.byModel).length) {
    out.push(...sectionLabel('By model', 'share of tokens (incl. cache)', width));
    out.push('');
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
    const nameW = Math.min(30, Math.max(16, Math.floor(width * 0.3)));
    // Line budget: 2 indent + nameW + 1 + 7 (value) + 2 gap + track. Long model
    // names (Cursor's "cursor-grok-4.5-high-fast") get clipped to nameW rather
    // than pushing the track off the right edge.
    const trackW = Math.max(6, Math.min(28, width - nameW - 12));
    for (const [model, tot] of entries) {
      const short = model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
      const label = padEnd(truncate(short, nameW), nameW);
      const filled = Math.round((tot / max) * trackW);
      // Skip zero-length runs — `dim('')` would emit a bare, pointless escape pair.
      const track =
        (filled > 0 ? paint(PROVIDER_META[key].accent, '▪'.repeat(filled)) : '') +
        (filled < trackW ? dim('·'.repeat(trackW - filled)) : '');
      out.push(truncate(`  ${label} ${padStart(dim(fmtCompact(tot)), 7)}  ${track}`, width));
    }
    out.push('');
  } else if (isCodex) {
    out.push(
      ...note("Per-model breakdown isn't shown for Codex — its logs don't split tokens by model.", width),
      '',
    );
  }

  return out;
}

// ---------- card ----------
function providerCard(key, p, ctx) {
  const { width, now, compact } = ctx;
  const meta = PROVIDER_META[key];
  const rl = p?.rateLimits;
  const isClaude = key === 'claude';
  const isCursor = key === 'cursor';
  const hasLimits = !!rl;
  const out = [];

  // Provenance chip — same honesty rules as the web header:
  //   Claude/Cursor -> live | live (cached);  Codex -> snapshot · age (never "live")
  let chip;
  let chipColor = C.faint;
  if (!hasLimits) {
    chip = 'tokens only';
  } else if (isClaude || isCursor) {
    chip = rl.stale ? 'live (cached)' : 'live';
    chipColor = C.ok;
  } else {
    const stale = isCodexSnapshotStale(rl.capturedAt, now);
    chip = stale ? `snapshot · ${fmtAge(rl.capturedAt, now)} · may lag` : `snapshot · ${fmtAge(rl.capturedAt, now)}`;
    chipColor = stale ? C.warn : C.faint;
  }

  const planLabel = isClaude
    ? p?.subscriptionType
    : isCursor
      ? p?.membershipType
      : p?.planType;
  const sub = [planLabel ? String(planLabel).toUpperCase() : null, meta.sub].filter(Boolean).join(' · ');

  // Header: ● Name  PLAN · vendor .................................. chip
  const left = `${paint(meta.accent, '●')} ${bold(paint(meta.accent, meta.name))}  ${dim(sub)}`;
  const right = paint(chipColor, chip);
  // Right-align the chip flush to `width` so the header lines up with the rule
  // below. Too narrow for both? Keep name + chip on top (the identity and the
  // provenance are the load-bearing bits) and wrap the plan/vendor underneath —
  // truncating would eat the chip, and a card that can't say "snapshot" is a
  // card that lies.
  const gap = width - visibleWidth(left) - visibleWidth(right);
  if (gap >= 1) {
    out.push(`${left}${' '.repeat(gap)}${right}`);
  } else {
    const nameOnly = `${paint(meta.accent, '●')} ${bold(paint(meta.accent, meta.name))}`;
    const nameGap = width - visibleWidth(nameOnly) - visibleWidth(right);
    out.push(
      nameGap >= 1
        ? `${nameOnly}${' '.repeat(nameGap)}${right}`
        : truncate(`${nameOnly} ${right}`, width),
    );
    if (sub) out.push(...wrapPlain(sub, width, '  '));
  }
  out.push(dim('─'.repeat(width)));
  out.push('');

  if (!p || !p.available) {
    out.push(...note(`No ${meta.name} data found on this machine.`, width));
    out.push('');
    return out;
  }

  out.push(...limitsPanel(key, p, ctx));

  // Compact: bars-only glanceable view — no tokens, sparklines, or notes.
  if (compact) {
    if (out[out.length - 1] !== '') out.push('');
    return out;
  }

  out.push(...tokensPanel(key, p, ctx));
  out.push('');
  out.push(...trendPanel(key, p, ctx));

  return out;
}

// ---------- frame ----------
/**
 * Render the whole dashboard.
 *
 * @param {object} payload   /api/usage shape: { generatedAt, providers }
 * @param {object} opts
 *   width      terminal columns
 *   compact    bars-only layout (mirrors the web "Compact view" setting)
 *   tools      provider keys to show (mirrors the ai_usage_tools cookie)
 *   now        clock injection for deterministic output
 *   nextRefreshAt, error, source
 * @returns {string[]} lines, ANSI-styled unless setColorEnabled(false)
 */
export function renderDashboard(payload, opts = {}) {
  const width = Math.max(40, Math.min(opts.width || 100, 120));
  const now = opts.now || Date.now();
  const compact = !!opts.compact;
  // Mirror the ai_usage_tools cookie rule: never render an empty dashboard.
  // Filter AFTER defaulting, then fall back again — an all-invalid list (e.g.
  // ['garbage']) is non-empty but filters to nothing, and silently showing zero
  // cards reads as "no usage" rather than "bad input".
  const requested = opts.tools && opts.tools.length ? opts.tools : ALL_PROVIDERS;
  const filtered = requested.filter((k) => ALL_PROVIDERS.includes(k));
  const tools = filtered.length ? filtered : ALL_PROVIDERS;
  const ctx = { width, now, compact };
  const providers = payload?.providers || {};
  const lines = [];

  // Header
  const title = bold('AI USAGE');
  const updated = payload?.generatedAt
    ? `updated ${new Date(payload.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : 'loading…';
  const anyLive = tools.some((k) => providers[k]?.rateLimits);
  const dot = opts.error ? paint(C.danger, '●') : anyLive ? paint(C.ok, '●') : dim('●');
  const headLeft = `${dot} ${title}`;
  const headRight = dim(opts.error ? 'connection error' : updated);
  const headGap = width - visibleWidth(headLeft) - visibleWidth(headRight);
  lines.push(headGap >= 1 ? `${headLeft}${' '.repeat(headGap)}${headRight}` : `${headLeft} ${headRight}`);
  lines.push(dim('═'.repeat(width)));
  lines.push('');

  for (const key of tools) {
    lines.push(...providerCard(key, providers[key], ctx));
  }

  // Footer: countdown + keys, mirroring the web countdown line. Wraps rather
  // than truncating so a narrow pane still shows the full key hints.
  const footParts = [];
  if (opts.nextRefreshAt) {
    const secs = Math.max(0, Math.round((opts.nextRefreshAt - now) / 1000));
    footParts.push(secs <= 0 ? 'refreshing…' : `next refresh in ${secs}s`);
  }
  if (opts.watch) footParts.push('q quit', 'r refresh', 'c compact');
  if (opts.source) footParts.push(opts.source);
  const foot = footParts.filter(Boolean).join(' · ');
  if (foot) {
    lines.push(dim('─'.repeat(width)));
    lines.push(...wrapPlain(foot, width, '  '));
  }

  return lines;
}

export { italic };
