# AI Usage Dashboard

A small, local, cross-platform (macOS, Windows, and Linux) web dashboard that
shows your **Claude Code**, **Codex CLI**, and **Cursor** subscription usage
side-by-side — rate-limit / plan utilization, reset countdowns, and token
trends — so you don't need separate windows for each tool.

Use the **Settings** gear (top-right) to choose which tools appear; the choice is
saved in a cookie on this machine.

## What it shows

- **Summary strip** (top): headline utilization for each visible tool, with reset
  countdowns. A legend spells out which numbers are live and which are snapshots.
  - Claude / Codex: **5-hour** and **weekly** windows
  - Cursor: **plan (billing cycle)** and **auto models** (not 5-hour / weekly)
- **Per-provider cards**: rate-limit / plan bars (green → amber ≥70% → red ≥90%)
  with a per-provider provenance line, token usage, and (where available) model
  breakdowns and sparklines. Cursor’s card also shows **API / named models**.
- **Every value labels its source.** Claude and Cursor % are fetched live; Codex %
  is read from Codex's last on-disk snapshot and is tagged with its age (it only
  changes when you actually run Codex).
- **Cursor meters a billing-cycle plan**, not a 5-hour / weekly window. The
  headline plan % is Cursor’s **Total Usage** meter (`totalPercentUsed` from
  `usage-summary`) — the same cutoff signal as cursor.com/dashboard Spending.
- **Header** shows the last update time plus a live "next refresh in Ns" countdown.
  On first load the cards show shimmer **skeletons** rather than empty boxes.

The layout is a full dashboard on wide screens and stacks to a single column on
narrow / mobile widths. Dark and light themes follow your OS setting.

## How it gets the data (pass-through auth, no separate login)

It reuses the credentials and logs the tools already keep on your machine — you
never log in again.

| Provider | Live rate-limit / plan % | Token totals |
|---|---|---|
| **Codex** | Read from the per-turn snapshot Codex persists to `~/.codex/sessions/**/rollout-*.jsonl` (no network, no auth). | Summed from the same rollout files (last 30 days). |
| **Claude** | Fetched from the same endpoint Claude Code's `/usage` meter uses (`api.anthropic.com/api/oauth/usage`), authenticated with the OAuth token Claude Code already stored (macOS Keychain / `~/.claude/.credentials.json`). | Summed from `~/.claude/projects/**/*.jsonl` (last 30 days). |
| **Cursor** | Fetched from Cursor's dashboard API (`cursor.com/api/usage-summary`), authenticated with the session JWT Cursor already stored in `state.vscdb` (or the `cursor-access-token` keychain entry). Headline % = `totalPercentUsed`. | Aggregated via `cursor.com/api/dashboard/get-aggregated-usage-events` for the current billing period (or last 30 days if cycle start is unknown). |

> **Live vs snapshot — an important distinction.** Claude's and Cursor's % are
> fetched *live* (throttled to once every few minutes). Codex's % is read from the
> snapshot Codex writes to disk on each run — so it only updates when you actually
> use Codex, and the dashboard shows its age ("snapshot · 2m ago") rather than
> claiming it's live.

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
- **Cursor "Est. cost":** sum of `totalCents` from Cursor’s aggregated usage
  events for the period — also not a separate bill.

## Run it

Requires **Node.js 20+**. No dependencies, no build step.

```bash
npm start          # → http://127.0.0.1:4317
npm run dev        # same, restarts on file changes
```

Leave it pinned in a narrow browser window on the side. It refreshes every 30s.

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

## Agent docs

See [`AGENTS.md`](./AGENTS.md) (and [`CLAUDE.md`](./CLAUDE.md)) for architecture,
data-source details, conventions, and non-negotiables for AI agents working in
this repo.
