# macOS clients (Übersicht + SwiftBar)

Thin consumers of the local dashboard API — **no credential reads, no provider
logic**. Both poll `GET http://127.0.0.1:4317/api/usage` and reuse the same
display rules as the web UI (Claude/Codex 5-hour + weekly; Cursor plan + auto;
Codex labeled as a snapshot, never “live”).

**Prerequisite:** the dashboard server must be running:

```bash
cd /path/to/ai-usage-dashboard
npm start   # → http://127.0.0.1:4317
```

## Layout

| Path | Role |
|---|---|
| [`shared/summary.mjs`](./shared/summary.mjs) | Pure helpers: compact menu-bar line, provider rows, Codex age |
| [`uebersicht/ai-usage.jsx`](./uebersicht/ai-usage.jsx) | Desktop widget (HTML/CSS/JS via Übersicht) |
| [`swiftbar/ai-usage.30s.sh`](./swiftbar/ai-usage.30s.sh) | Menu-bar plugin wrapper (SwiftBar / xbar) |
| [`swiftbar/ai-usage.mjs`](./swiftbar/ai-usage.mjs) | Node body invoked by the `.sh` wrapper |

## Übersicht (desktop widget)

1. Install [Übersicht](http://tracesof.net/uebersicht/).
2. Open the widgets folder (Übersicht menu → **Open Widgets Folder**), typically:
   `~/Library/Application Support/Übersicht/widgets`
3. Symlink the widget (Übersicht picks up `.jsx` files; a directory also works):

```bash
REPO="/path/to/ai-usage-dashboard"   # adjust
WIDGETS="$HOME/Library/Application Support/Übersicht/widgets"

ln -sf "$REPO/macos/uebersicht/ai-usage.jsx" "$WIDGETS/ai-usage.jsx"
```

4. Ensure `npm start` is running. The widget refreshes every 30s.
5. If the server is down, the widget shows **Dashboard offline — run npm start**.

Codex’s caption is `snapshot · Xm ago` from `rateLimits.capturedAt`.

## SwiftBar (menu bar)

1. Install [SwiftBar](https://github.com/swiftbar/SwiftBar) (or xbar).
2. Set / open your **Plugins** folder in SwiftBar preferences.
3. Symlink the plugin (keep the `.30s.` segment — that is the refresh interval):

```bash
REPO="$HOME/ai-usage-dashboard"                               # your clone path
PLUGINS="$HOME/Library/Application Support/SwiftBar/Plugins"  # or your chosen folder

mkdir -p "$PLUGINS"
# Remove an older .js symlink if present
rm -f "$PLUGINS/ai-usage.30s.js"
ln -sf "$REPO/macos/swiftbar/ai-usage.30s.sh" "$PLUGINS/ai-usage.30s.sh"
chmod +x "$REPO/macos/swiftbar/ai-usage.30s.sh" "$REPO/macos/swiftbar/ai-usage.mjs"
```

The `.sh` wrapper finds Node at `/usr/local/bin/node` (or Volta) and runs
`ai-usage.mjs`, which loads `../shared/summary.mjs`. Symlink the `.sh` file (not
a copy) so that relative layout stays intact.

4. Menu bar shows **`AI`**. Click it for per-provider detail, Codex snapshot age,
   and a link to open the dashboard.

Requires **Node.js 20+** at `/usr/local/bin/node`, `/opt/homebrew/bin/node`,
or `~/.volta/bin/node` (GUI apps often lack your shell `PATH`).

## Offline behavior

If nothing is listening on `:4317`:

- Übersicht → red “Dashboard offline” message
- SwiftBar → `AI —` in the bar + offline note in the dropdown

## Not included (v1)

- Notification Center / WidgetKit (native Swift only — not HTML)
- LaunchAgent to auto-start `server.js`
- CORS headers (not needed for these clients)
