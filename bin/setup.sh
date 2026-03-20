#!/bin/bash
# =============================================================================
# opencode-with-claude setup script (non-Docker)
#
# Installs everything needed to run OpenCode with Claude Max proxy:
#   1. Claude Code CLI
#   2. OpenCode
#   3. opencode-claude-max-proxy
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/<org>/opencode-with-claude/main/bin/setup.sh | bash
#   # or
#   ./bin/setup.sh
# =============================================================================

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[setup]${NC} $1"; }
ok()    { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
fail()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

echo ""
echo "  ┌─────────────────────────────────────┐"
echo "  │     opencode-with-claude  setup      │"
echo "  │                                      │"
echo "  │  OpenCode + Claude Max Proxy         │"
echo "  │  Zero-config, one command.           │"
echo "  └─────────────────────────────────────┘"
echo ""

# --- Check prerequisites ---
info "Checking prerequisites..."

if command -v node &>/dev/null; then
  NODE_VERSION=$(node --version)
  ok "Node.js $NODE_VERSION"
else
  fail "Node.js is required. Install from https://nodejs.org"
fi

# --- Install Claude Code CLI ---
if command -v claude &>/dev/null; then
  ok "Claude Code CLI already installed"
else
  info "Installing Claude Code CLI..."
  npm install -g @anthropic-ai/claude-code
  ok "Claude Code CLI installed"
fi

# --- Install OpenCode ---
if command -v opencode &>/dev/null; then
  ok "OpenCode already installed"
else
  info "Installing OpenCode..."
  npm install -g opencode-ai
  ok "OpenCode installed"
fi

# --- Install opencode-claude-max-proxy ---
if command -v claude-max-proxy &>/dev/null; then
  ok "claude-max-proxy already installed"
else
  info "Installing opencode-claude-max-proxy..."
  npm install -g opencode-claude-max-proxy
  ok "claude-max-proxy installed"
fi

# --- Claude authentication ---
echo ""
info "Checking Claude authentication..."
if claude auth status 2>&1 | grep -q '"loggedIn": true'; then
  EMAIL=$(claude auth status 2>&1 | grep -o '"email": "[^"]*"' | head -1)
  ok "Claude authenticated: $EMAIL"
else
  warn "Claude Code CLI is not authenticated."
  echo ""
  echo "  Run: claude login"
  echo ""
  read -p "  Would you like to log in now? [Y/n] " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
    claude login
  fi
fi

# --- Clear any existing OpenCode Anthropic auth ---
info "Clearing any existing OpenCode Anthropic auth (proxy handles auth)..."
opencode auth logout 2>/dev/null || true
ok "OpenCode auth cleared"

# --- Done ---
echo ""
echo "  ┌─────────────────────────────────────┐"
echo "  │          Setup complete!             │"
echo "  │                                      │"
echo "  │  To start:                           │"
echo "  │    ./bin/start.sh                    │"
echo "  │                                      │"
echo "  │  Or manually:                        │"
echo "  │    # Terminal 1: start proxy         │"
echo "  │    CLAUDE_PROXY_PASSTHROUGH=1 \      │"
echo "  │      claude-max-proxy                │"
echo "  │                                      │"
echo "  │    # Terminal 2: start opencode      │"
echo "  │    ANTHROPIC_API_KEY=dummy \          │"
echo "  │    ANTHROPIC_BASE_URL=\               │"
echo "  │      http://127.0.0.1:3456 \         │"
echo "  │      opencode                        │"
echo "  └─────────────────────────────────────┘"
echo ""
