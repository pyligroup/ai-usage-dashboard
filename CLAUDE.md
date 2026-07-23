# CLAUDE.md

Guidance for Claude Code (and other AI agents) working in this repository.

> Prefer **`AGENTS.md`** as the canonical agent guide (same content, kept in sync).
> Update both when architecture or data sources change.

## What this is

A small, local, cross-platform (macOS, Windows, and Linux) web dashboard that
shows **Claude Code**, **Codex CLI**, and **Cursor** subscription usage
side-by-side — rate-limit / plan utilization, reset countdowns, and token
trends — so multiple tools' limits can be watched in one window.

- **Runtime:** Node.js ≥ 20. **Zero runtime dependencies** — built-ins only
  (`node:http`, `node:fs`, `fetch`, `execFile`). Keep it that way unless there's a
  strong reason; adding a dependency is a deliberate decision, not a convenience.
- **No build step, no framework.** Plain ES modules on the server, plain
  HTML/CSS/vanilla-JS on the client.
- **Tool visibility**, **color mode**, and **compact view** are configurable via a
  top-right Settings modal; choices are persisted in browser cookies
  (`ai_usage_tools`, `ai_usage_theme`, `ai_usage_layout`). Default layout is the
  detailed responsive design; compact is bars-only. Tool filtering is
  **client-side** — `/api/usage` still returns all providers.

## Run / develop

```bash
npm start          # node server.js  → http://127.0.0.1:4317
npm run dev        # node --watch server.js (restarts on change)
```

There is **no test suite, no linter, and no typecheck** configured. "Verify" here
means: start the server and confirm `GET /api/usage` returns providers with
`available: true` (when those tools are signed in locally), and that the dashboard
renders (see "Verifying changes" below). Do not claim tests pass — there are none.

## Architecture

```
server.js            Local HTTP server. Serves ./public and two JSON endpoints:
                       GET /api/usage   → combined Claude + Codex + Cursor snapshot
                       GET /api/health  → { ok: true }
                     Caches the aggregate ~15s so browser polling doesn't re-scan
                     the filesystem / re-hit live endpoints every request.
                     Binds 127.0.0.1 by default.
src/claude.js        Claude data logic (live Anthropic usage + local JSONL tokens).
src/codex.js         Codex data logic (local rollout files only — no network).
src/cursor.js        Cursor data logic (live cursor.com dashboard API + local
                     state.vscdb membership metadata).
src/util.js          Shared fs helpers (recursive listing, JSONL parsing).
public/index.html    Markup: header, settings modal, provider cards.
public/styles.css    All styling. Dark/light via prefers-color-scheme +
                     optional cookie override (`data-theme`). Default layout:
                     stack+accordion ≤1024; multi-col ≥1025; content max-width
                     2100px. Compact (`data-layout=compact`): bars-only cards.
public/app.js        Fetches /api/usage every 30s, renders, countdown, skeletons,
                     cookie-backed tool visibility + theme + layout (compact) +
                     settings modal. STACK_MQ mirrors the 1024px stack breakpoint.
public/manifest.webmanifest + icon.svg + icon-maskable.svg
                     Web app manifest for install-as-app / standalone
                     chrome-less window (name, icons, theme_color). Two icons:
                     rounded `icon.svg` (purpose "any") + full-bleed
                     `icon-maskable.svg` (purpose "maskable", no rounded
                     corners so Android's adaptive mask doesn't crop artwork).
public/sw.js         Service worker. Registered from app.js. Exists so Android
                     Chrome installs a real standalone WebAPK (not a Chrome
                     shortcut) — requires a secure context (HTTPS/localhost;
                     a plain http:// LAN IP won't register it). Network-first
                     cache of the static shell for instant/offline chrome;
                     NEVER caches /api/* (live data must stay live).
macos/               Optional macOS clients (Übersicht desktop widget + SwiftBar
                     menu-bar plugin). Thin `/api/usage` consumers only — no
                     credential or provider logic. See macos/README.md.
```

**Design rule:** all fragile / provider-specific logic lives in `src/`. The server
is a thin shell; the frontend and macOS clients only consume the normalized JSON.
Keep it that way — if an endpoint schema drifts, there should be exactly one file
to fix per provider. Do not duplicate Claude/Codex/Cursor fetches in `macos/`.

## Where the data comes from (READ THIS before touching data logic)

Providers expose usage very differently. **Live endpoints are undocumented and
version-fragile.** Codex is local-only by design.

### Codex (`src/codex.js`) — local files only, no network

