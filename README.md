# AI Usage Dashboard

A small, local, cross-platform (macOS + Windows) web dashboard that shows your
**Claude Code** and **Codex CLI** subscription usage side-by-side — 5-hour and
weekly rate-limit utilization, reset countdowns, and 30-day token trends — so you
don't need two separate windows open.

## What it shows

- **Summary strip** (top): the four headline numbers — Claude 5-hour / weekly and
  Codex 5-hour / weekly utilization, with reset countdowns. A legend spells out
  which numbers are live and which are snapshots.
- **Per-provider cards**: rate-limit bars (green → amber ≥70% → red ≥90%) with a
  per-provider provenance line, 30-day token usage, session counts, a daily-tokens
  sparkline, and (for Claude) a per-model breakdown.
- **Every value labels its source.** Claude's % is fetched live; Codex's % is read
  from Codex's last on-disk snapshot and is tagged with its age (it only changes
  when you actually run Codex).
- **Header** shows the last update time plus a live "next refresh in Ns" countdown.
  On first load the cards show shimmer **skeletons** rather than empty boxes.

The layout is a full dashboard on wide screens and stacks to a single column on
narrow / mobile widths. Dark and light themes follow your OS setting.

## How it gets the data (pass-through auth, no separate login)

It reuses the credentials and logs the CLIs already keep on your machine — you
never log in again.

| Provider | Live rate-limit % | Token totals |
|---|---|---|
| **Codex** | Read from the per-turn snapshot Codex persists to `~/.codex/sessions/**/rollout-*.jsonl` (no network, no auth). | Summed from the same rollout files. |
| **Claude** | Fetched from the same endpoint Claude Code's `/usage` meter uses (`api.anthropic.com/api/oauth/usage`), authenticated with the OAuth token Claude Code already stored (macOS Keychain / `~/.claude/.credentials.json`). | Summed from `~/.claude/projects/**/*.jsonl`. |

> **Live vs snapshot — an important distinction.** Claude's rate-limit % is
> fetched *live* from Anthropic (throttled to once every few minutes). Codex's % is
> read from the snapshot Codex writes to disk on each run — so it only updates when
> you actually use Codex, and the dashboard shows its age ("snapshot · 2m ago")
> rather than claiming it's live.

The Claude endpoint is **undocumented** and may change or become temporarily
unavailable on a CLI update. When that happens the dashboard **degrades
gracefully** to the always-available local token totals (the card shows a
"tokens only" badge instead of "live").

### Reading the token numbers

- **Claude "Real work" vs "Cache reads":** Claude's raw token total is dominated by
  cache reads (the same context re-read on every turn). The dashboard splits these
  so "Real work" (actual input + output) isn't buried under the much larger cache
  figure.
- **Claude "If billed at API rates" ($):** the equivalent pay-as-you-go API
  list-price of your logged tokens — a "value delivered" figure, **not a bill.**
  Your subscription is flat-rate. There is no cost field in the logs; this is
  estimated from a pricing table and is approximate.

## Run it

Requires **Node.js 20+** (which you already have if you run Claude Code). No
dependencies, no build step.

```bash
npm start
# → http://127.0.0.1:4317
```

Leave it pinned in a narrow browser window on the side. It refreshes every 30s.

### Options (env vars)

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `4317` | Server port |
| `HOST` | `127.0.0.1` | Bind address (localhost-only by default) |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Override Claude config location |
| `CODEX_HOME` | `~/.codex` | Override Codex config location |

## Privacy

Everything runs locally. The only outbound network call is Claude's usage
endpoint (`api.anthropic.com`), using your existing Claude Code token — the same
call Claude Code itself makes. No data leaves your machine otherwise, and no
credentials are logged or written anywhere.

## Notes / caveats

- The undocumented endpoints and local-file schemas can drift between CLI
  releases; the local-token layer is the stable fallback.
- The dashboard **never refreshes** the Codex OAuth token itself (that would race
  Codex's own token rotation and could revoke your login). It only reads.
- Codex per-model token breakdown isn't shown because the rollout logs don't split
  tokens by model the way Claude's do.
