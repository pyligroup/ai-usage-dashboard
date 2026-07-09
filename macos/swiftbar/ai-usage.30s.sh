#!/bin/bash
# <xbar.title>AI Usage</xbar.title>
# <xbar.desc>Claude / Codex / Cursor usage from local ai-usage-dashboard</xbar.desc>
# <xbar.dependencies>node</xbar.dependencies>
# <swiftbar.hideSwiftBar>false</swiftbar.hideSwiftBar>
# <swiftbar.runInBash>false</swiftbar.runInBash>
#
# SwiftBar plugin — refresh every 30s (filename .30s.).
# Calls the Node implementation next to this file so GUI PATH / bash-wrapping
# cannot break ESM imports. Requires dashboard: npm start → :4317

set -euo pipefail

# Resolve real plugin dir even when this file is a symlink in SwiftBar's Plugins folder
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
ROOT="$(cd -P "$(dirname "$SOURCE")/.." && pwd)"
NODE_SCRIPT="$ROOT/swiftbar/ai-usage.mjs"

# Prefer absolute paths GUI apps can see (SwiftBar's PATH is often minimal)
if [ -x /usr/local/bin/node ]; then
  NODE=/usr/local/bin/node
elif [ -x /opt/homebrew/bin/node ]; then
  NODE=/opt/homebrew/bin/node
elif [ -x "$HOME/.volta/bin/node" ]; then
  NODE="$HOME/.volta/bin/node"
elif command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
else
  echo "AI ?"
  echo "---"
  echo "node not found — install Node 20+ (/usr/local, /opt/homebrew, or Volta)"
  exit 0
fi

exec "$NODE" "$NODE_SCRIPT"
