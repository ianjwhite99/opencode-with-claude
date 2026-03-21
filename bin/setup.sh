#!/bin/bash
# =============================================================================
# opencode-with-claude setup script (git clone workflow)
#
# Installs everything needed to run OpenCode with Claude Max proxy:
#   1. Claude Code CLI
#   2. OpenCode
#   3. opencode-claude-max-proxy
#   4. oc launcher → ~/.opencode/bin/oc
#
# Usage:
#   git clone https://github.com/ianjwhite99/opencode-with-claude.git
#   cd opencode-with-claude
#   ./bin/setup.sh
# =============================================================================

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
BOLD='\033[1m'
MUTED='\033[0;2m'
NC='\033[0m'

info()  { echo -e "${BLUE}[setup]${NC} $1"; }
ok()    { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
fail()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

INSTALL_DIR="$HOME/.opencode/bin"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

# --- Detect package manager ---
pkg_install_global=""
if command -v bun &>/dev/null; then
  pkg_install_global="bun install -g"
  ok "Package manager: bun"
elif command -v npm &>/dev/null; then
  pkg_install_global="npm install -g"
  ok "Package manager: npm"
elif command -v pnpm &>/dev/null; then
  pkg_install_global="pnpm install -g"
  ok "Package manager: pnpm"
elif command -v yarn &>/dev/null; then
  pkg_install_global="yarn global add"
  ok "Package manager: yarn"
else
  fail "No supported package manager found. Install one of: bun, npm, pnpm, yarn"
fi

# --- Install/Update Claude Code CLI ---
if command -v claude &>/dev/null; then
  info "Claude Code CLI already installed, updating to latest..."
  $pkg_install_global @anthropic-ai/claude-code
  ok "Claude Code CLI updated"
else
  info "Installing Claude Code CLI..."
  $pkg_install_global @anthropic-ai/claude-code
  ok "Claude Code CLI installed"
fi

# --- Install/Update OpenCode ---
if command -v opencode &>/dev/null; then
  info "OpenCode already installed, updating to latest..."
  $pkg_install_global opencode-ai
  ok "OpenCode updated"
else
  info "Installing OpenCode..."
  $pkg_install_global opencode-ai
  ok "OpenCode installed"
fi

# --- Install/Update opencode-claude-max-proxy ---
if command -v claude-max-proxy &>/dev/null; then
  info "claude-max-proxy already installed, updating to latest..."
  $pkg_install_global opencode-claude-max-proxy
  ok "claude-max-proxy updated"
else
  info "Installing opencode-claude-max-proxy..."
  $pkg_install_global opencode-claude-max-proxy
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

# --- Clear any existing OpenCode Anthropic auth (proxy handles auth) ---
OPENCODE_AUTH_FILE="${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json"

if [ -f "$OPENCODE_AUTH_FILE" ] && grep -q '"anthropic"' "$OPENCODE_AUTH_FILE" 2>/dev/null; then
    info "Found existing Anthropic credentials in OpenCode auth, removing..."
    node -e "
        const fs = require('fs');
        const path = '$OPENCODE_AUTH_FILE';
        try {
            const auth = JSON.parse(fs.readFileSync(path, 'utf8'));
            if (auth.anthropic) {
                delete auth.anthropic;
                fs.writeFileSync(path, JSON.stringify(auth, null, 2) + '\n');
                console.log('Removed Anthropic credentials from OpenCode auth');
            }
        } catch (e) {
            console.error('Warning: Could not update auth file:', e.message);
        }
    " 2>/dev/null
    ok "Anthropic credentials removed (proxy will handle auth)"
else
    info "No existing Anthropic credentials in OpenCode — skipping"
fi

# --- Install oc launcher ---
info "Installing oc launcher..."
mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR/oc" "$INSTALL_DIR/oc"
chmod 755 "$INSTALL_DIR/oc"
ok "Installed oc to $INSTALL_DIR/oc"

# --- Add to PATH if needed ---
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
  current_shell=$(basename "${SHELL:-bash}")
  case "$current_shell" in
    fish) path_cmd="fish_add_path $INSTALL_DIR" ;;
    *)    path_cmd="export PATH=$INSTALL_DIR:\$PATH" ;;
  esac

  case "$current_shell" in
    fish) config_file="$HOME/.config/fish/config.fish" ;;
    zsh)  config_file="${ZDOTDIR:-$HOME}/.zshrc" ;;
    *)    config_file="$HOME/.bashrc" ;;
  esac

  if [[ -f "$config_file" ]] && ! grep -Fxq "$path_cmd" "$config_file" 2>/dev/null; then
    echo -e "\n# opencode-with-claude" >> "$config_file"
    echo "$path_cmd" >> "$config_file"
    ok "Added oc to PATH in $config_file"
  fi

  export PATH="$INSTALL_DIR:$PATH"
fi

# --- Done ---
echo ""
echo -e "  ${GREEN}${BOLD}┌─────────────────────────────────────┐${NC}"
echo -e "  ${GREEN}${BOLD}│          Setup complete!             │${NC}"
echo -e "  ${GREEN}${BOLD}│                                      │${NC}"
echo -e "  ${GREEN}${BOLD}│  ${NC}${BOLD}To start:${NC}${GREEN}${BOLD}                           │${NC}"
echo -e "  ${GREEN}${BOLD}│  ${NC}  cd your-project${GREEN}${BOLD}                   │${NC}"
echo -e "  ${GREEN}${BOLD}│  ${NC}  oc${GREEN}${BOLD}                                 │${NC}"
echo -e "  ${GREEN}${BOLD}│                                      │${NC}"
echo -e "  ${GREEN}${BOLD}│  ${NC}${BOLD}Web UI:${NC}${GREEN}${BOLD}                             │${NC}"
echo -e "  ${GREEN}${BOLD}│  ${NC}  oc web${GREEN}${BOLD}                             │${NC}"
echo -e "  ${GREEN}${BOLD}│                                      │${NC}"
echo -e "  ${GREEN}${BOLD}│  ${NC}${MUTED}Or run directly: ./bin/oc${NC}${GREEN}${BOLD}           │${NC}"
echo -e "  ${GREEN}${BOLD}└─────────────────────────────────────┘${NC}"
echo ""

if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
  echo -e "  ${YELLOW}Restart your shell or run:${NC}"
  echo -e "    source ~/.bashrc  ${MUTED}# or ~/.zshrc${NC}"
  echo ""
fi
