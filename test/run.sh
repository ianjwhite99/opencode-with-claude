#!/usr/bin/env bash
# =============================================================================
# Test runner for opencode-with-claude plugin
#
# Builds the plugin, sets up a local plugin directory, and launches OpenCode
# so you can verify the plugin works end-to-end.
#
# Uses the .opencode/plugins/ local loading mechanism (no npm link needed).
#
# Usage:
#   ./test/run.sh          # Build and launch OpenCode with plugin
#   ./test/run.sh --clean  # Remove build artifacts
# =============================================================================

set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${BLUE}[test]${NC} $1"; }
ok()    { echo -e "${GREEN}[test]${NC} $1"; }
fail()  { echo -e "${RED}[test]${NC} $1"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Clean ---
if [[ "${1:-}" == "--clean" ]]; then
    info "Cleaning up..."
    rm -rf "$PLUGIN_DIR/dist"
    ok "Cleaned. dist/ deleted."
    exit 0
fi

# --- Preflight ---
command -v opencode &>/dev/null || fail "OpenCode not found. Run: npm install -g opencode-ai"
command -v claude &>/dev/null || fail "Claude CLI not found. Run: npm install -g @anthropic-ai/claude-code"

# --- Check auth ---
info "Checking Claude authentication..."
if ! claude auth status 2>&1 | grep -q '"loggedIn": true'; then
    fail "Claude not authenticated. Run: claude login"
fi
ok "Claude authenticated"

# --- Install deps ---
info "Installing plugin dependencies..."
(cd "$PLUGIN_DIR" && npm install --silent)

# --- Build ---
info "Building plugin..."
(cd "$PLUGIN_DIR" && npm run build)
ok "Build complete"

# --- Set up test workspace ---
WORK_DIR=$(mktemp -d)
info "Test workspace: $WORK_DIR"

# Copy opencode.json (the plugin's config hook handles provider setup automatically)
cp "$SCRIPT_DIR/opencode.json" "$WORK_DIR/opencode.json"

# Set up .opencode/plugins/ with symlink to built plugin
mkdir -p "$WORK_DIR/.opencode/plugins"
ln -sf "$PLUGIN_DIR/dist/index.js" "$WORK_DIR/.opencode/plugins/claude-proxy.js"

# Add package.json for the plugin's runtime dependency
cat > "$WORK_DIR/.opencode/package.json" << 'EOF'
{
  "dependencies": {
    "opencode-claude-max-proxy": "latest"
  }
}
EOF

cleanup() {
    rm -rf "$WORK_DIR"
}
trap cleanup EXIT

# --- Launch OpenCode ---
info "Launching OpenCode with local plugin..."
info "Plugin: $PLUGIN_DIR/dist/index.js -> .opencode/plugins/claude-proxy.js"
info "The plugin will start its own proxy on an OS-assigned port."
info ""

(cd "$WORK_DIR" && opencode "$@")