- Codex persists a per-turn rate-limit snapshot to
  `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Each turn writes an `event_msg`
  with `payload.type === "token_count"` whose payload carries `rate_limits` with
  `primary` / `secondary` windows (`used_percent`, `resets_at` as **unix epoch
  seconds**, `window_minutes`). Historically `primary` was 5-hour (300) and
  `secondary` weekly (10080), but recent builds sometimes put weekly in
  `primary` with `secondary: null` — **classify by `window_minutes`**, not slot
  name.
- As of ~2026-07-12 OpenAI temporarily removed the 5-hour usage limit for some
  plans (Plus/Business/Pro); newest Codex snapshots may be **weekly-only**
  (`primary.window_minutes: 10080`, `secondary: null`). Walk newest→oldest until
  the **first non-null** `rate_limits` object, then take **only the windows
  present in that object**. Do **not** backfill a missing fiveHour/weekly from
  an older snapshot (that produced a misleading stale 5h at 100%). Still skip
  `rate_limits: null` and continue to the next older event/file. When 5h
  returns in a recent payload (`window_minutes` 300), it shows again.
  `capturedAt` is that newest usable snapshot.
- **This means Codex's % is only as fresh as your last Codex run that persisted a
  rollout.** It is NOT live. The UI must never label it "live" — it says
  `snapshot · <age>` (and `· may lag` when the snapshot is older than ~1h).
  Preserve that. Importantly, `codex exec --ephemeral` (and any other mode that
  skips writing session files) still consumes plan quota on OpenAI’s side but
  leaves **no** local `rate_limits` for this dashboard to read — so ChatGPT’s
  usage page can be ahead of the card. Do not “fix” that by calling a live
  Codex usage endpoint or refreshing OAuth tokens.
- Token totals (last 30 days): sum **in-window deltas** of per-session
  `total_token_usage`, not the final cumulative total. Resumed/long-running
  sessions that started before the cutoff would otherwise over-count.
- **Never call the live `chatgpt.com/backend-api/wham/usage` endpoint from here, and
  never refresh the Codex OAuth token.** Refreshing independently races Codex's own
  refresh-token rotation and can revoke the user's login. Read-only, always.

### Claude (`src/claude.js`) — live endpoint + local token totals

- Live rate-limit %: `GET https://api.anthropic.com/api/oauth/usage` with headers
  `Authorization: Bearer <token>`, `anthropic-beta: oauth-2025-04-20`, and a
  **real `User-Agent: claude-code/<version>`** (a missing/fake UA gets aggressively
  429'd — do not remove it). Returns `five_hour.utilization` and
  `seven_day.utilization` (already **percent**, 0–100) plus `resets_at`, and
  optionally `seven_day_opus` (shown as "Weekly (Opus)" when present).
  Also returns `spend` / `extra_usage` when the account has a monthly **usage
  credit** (extra-usage) spend cap — normalized as `rateLimits.extraUsage`:
  `enabled`, `usedPercent` (only meaningful when enabled), `used` / `limit` /
  `remaining` in major currency units, optional `balance` (from `spend.balance`
  when present; same money shape), `currency`. These are **not** the 5-hour /
  weekly windows; Anthropic's disclaimer: they cover you after plan rate
  limits. UI: show the % bar **only when `enabled`**; caption should include
  `$used of $limit` and `$remaining left`. When disabled, omit the bar; if
  `balance` is present, show it as a note (not a bogus %).
  Also returns `limits[]` — session / weekly_all entries that mirror
  `five_hour` / `seven_day`, plus optional **scoped** windows (e.g.
  `kind: weekly_scoped` with `scope.model.display_name` or `scope.surface`).
  Normalized as `rateLimits.scoped[]`: `{ label, usedPercent, resetsAt, kind,
  group, severity? }`. Labels come from the API scope (e.g. "Weekly (Fable)") —
  **never hardcode** product/model names. Skip plain `session` / `weekly_all`
  mirrors and skip scoped entries that would duplicate `opusWeekly`.
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

### Cursor (`src/cursor.js`) — live dashboard API + local session JWT

Cursor does **not** have Claude/Codex-style 5-hour / weekly windows. It meters a
**billing-cycle plan allowance** (plus auto / API splits). The UI must label these
as plan / billing-cycle — **never** as "5-hour" or "weekly".

- Live plan %: `GET https://cursor.com/api/usage-summary` with cookie
  `WorkosCursorSessionToken=<cookieId>::<jwt>` where `<cookieId>` is the trailing
  `user_…` segment of the JWT `sub` (full `sub` also works). Returns
  `individualUsage.plan.{used,limit,remaining,totalPercentUsed,autoPercentUsed,apiPercentUsed,…}`,
  optional `individualUsage.onDemand`, and billing cycle timestamps.
  - Headline plan % MUST be **`totalPercentUsed`** — that is what
    cursor.com/dashboard Spending shows as "Total Usage" and what gates the
    included allowance. `used`/`limit` appear to be USD cents of the included
    pool (e.g. 225/2000 = $2.25 of $20) and can disagree sharply with the %
    meter because auto vs API models are weighted differently. Do **not**
    compute headline % from `used / limit`.
  - Normalized `rateLimits` shape: `plan`, `auto`, `api`, plus optional
    `onDemand` / `credits` / billing-cycle timestamps. The Cursor card shows
    plan + auto, plus API / named models and on-demand when present, and
    **Credits** when a promo/referral grant balance remains (`remaining > 0`).
  - Promo/referral credit balance: `POST https://cursor.com/api/dashboard/get-credit-grants-balance`
    (empty JSON body, same cookie auth + `Origin`). Returns
    `hasCreditGrants`, `creditBalanceCents` / `totalCents` / `usedCents`
    (often strings). Normalize as `rateLimits.credits`: `{ remaining, total,
    used, usedPercent }` in **USD cents**. UI shows the bar **only when
    `remaining > 0`** (caption like Spending: `$8 / $25 remaining`). These are
    **not** the billing-cycle plan bar and **not** on-demand.
  - Throttled to **≥180s** between real calls (cached in-module).
- Token aggregates: `POST https://cursor.com/api/dashboard/get-aggregated-usage-events`
  with `Origin: https://cursor.com` (CSRF required on POSTs) and body
  `{ teamId: 0, startDate, endDate, userId? }`. Window is the billing-cycle
  start when known, otherwise the last 30 days. Do not clip a longer cycle to
  30 days — that would drop early-cycle usage. Optional `userId` comes from
  `GET https://cursor.com/api/auth/me` when available. Returns per-model token
  totals + `totalCostCents`. Multiple aggregation rows for the same
  `modelIntent` are summed. No per-day series on this endpoint — don't invent
  a sparkline; the UI shows a note instead.
- Session JWT (read-only, never refresh/write), in order:
  1. `CURSOR_ACCESS_TOKEN` env (raw JWT or `sub::jwt`)
  2. Cursor IDE `state.vscdb` → `ItemTable` key `cursorAuth/accessToken`
     - macOS: `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
     - Linux: `~/.config/Cursor/User/globalStorage/state.vscdb`
     - Windows: `%APPDATA%/Cursor/User/globalStorage/state.vscdb`
  3. macOS Keychain service `cursor-access-token` (often staler than the IDE DB)
- Membership metadata (`stripeMembershipType`, email, …) is also read from the
  same state DB. SQLite is queried via system `sqlite3` / `python3` (no npm deps).
- **Never refresh Cursor tokens.** Send the JWT only to `cursor.com` (and never
  log it).

### The two-layer contract (do not break)

Each provider returns a **live/enriched layer** (rate-limit / plan %) and a
**stable fallback layer** (token totals and/or local membership). The live layer
is **allowed to be missing** — on 401/429/schema-drift/no-credential, degrade
gracefully and set the card's `source` / chip accordingly ("live" → "tokens only").
Never let a failed endpoint blank the dashboard or throw out of `getClaude()` /
`getCodex()` / `getCursor()`; they catch and return `available: false` shapes.
New code must uphold this.

## Frontend: settings cookies

- Cookie name: `ai_usage_tools` (JSON like `{"claude":true,"codex":true,"cursor":false}`).
- Cookie name: `ai_usage_theme` (`system` | `light` | `dark`). Default `system`
  follows `prefers-color-scheme`; light/dark set `data-theme` on `<html>`.
- Cookie name: `ai_usage_layout` (`default` | `compact`). Default `default` is
  the detailed responsive layout. `compact` sets `data-layout="compact"` on
  `<html>` and shows bars-only provider cards. Legacy values `dashboard` /
  `fit` map to `compact`.
- Settings gear (top-right) opens a modal (tool checkboxes + appearance,
  including **Compact view**); Save writes cookies (`SameSite=Lax`, 1-year
  max-age). At least one tool must stay selected.
- Visibility is applied only when rendering provider cards. Server always
  returns the full `providers` object.

## Frontend: provider-specific UI contract

- **Default layout** (compact off — detailed responsive):

  | Approx width | Behavior |
  |---|---|
  | **Phone ≤480** | 1-col + accordion; tighter page pad (14px); countdown hidden; larger Settings tap target; no horizontal overflow |
  | **Tablet 481–1024** | 1-col + accordion (prefer until full dual-panel detail fits). Limits always visible; token/sparkline/by-model behind collapsed “Token usage & more” |
  | **Laptop ≥1025** | Multi-col `auto-fit` with ~420px track floor (and a max of 3 columns). Full detail; accordion chrome hidden. Typically 2 cols until ~3×420 + gaps fit, then 3 |
  | **Desktop / ultrawide** | Same 3 equal columns expanding toward `--maxw: 2100px`; page pad bumps to 28px from 1600px. Centered past 2100 so bezels stay clear — not edge-glued |

  - **Wide (≥ ~1025px / multi-column):** each card shows the full content —
    header, rate-limit / plan / usage-credits bars, token stats,
    sparkline/by-model, notes. Limits sit beside tokens; trend spans the
    card footer. Narrower multi-col cards stack the trend via container
    query so by-model names stay readable.
  - **Narrow / stacked (≤ ~1024px):** cards stack vertically. Progress bars
    stay always visible. Token usage, sparklines, by-model, cost notes, and
    other detail sit behind a `<details>` accordion ("Token usage & more"),
    collapsed by default. Keep `STACK_MQ` in `public/app.js` in sync with
    the CSS 1024px media query.
- **Compact layout** (Settings → Compact view): dense stacked (or side-by-side
  on wide) provider cards with **header + rate-limit / plan / usage-credits
  bars only**. Hide token stats, cost notes, sparklines, by-model, and
  accordion chrome. Keep provider identity + live/snapshot chips and honest
  bar labels. Not a wallboard of full dual-panel cards.
- Claude / Codex cards: **5-hour** + **weekly**. May also show Claude
  **Weekly (Opus)** when `opusWeekly` is present, plus any **scoped** windows
  from `rateLimits.scoped` (labels from the API, e.g. "Weekly (Fable)").
  Claude **Usage credits** (monthly extra-usage spend cap — never a
  5-hour/weekly window): show the progress bar **only when
  `extraUsage.enabled`**, with caption `$used of $limit · $remaining left`.
  When disabled, omit the bar; if `extraUsage.balance` is present, show that
  balance as a note.
- Cursor cards: **plan (billing cycle)** + **auto models**, plus **API /
  named models** and **On-demand credits** when `onDemand.enabled`. Also show
  **Credits** (promo/referral grant balance) when `credits.remaining > 0`
  (caption `$remaining / $total remaining`). Never reuse 5-hour / weekly
  labels for Cursor.
- Token sections: Claude/Codex = "last 30 days" from local logs; Cursor =
  billing-cycle ("current period") from the dashboard API when
  `billingCycleStart` is known, else "last 30 days". Cursor has no daily sparkline.
- Provenance chips: Claude/Cursor → `live` / `live (cached)` / `tokens only`;
  Codex → `snapshot · <age>` (never "live"); append `· may lag` when the
  snapshot is older than ~1h (ephemeral / non-persisted runs may have moved
  live usage ahead).

## Product principles (why the UI is the way it is)

- **Every number states what it represents and where it came from.** The user
  explicitly asked for this. Don't add a stat without a caption/label and a clear
  provenance (live vs local snapshot vs computed estimate).
- **Honesty over polish.** Codex "live" was a real bug we fixed — it was a disk
  snapshot mislabeled as live. Cursor plan % must not be labeled as a 5-hour
  window, and must use `totalPercentUsed` (not `used/limit`) so it matches
  Spending / cutoff. Don't reintroduce that class of mistake.
- **Token "totals" are often cache-dominated** (Claude + Cursor). Split
  "Real work" (input+output) from "Cache reads". Keep them distinct; a blended
  total misleads.
- **Responsive + theme-aware.** One layout across phone → ultrawide (see
  breakpoint table above); dark/light follow the OS. Verify several widths
  when touching layout — especially ≤480, ~768, stack edge (~1024), laptop
  (~1280), and ultrawide (~1600+).

## Verifying changes

There is no CI to lean on. Before saying a change works:

1. `npm start`, then `curl -s localhost:4317/api/usage | ...` — confirm expected
   providers return `available: true` and sane numbers.
2. Load the page (or a preview) and confirm it renders in **both** desktop and
   mobile widths, and doesn't overflow horizontally. Toggle Settings checkboxes
   and confirm the cookie updates and cards hide/show.
3. If you touched data logic, independently recompute the affected number from the
   raw files / API response (a throwaway Python/node script) and confirm it matches
   what the dashboard shows. We caught a labeling issue this way; do the same.
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

- Read-only access to `~/.claude`, `~/.codex`, and Cursor's `state.vscdb` /
  keychain entries. Never write to them, never refresh any provider's tokens,
  never log or exfiltrate credentials.
- Outbound network calls are limited to:
  - Claude: `api.anthropic.com/api/oauth/usage`
  - Cursor: `cursor.com` usage/dashboard/auth endpoints used today
    (`/api/usage-summary`, `/api/dashboard/get-aggregated-usage-events`,
    `/api/dashboard/get-credit-grants-balance`, `/api/auth/me`) with session
    cookie auth
  Adding any other outbound call is a deliberate, reviewed decision. Codex stays
  offline.
- Path-traversal guard in the static file server (`server.js`) must stay.
