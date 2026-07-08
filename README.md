# AI Usage Dashboard

A small, local, cross-platform (macOS + Windows) web dashboard that shows your
**Claude Code** and **Codex CLI** subscription usage side-by-side — 5-hour and
weekly rate-limit utilization, reset countdowns, and 30-day token trends — so you
don't need two separate windows open.

## What it shows

- **Summary strip** (top): the four headline numbers — Claude 5-hour / weekly and
  Codex 5-hour / weekly utilization, with reset countdowns.
- **Per-provider cards**: rate-limit bars (green → amber ≥70% → red ≥90%), 30-day
  token totals, session counts, a daily-tokens sparkline, and (for Claude) a
  per-model breakdown.

The layout is a full dashboard on wide screens and stacks to a single column on
narrow / mobile widths. Dark and light themes follow your OS setting.

## How it gets the data (pass-through auth, no separate login)

It reuses the credentials and logs the CLIs already keep on your machine — you
never log in again.

| Provider | Live rate-limit % | Token totals |
|---|---|---|
| **Codex** | Read from the per-turn snapshot Codex persists to `~/.codex/sessions/**/rollout-*.jsonl` (no network, no auth). | Summed from the same rollout files. |
| **Claude** | Fetched from the same endpoint Claude Code's `/usage` meter uses (`api.anthropic.com/api/oauth/usage`), authenticated with the OAuth token Claude Code already stored (macOS Keychain / `~/.claude/.credentials.json`). | Summed from `~/.claude/projects/**/*.jsonl`. |

Both live endpoints are **undocumented** and may change or become temporarily
unavailable on a CLI update. When that happens the dashboard **degrades
gracefully** to the always-available local token totals (the card shows a
"tokens only" badge instead of "live").

> The Claude "API-equiv value" figure is the equivalent pay-as-you-go API list
> price of your logged tokens — a "value delivered" number, **not** a bill. Your
> subscription cost is flat.

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
