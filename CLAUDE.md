# CLAUDE.md

Guidance for Claude Code (and other AI agents) working in this repository.

## What this is

A small, local, cross-platform (macOS + Windows) web dashboard that shows
**Claude Code** and **Codex CLI** subscription usage side-by-side — 5-hour and
weekly rate-limit utilization, reset countdowns, and 30-day token trends — so both
tools' limits can be watched in one window instead of two.

- **Runtime:** Node.js ≥ 20. **Zero runtime dependencies** — built-ins only
  (`node:http`, `node:fs`, `fetch`, `execFile`). Keep it that way unless there's a
  strong reason; adding a dependency is a deliberate decision, not a convenience.
- **No build step, no framework.** Plain ES modules on the server, plain
  HTML/CSS/vanilla-JS on the client.

## Run / develop

```bash
npm start          # node server.js  → http://127.0.0.1:4317
npm run dev        # node --watch server.js (restarts on change)
```

There is **no test suite, no linter, and no typecheck** configured. "Verify" here
means: start the server and confirm `GET /api/usage` returns both providers with
`available: true`, and that the dashboard renders (see "Verifying changes" below).
Do not claim tests pass — there are none.

## Architecture

```
server.js            Local HTTP server. Serves ./public and two JSON endpoints:
                       GET /api/usage   → combined Claude + Codex snapshot
                       GET /api/health  → { ok: true }
                     Caches the aggregate ~15s so browser polling doesn't re-scan
                     the filesystem every request. Binds 127.0.0.1 by default.
src/claude.js        All Claude data logic (live endpoint + local token totals).
src/codex.js         All Codex data logic (local rollout files only).
src/util.js          Shared fs helpers (recursive listing, JSONL parsing).
public/index.html    Markup: header, summary strip, provider cards, legend.
public/styles.css    All styling. Dark/light via prefers-color-scheme + tokens.
public/app.js        Fetches /api/usage every 30s, renders, countdown, skeletons.
```

**Design rule:** all fragile / provider-specific logic lives in `src/`. The server
is a thin shell; the frontend only consumes the normalized JSON. Keep it that way —
if an endpoint schema drifts, there should be exactly one file to fix per provider.

## Where the data comes from (READ THIS before touching data logic)

This is the hard-won core of the project. The two CLIs expose usage very
differently, and **both live endpoints are undocumented and version-fragile.**

### Codex (`src/codex.js`) — local files only, no network

- Codex persists a per-turn rate-limit snapshot to
  `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Each turn writes an `event_msg`
  with `payload.type === "token_count"` whose payload carries `rate_limits`:
  - `primary` → 5-hour window (`window_minutes` 300)
  - `secondary` → weekly window (`window_minutes` 10080)
  - each with `used_percent` and `resets_at` (**unix epoch seconds**).
- We read the **most recent non-null** snapshot across recent files. Recent Codex
  builds sometimes write `rate_limits: null`, so walk newest→oldest until one hits.
- **This means Codex's % is only as fresh as your last Codex run.** It is NOT live.
  The UI must never label it "live" — it says "snapshot · <age>". Preserve that.
- **Never call the live `chatgpt.com/backend-api/wham/usage` endpoint from here, and
  never refresh the Codex OAuth token.** Refreshing independently races Codex's own
  refresh-token rotation and can revoke the user's login. Read-only, always.

### Claude (`src/claude.js`) — live endpoint + local token totals

- Live rate-limit %: `GET https://api.anthropic.com/api/oauth/usage` with headers
  `Authorization: Bearer <token>`, `anthropic-beta: oauth-2025-04-20`, and a
  **real `User-Agent: claude-code/<version>`** (a missing/fake UA gets aggressively
  429'd — do not remove it). Returns `five_hour.utilization` and
  `seven_day.utilization` (already **percent**, 0–100) plus `resets_at`.
  - Throttled to **≥180s** between real calls (cached in-module) to avoid 429s.
- The OAuth token is read from where Claude Code already stores it (pass-through
  auth, no separate login): macOS Keychain service `Claude Code-credentials`, or
  `~/.claude/.credentials.json` on Linux/Windows. Shape:
  `{ claudeAiOauth: { accessToken, subscriptionType, rateLimitTier, ... } }`.
  **Read-only. Never write, log, or transmit the token anywhere but the Anthropic
  endpoint above.**
- Token totals (the stable fallback layer): summed from
  `~/.claude/projects/**/*.jsonl` assistant-message `message.usage` blocks. There
  is **no cost field** — cost is estimated from a pricing table in the module and
  must be presented as a hypothetical, never a bill.

### The two-layer contract (do not break)

Each provider returns a **live/enriched layer** (rate-limit %) and a **stable local
layer** (token totals). The live layer is **allowed to be missing** — on 401/429/
schema-drift/no-credential, degrade gracefully to token totals and set the card's
`source` accordingly ("live" → "tokens only"). Never let a failed endpoint blank the
dashboard or throw out of `getClaude()` / `getCodex()`; they already catch and
return `available: false` shapes. New code must uphold this.

## Product principles (why the UI is the way it is)

- **Every number states what it represents and where it came from.** The user
  explicitly asked for this. Don't add a stat without a caption/label and a clear
  provenance (live vs local snapshot vs computed estimate).
- **Honesty over polish.** Codex "live" was a real bug we fixed — it was a disk
  snapshot mislabeled as live. Don't reintroduce that class of mistake.
- **Claude's token "total" is cache-dominated** (cache reads dwarf real I/O), so the
  UI splits "Real work" (input+output) from "Cache reads". Keep them distinct; a
  blended total misleads.
- **Responsive + theme-aware.** Full dashboard on wide screens, single-column on
  mobile; dark/light follow the OS. Verify both when touching layout.

## Verifying changes

There is no CI to lean on. Before saying a change works:

1. `npm start`, then `curl -s localhost:4317/api/usage | ...` — confirm both
   providers return `available: true` and sane numbers.
2. Load the page (or a preview) and confirm it renders in **both** desktop and
   mobile widths, and doesn't overflow horizontally.
3. If you touched data logic, independently recompute the affected number from the
   raw files (a throwaway Python/node script) and confirm it matches what the
   dashboard shows. We caught a labeling issue this way; do the same.
4. Check the browser console for errors.

## Conventions

- **Conventional commits** (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`). Pick
  the type by primary purpose, not diff size.
- Match the existing style: small focused modules, explanatory comments on anything
  that depends on an undocumented schema (there's a lot of that here — keep the
  comments, they're load-bearing knowledge).
- Keep `HOST` defaulting to `127.0.0.1` (localhost-only). Don't bind `0.0.0.0` by
  default — this reads local credentials and should not be network-exposed casually.

## Non-negotiables (security / correctness)

- Read-only access to `~/.claude` and `~/.codex`. Never write to them, never refresh
  either CLI's tokens, never log or exfiltrate credentials.
- The only outbound network call is Claude's usage endpoint. Adding any other
  outbound call is a deliberate, reviewed decision.
- Path-traversal guard in the static file server (`server.js`) must stay.
