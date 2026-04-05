#!/usr/bin/env bash
# enable-in-project.sh
# Run this from the root of any git repo to enable markdown-for-agents-mcp in that project.
# Usage: bash /path/to/markdown-for-agents-mcp/scripts/enable-in-project.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_ENTRY="$SERVER_DIR/dist/index.js"
TARGET_DIR="$(pwd)"

# ── Helpers ───────────────────────────────────────────────────────────────────

confirm() {
  local prompt="$1"
  local response
  read -r -p "$prompt [y/N] " response
  [[ "$response" =~ ^[Yy]$ ]]
}

# ── Checks ────────────────────────────────────────────────────────────────────

if [ ! -f "$TARGET_DIR/.git/config" ] && [ ! -d "$TARGET_DIR/.git" ]; then
  echo "Error: not a git repository root. Run this script from the root of your project." >&2
  exit 1
fi

echo "This script will enable markdown-for-agents-mcp in:"
echo "  $TARGET_DIR"
echo ""
echo "It will:"
echo "  • Create or update .mcp.json  (registers the MCP server)"
echo "  • Create or update .claude/settings.json  (disables built-in WebFetch and WebSearch)"
echo "  • Add .claude/settings.local.json to .gitignore"
echo ""

if ! confirm "Proceed?"; then
  echo "Aborted."
  exit 0
fi
echo ""

# ── Build if needed ───────────────────────────────────────────────────────────

if [ ! -f "$SERVER_ENTRY" ]; then
  echo "markdown-for-agents-mcp is not built. Building now..."
  (cd "$SERVER_DIR" && npm install --ignore-scripts && npm run build)
  echo ""
fi

# ── .mcp.json ─────────────────────────────────────────────────────────────────

MCP_FILE="$TARGET_DIR/.mcp.json"

if [ -f "$MCP_FILE" ]; then
  if grep -q '"markdown-agents"' "$MCP_FILE"; then
    echo "✓ .mcp.json already contains markdown-agents — skipping"
  else
    echo ".mcp.json exists but does not contain markdown-agents."
    if confirm "  Add markdown-agents to existing .mcp.json?"; then
      # Insert our server entry before the closing brace of mcpServers using python for safe JSON merge
      python3 - "$MCP_FILE" "$SERVER_ENTRY" <<'PYEOF'
import json, sys
path, entry = sys.argv[1], sys.argv[2]
with open(path) as f:
    data = json.load(f)
data.setdefault("mcpServers", {})["markdown-agents"] = {
    "command": "node",
    "args": [entry]
}
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PYEOF
      echo "✓ Added markdown-agents to .mcp.json"
    else
      echo "  Skipped .mcp.json"
    fi
  fi
else
  cat > "$MCP_FILE" <<EOF
{
  "mcpServers": {
    "markdown-agents": {
      "command": "node",
      "args": ["$SERVER_ENTRY"]
    }
  }
}
EOF
  echo "✓ Created .mcp.json"
fi

# ── .claude/settings.json ─────────────────────────────────────────────────────

CLAUDE_DIR="$TARGET_DIR/.claude"
SETTINGS_FILE="$CLAUDE_DIR/settings.json"

mkdir -p "$CLAUDE_DIR"

if [ -f "$SETTINGS_FILE" ]; then
  if grep -q '"WebFetch"\|"WebSearch"' "$SETTINGS_FILE"; then
    echo "✓ .claude/settings.json already denies WebFetch/WebSearch — skipping"
  else
    echo ".claude/settings.json exists but does not deny WebFetch/WebSearch."
    if confirm "  Add deny rules to existing .claude/settings.json?"; then
      python3 - "$SETTINGS_FILE" <<'PYEOF'
import json, sys
path = sys.argv[1]
with open(path) as f:
    data = json.load(f)
perms = data.setdefault("permissions", {})
deny = perms.setdefault("deny", [])
for tool in ["WebFetch", "WebSearch"]:
    if tool not in deny:
        deny.append(tool)
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PYEOF
      echo "✓ Updated .claude/settings.json"
    else
      echo "  Skipped .claude/settings.json"
    fi
  fi
else
  cat > "$SETTINGS_FILE" <<'EOF'
{
  "permissions": {
    "deny": ["WebFetch", "WebSearch"]
  }
}
EOF
  echo "✓ Created .claude/settings.json"
fi

# ── .gitignore ────────────────────────────────────────────────────────────────

GITIGNORE="$TARGET_DIR/.gitignore"
IGNORE_ENTRY=".claude/settings.local.json"

if [ -f "$GITIGNORE" ] && grep -qxF "$IGNORE_ENTRY" "$GITIGNORE"; then
  echo "✓ .gitignore already contains $IGNORE_ENTRY"
else
  echo "$IGNORE_ENTRY" >> "$GITIGNORE"
  echo "✓ Added $IGNORE_ENTRY to .gitignore"
fi

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo "Done. markdown-for-agents-mcp is enabled for: $TARGET_DIR"
echo ""
echo "Next steps:"
echo "  1. git add .mcp.json .claude/settings.json .gitignore && git commit"
echo "  2. Open the project in Claude Code and run /mcp to verify the server is connected"
echo ""
echo "Note: .mcp.json uses an absolute path to this machine's server binary."
echo "      Other contributors will need their own copy of markdown-for-agents-mcp."
