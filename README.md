# AI Usage Dashboard

A small, local, cross-platform (macOS, Windows, and Linux) web dashboard that
shows your **Claude Code**, **Codex CLI**, and **Cursor** subscription usage
side-by-side — rate-limit / plan utilization, reset countdowns, and token
trends — so you don't need separate windows for each tool.

Use the **Settings** gear (top-right) to choose which tools appear, color mode,
and **Compact view** (bars-only overview while working). Choices are saved in
cookies on this machine (`ai_usage_tools`, `ai_usage_theme`, `ai_usage_layout`).

> Unofficial project — not affiliated with Anthropic, OpenAI, or Cursor. See the
> [Disclaimer](#disclaimer) below.

## What it shows

- **Per-provider cards**: each visible tool gets one card with rate-limit /
  plan / usage-credits progress bars **and** (in default layout) token detail
  (sparklines / by-model where available).
  - Claude / Codex: **5-hour** and **weekly** windows
  - Claude (when present): **scoped** weekly/model windows from the live
    `limits[]` array (labels from the API, e.g. Weekly (Fable) — not hardcoded)
  - Claude (when enabled): **usage credits** — monthly extra-usage spend cap
    (`$used of $limit`), separate from rate-limit windows
  - Cursor: **plan (billing cycle)** and **auto models** (not 5-hour / weekly);
    **API / named models** and **on-demand credits** when present; **Credits**
    (promo/referral grant balance) when remaining > 0
- **Compact view** (Settings checkbox): dense bars-only cards — no token
  stats, sparklines, by-model, or accordion. Turn off to restore full detail.
- **Every value labels its source.** Claude and Cursor % are fetched live; Codex %
  is read from Codex's last on-disk snapshot and is tagged with its age (it only
  changes when you actually run Codex).
- **Cursor meters a billing-cycle plan**, not a 5-hour / weekly window. The
  headline plan % is Cursor’s **Total Usage** meter (`totalPercentUsed` from
  `usage-summary`) — the same cutoff signal as cursor.com/dashboard Spending.
- **Header** shows the last update time plus a live "next refresh in Ns" countdown.
  On first load the cards show shimmer **skeletons** rather than empty boxes.

Default layout across common widths (when Compact is off):

| Width | Layout |
|---|---|
| ≤480 (phone) | 1-col; limits visible; token detail in accordion; compact chrome |
| 481–1024 (tablet) | Same stacked accordion (until full dual-panel detail fits) |
| ≥1025 (laptop+) | Side-by-side cards with full detail (2 cols, then 3 once tracks are ~420px+) |
| Ultrawide | Content grows up to **2100px** so three cards breathe; centered beyond that (not edge-glued) |

Dark and light themes follow your OS setting by default; override to Light or Dark
in Settings (saved in the `ai_usage_theme` cookie). Compact view is saved in
`ai_usage_layout` (`default` | `compact`).

## How it gets the data (pass-through auth, no separate login)

It reuses the credentials and logs the tools already keep on your machine — you
never log in again.

| Provider | Live rate-limit / plan % | Token totals |
|---|---|---|
| **Codex** | Read from the per-turn snapshot Codex persists to `~/.codex/sessions/**/rollout-*.jsonl` (no network, no auth). | Summed from the same rollout files (last 30 days). |
| **Claude** | Fetched from the same endpoint Claude Code's `/usage` meter uses (`api.anthropic.com/api/oauth/usage`), authenticated with the OAuth token Claude Code already stored (macOS Keychain / `~/.claude/.credentials.json`). | Summed from `~/.claude/projects/**/*.jsonl` (last 30 days). |
| **Cursor** | Fetched from Cursor's dashboard API (`cursor.com/api/usage-summary`), authenticated with the session JWT Cursor already stored in `state.vscdb` (or the `cursor-access-token` keychain entry). Headline % = `totalPercentUsed`. Promo/referral **Credits** from `get-credit-grants-balance` when remaining > 0. | Aggregated via `cursor.com/api/dashboard/get-aggregated-usage-events` for the current billing period (or last 30 days if cycle start is unknown). |

> **Live vs snapshot — an important distinction.** Claude's and Cursor's % are
> fetched *live* (throttled to once every few minutes). Codex's % is read from the
> snapshot Codex writes to disk on each run that persists a rollout — so it only
> updates when a non-ephemeral session writes `rate_limits`. The dashboard shows
> its age (`snapshot · 2m ago`, or `· may lag` when older than ~1h) rather than
> claiming it's live. `codex exec --ephemeral` still burns plan quota but leaves
> no local snapshot, so ChatGPT’s usage page can be ahead of this card.

The live endpoints are **undocumented** and may change or become temporarily
unavailable. When that happens the dashboard **degrades gracefully** (the card
shows a "tokens only" badge instead of "live").

### Reading the token numbers

- **Claude / Cursor "Real work" vs "Cache reads":** raw totals are often dominated
  by cache reads. The dashboard splits these so real prompt/response volume isn't
  buried under the much larger cache figure.
- **Claude "If billed at API rates" ($):** the equivalent pay-as-you-go API
  list-price of your logged tokens — a "value delivered" figure, **not a bill.**
  Your subscription is flat-rate.
- **Claude "Usage credits":** when your Max plan has extra usage enabled, the
  live endpoint reports a monthly spend cap (`spend` / `extra_usage`). The
  meter shows **%** plus **`$used of $limit · $remaining left`**. That is real
  overage spend against your credit limit — distinct from the hypothetical
  API-rate estimate above, and distinct from the 5-hour / weekly rate limits.
  If extra usage is off, the bar is hidden; a credit **balance** is shown only
  when Anthropic returns one.
- **Cursor "Est. cost":** sum of `totalCents` from Cursor’s aggregated usage
  events for the period — also not a separate bill.

## Run it

Requires **Node.js 20+**. No dependencies, no build step.

```bash
npm start          # → http://127.0.0.1:4317
npm run dev        # same, restarts on file changes
```

Leave it pinned in a narrow browser window on the side. It refreshes every 30s.

### Install as a standalone window (Chrome)

The dashboard ships a [web app manifest](./public/manifest.webmanifest) and
app icon so Chrome can open it **full-screen with no browser toolbar** — just
the content — with a Dock / Launchpad (or Start menu) icon.

1. Start the server (`npm start`) and open [http://127.0.0.1:4317](http://127.0.0.1:4317).
2. In Chrome: **⋮ → Install page as app…** (or **Cast, save, and share →
   Install page as app…** / **Create shortcut… → Open as window**).
3. Confirm the install. The installed app is named **AI Usage** (full name
   **AI Usage Dashboard**), uses the stacked-bars icon, and opens in a
   chrome-less standalone window.

There is no service worker and no offline mode — the local server must still
be running. This is for a dedicated window, not a packaged desktop app.

To open the dashboard from another device on your LAN (phone, another laptop):

```bash
HOST=0.0.0.0 npm start
```

The startup log prints `Network: http://<your-lan-ip>:4317` URLs. Use one of those from the other device — not `127.0.0.1` (that always means “this machine”). Default remains localhost-only because the server reads local credentials.

### macOS: Übersicht + SwiftBar

Optional thin clients under [`macos/`](./macos/) poll the same `/api/usage`
endpoint (server must be running). See [`macos/README.md`](./macos/README.md)
for install/symlink steps.

- **Übersicht** — desktop widget (HTML/CSS/JS)
- **SwiftBar** — menu-bar item **`AI`** (click for Claude / Codex / Cursor detail)

They do not re-read credentials or provider files; Codex still shows as a
snapshot with age, never “live”.

### Options (env vars)

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `4317` | Server port |
| `HOST` | `127.0.0.1` | Bind address (localhost-only by default) |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Override Claude config location |
| `CODEX_HOME` | `~/.codex` | Override Codex config location |
| `CURSOR_STATE_DB` | (OS default `state.vscdb`) | Override Cursor state DB path |
| `CURSOR_ACCESS_TOKEN` | — | Optional JWT / `sub::jwt` override for Cursor |

## Privacy

Everything runs locally. Outbound network calls are only:

- Claude's usage endpoint (`api.anthropic.com`), using your existing Claude Code token
- Cursor's usage/dashboard endpoints (`cursor.com`), using your existing Cursor session

No data leaves your machine otherwise, and no credentials are logged or written
anywhere. Codex stays fully offline.

## Notes / caveats

- The undocumented endpoints and local-file schemas can drift between releases;
  the local / token layer is the stable fallback.
- The dashboard **never refreshes** Claude, Codex, or Cursor tokens itself (that
  can race each tool's own token rotation). It only reads.
- Codex per-model token breakdown isn't shown because the rollout logs don't split
  tokens by model the way Claude's / Cursor's do.
- Cursor has no per-day sparkline from the aggregated endpoint (totals by model only).
- Cursor’s `plan.used` / `plan.limit` fields look like a separate included-pool
  unit (often USD cents) and can disagree with `totalPercentUsed`; this dashboard
  intentionally follows **Total Usage** so the % matches when your plan cuts off.

## Disclaimer

This is an **unofficial** tool, not affiliated with or endorsed by Anthropic,
OpenAI, or Cursor (Anysphere). The Claude and Cursor providers rely on
**undocumented endpoints** — the same ones each vendor's own dashboard uses —
which may change or stop working at any time without notice. The dashboard only
ever *reads* your own usage data with the credentials already on your machine,
but automated access to these services may not be covered by each vendor's
terms of service. Use it with your own account, at your own discretion.

## Agent docs

See [`AGENTS.md`](./AGENTS.md) (and [`CLAUDE.md`](./CLAUDE.md)) for architecture,
data-source details, conventions, and non-negotiables for AI agents working in
this repo.
