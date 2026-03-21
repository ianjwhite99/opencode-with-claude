#!/usr/bin/env bash
# =============================================================================
# opencode-with-claude installer
#
# One-command setup for OpenCode + Claude Max Proxy.
# Uses your Claude Max subscription ($100/mo) instead of API credits.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ianjwhite99/opencode-with-claude/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/ianjwhite99/opencode-with-claude/main/install.sh | bash -s -- --no-auth
#   curl -fsSL https://raw.githubusercontent.com/ianjwhite99/opencode-with-claude/main/install.sh | bash -s -- --help
# =============================================================================

set -euo pipefail

# --- Colors ---
MUTED='\033[0;2m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# --- Logging helpers ---
info()  { echo -e "${BLUE}[info]${NC} $1"; }
ok()    { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
fail()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }
step()  { echo -e "\n${CYAN}${BOLD}→ $1${NC}"; }

# --- Constants ---
REPO="ianjwhite99/opencode-with-claude"
INSTALL_DIR="$HOME/.opencode/bin"
OC_LAUNCHER_URL="https://raw.githubusercontent.com/$REPO/main/bin/oc"

# --- Defaults ---
no_auth=false
no_modify_path=false
run_uninstall=false

# --- Parse arguments ---
usage() {
    cat <<EOF
opencode-with-claude Installer

Usage: install.sh [options]

Options:
    -h, --help           Display this help message
        --no-auth        Skip Claude login prompt
        --no-modify-path Don't modify shell config files (.zshrc, .bashrc, etc.)
        --uninstall      Remove oc launcher and clean up PATH entries

Examples:
    curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | bash
    curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | bash -s -- --no-auth
    curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | bash -s -- --uninstall
EOF
}

# --- Uninstall function ---
do_uninstall() {
    echo ""
    echo -e "${BOLD}  Uninstalling opencode-with-claude...${NC}"
    echo ""

    # Remove oc launcher
    if [[ -f "$INSTALL_DIR/oc" ]]; then
        rm -f "$INSTALL_DIR/oc"
        ok "Removed $INSTALL_DIR/oc"
    else
        info "oc launcher not found at $INSTALL_DIR/oc"
    fi

    # Clean up empty install dir
    if [[ -d "$INSTALL_DIR" ]] && [[ -z "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]]; then
        rmdir "$INSTALL_DIR" 2>/dev/null && ok "Removed empty $INSTALL_DIR"
    fi

    # Remove PATH entries from shell configs
    local cleaned=false
    for rc in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile" \
              "${ZDOTDIR:-$HOME}/.zshrc" "$HOME/.config/fish/config.fish"; do
        if [[ -f "$rc" ]] && grep -q "# opencode-with-claude" "$rc" 2>/dev/null; then
            # Remove the comment and the line after it
            sed -i.bak '/# opencode-with-claude/,+1d' "$rc" 2>/dev/null \
              || sed -i '' '/# opencode-with-claude/,+1d' "$rc" 2>/dev/null
            rm -f "${rc}.bak"
            ok "Cleaned PATH entry from $rc"
            cleaned=true
        fi
    done
    if [[ "$cleaned" != "true" ]]; then
        info "No PATH entries found in shell configs"
    fi

    echo ""
    echo -e "${MUTED}  Note: Claude Code CLI, OpenCode, and claude-max-proxy were not removed.${NC}"
    echo -e "${MUTED}  To remove them:${NC}"
    echo -e "    npm uninstall -g @anthropic-ai/claude-code opencode-ai opencode-claude-max-proxy"
    echo ""
    ok "Uninstall complete!"
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            usage
            exit 0
            ;;
        --no-auth)
            no_auth=true
            shift
            ;;
        --no-modify-path)
            no_modify_path=true
            shift
            ;;
        --uninstall)
            run_uninstall=true
            shift
            ;;
        *)
            echo -e "${YELLOW}Warning: Unknown option '$1'${NC}" >&2
            shift
            ;;
    esac
done

# Run uninstall if requested
if [[ "$run_uninstall" == "true" ]]; then
    do_uninstall
fi

# =============================================================================
# Banner
# =============================================================================

echo ""
_BW=52
_bline() { printf "${BOLD}  │${NC} %-${_BW}s ${BOLD}│${NC}\n" "$1"; }
echo -e "${BOLD}  ┌$(printf '─%.0s' $(seq 1 $((_BW+2))))┐${NC}"
_bline "       opencode-with-claude installer"
_bline ""
_bline "  OpenCode + Claude Max Proxy"
_bline "  Use your Claude Max sub with OpenCode"
echo -e "${BOLD}  └$(printf '─%.0s' $(seq 1 $((_BW+2))))┘${NC}"
echo ""

# =============================================================================
# Step 1: Detect OS & prerequisites
# =============================================================================

step "Checking prerequisites..."

raw_os=$(uname -s)
case "$raw_os" in
    Darwin*) os="macos" ;;
    Linux*)  os="linux" ;;
    MINGW*|MSYS*|CYGWIN*) os="windows" ;;
    *) fail "Unsupported OS: $raw_os" ;;
esac
ok "OS: $os ($(uname -m))"

# Check for a JavaScript runtime (Node.js, Bun, or Deno)
JS_RUNTIME=""
if command -v node &>/dev/null; then
    node_version=$(node --version 2>/dev/null || echo "")
    if [[ -n "$node_version" ]]; then
        node_major=$(echo "$node_version" | sed 's/v//' | cut -d. -f1)
        if [[ "$node_major" -ge 18 ]]; then
            JS_RUNTIME="node"
            ok "Node.js $node_version"
        else
            warn "Node.js $node_version found but >= 18 recommended"
        fi
    fi
fi
if [[ -z "$JS_RUNTIME" ]] && command -v bun &>/dev/null; then
    bun_version=$(bun --version 2>/dev/null || echo "")
    if [[ -n "$bun_version" ]]; then
        JS_RUNTIME="bun"
        ok "Bun $bun_version"
    fi
fi
if [[ -z "$JS_RUNTIME" ]] && command -v deno &>/dev/null; then
    deno_version=$(deno --version 2>/dev/null | head -1 || echo "")
    if [[ -n "$deno_version" ]]; then
        JS_RUNTIME="deno"
        ok "Deno $deno_version"
    fi
fi
if [[ -z "$JS_RUNTIME" ]]; then
    fail "A JavaScript runtime is required (Node.js >= 18, Bun, or Deno). Install one and retry."
fi

# Check for curl (needed for health checks in launcher)
if command -v curl &>/dev/null; then
    ok "curl available"
else
    warn "curl not found — the launcher needs it for proxy health checks"
fi

# =============================================================================
# Step 2: Detect best package manager
# =============================================================================

step "Detecting package manager..."

pkg_manager=""
pkg_install_global=""

if command -v bun &>/dev/null; then
    pkg_manager="bun"
    pkg_install_global="bun install -g"
elif command -v npm &>/dev/null; then
    pkg_manager="npm"
    pkg_install_global="npm install -g"
elif command -v pnpm &>/dev/null; then
    pkg_manager="pnpm"
    pkg_install_global="pnpm install -g"
elif command -v yarn &>/dev/null; then
    pkg_manager="yarn"
    pkg_install_global="yarn global add"
else
    fail "No supported package manager found. Install one of: bun, npm, pnpm, yarn"
fi

ok "Using ${BOLD}$pkg_manager${NC}"

# --- Resolve global bin directory (to avoid Docker wrapper shadowing) ---
resolve_global_bin() {
    local bin_dir=""
    case "$pkg_manager" in
        bun)  bin_dir="$(bun pm bin -g 2>/dev/null || echo "$HOME/.bun/bin")" ;;
        npm)  bin_dir="$(npm config get prefix 2>/dev/null)/bin" ;;
        pnpm) bin_dir="$(pnpm bin -g 2>/dev/null)" ;;
        yarn) bin_dir="$(yarn global bin 2>/dev/null)" ;;
    esac
    echo "$bin_dir"
}

GLOBAL_BIN="$(resolve_global_bin)"

# Find the real binary, skipping Docker wrappers
find_real_bin() {
    local name="$1"
    # First try the package manager's global bin
    if [[ -n "$GLOBAL_BIN" ]] && [[ -x "$GLOBAL_BIN/$name" ]]; then
        echo "$GLOBAL_BIN/$name"
        return
    fi
    # Fallback: search PATH but skip Docker wrapper scripts
    local IFS=':'
    for dir in $PATH; do
        local candidate="$dir/$name"
        if [[ -x "$candidate" ]]; then
            # Skip Docker wrapper scripts (small shell scripts with "docker exec")
            # Only check text files under 1KB — real binaries are much larger
            if [[ -f "$candidate" ]] && [[ $(wc -c < "$candidate" 2>/dev/null || echo 99999) -lt 1024 ]] \
                && head -1 "$candidate" 2>/dev/null | grep -q "^#!" \
                && grep -q "docker exec" "$candidate" 2>/dev/null; then
                continue  # Skip this Docker wrapper
            fi
            echo "$candidate"
            return
        fi
    done
    # Last resort: just return the name and let it resolve normally
    echo "$name"
}

# Check if a real (non-Docker-wrapper) binary exists
has_real_bin() {
    local name="$1"
    local real_bin
    real_bin="$(find_real_bin "$name")"
    [[ "$real_bin" != "$name" ]] && [[ -x "$real_bin" ]]
}

# =============================================================================
# Step 3: Install components
# =============================================================================

install_package() {
    local name="$1"
    local bin_name="$2"
    local display_name="$3"

    if has_real_bin "$bin_name"; then
        info "$display_name already installed, updating to latest..."
        if $pkg_install_global "$name" 2>&1 | tail -5; then
            ok "$display_name updated"
        else
            warn "Failed to update $display_name. Try manually: $pkg_install_global $name"
        fi
    else
        info "Installing $display_name..."
        if $pkg_install_global "$name" 2>&1 | tail -5; then
            ok "$display_name installed"
        else
            fail "Failed to install $display_name. Try manually: $pkg_install_global $name"
        fi
    fi
}

step "Installing components..."

install_package "@anthropic-ai/claude-code" "claude" "Claude Code CLI"
install_package "opencode-ai" "opencode" "OpenCode"
install_package "opencode-claude-max-proxy" "claude-max-proxy" "Claude Max Proxy"

# --- Resolve real binary paths (after install, so they exist now) ---
CLAUDE_BIN="$(find_real_bin claude)"
OPENCODE_BIN="$(find_real_bin opencode)"

info "Using claude: $CLAUDE_BIN"
info "Using opencode: $OPENCODE_BIN"

# =============================================================================
# Step 4: Claude authentication
# =============================================================================

step "Checking Claude authentication..."

if "$CLAUDE_BIN" auth status 2>&1 | grep -q '"loggedIn": true'; then
    email=$("$CLAUDE_BIN" auth status 2>&1 | grep -o '"email": "[^"]*"' | head -1 | sed 's/"email": "//;s/"//')
    ok "Claude authenticated: $email"
elif [[ "$no_auth" == "true" ]]; then
    warn "Skipping auth (--no-auth). Run 'claude login' before using oc."
else
    warn "Claude Code CLI is not authenticated."
    echo ""
    echo -e "  ${MUTED}Your Claude Max subscription credentials are needed.${NC}"
    echo -e "  ${MUTED}This will open a browser for OAuth login.${NC}"
    echo ""

    # Only prompt if stdin is a terminal (not piped)
    if [ -t 0 ]; then
        read -p "  Would you like to log in now? [Y/n] " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
            "$CLAUDE_BIN" login
            if "$CLAUDE_BIN" auth status 2>&1 | grep -q '"loggedIn": true'; then
                ok "Claude authentication successful!"
            else
                warn "Authentication not completed. Run 'claude login' later."
            fi
        else
            warn "Skipped. Run 'claude login' before using oc."
        fi
    else
        warn "Non-interactive shell detected. Run 'claude login' after install."
    fi
fi

# =============================================================================
# Step 5: Clear any existing OpenCode Anthropic auth (proxy handles auth)
# =============================================================================

OPENCODE_AUTH_FILE="${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json"

if [ -f "$OPENCODE_AUTH_FILE" ] && grep -q '"anthropic"' "$OPENCODE_AUTH_FILE" 2>/dev/null; then
    info "Found existing Anthropic credentials in OpenCode auth, removing..."

    _js_code="
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
    "

    _auth_cleared=false
    if [[ "$JS_RUNTIME" == "node" ]]; then
        node -e "$_js_code" 2>/dev/null && _auth_cleared=true
    elif [[ "$JS_RUNTIME" == "bun" ]]; then
        bun -e "$_js_code" 2>/dev/null && _auth_cleared=true
    elif [[ "$JS_RUNTIME" == "deno" ]]; then
        deno eval "$_js_code" 2>/dev/null && _auth_cleared=true
    fi

    if [[ "$_auth_cleared" == "true" ]]; then
        ok "Anthropic credentials removed (proxy will handle auth)"
    else
        warn "Could not update auth file. Manually remove 'anthropic' key from $OPENCODE_AUTH_FILE"
    fi
else
    info "No existing Anthropic credentials in OpenCode — skipping"
fi

# =============================================================================
# Step 6: Install the `oc` launcher
# =============================================================================

step "Installing oc launcher..."

mkdir -p "$INSTALL_DIR"

# Prefer local copy if running from a clone, otherwise download from GitHub
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/bin/oc" ]]; then
    cp "$SCRIPT_DIR/bin/oc" "$INSTALL_DIR/oc"
    chmod 755 "$INSTALL_DIR/oc"
    ok "Installed oc from local repo to $INSTALL_DIR/oc"
elif curl -fsSL "$OC_LAUNCHER_URL" -o "$INSTALL_DIR/oc" 2>/dev/null; then
    chmod 755 "$INSTALL_DIR/oc"
    ok "Downloaded oc to $INSTALL_DIR/oc"
else
    fail "Couldn't download or find oc launcher. Install manually from $REPO"
fi

# =============================================================================
# Step 7: Add to PATH
# =============================================================================

add_to_path() {
    local config_file="$1"
    local command="$2"

    if grep -Fxq "$command" "$config_file" 2>/dev/null; then
        info "PATH entry already exists in $config_file"
    elif [[ -w "$config_file" ]]; then
        echo -e "\n# opencode-with-claude" >> "$config_file"
        echo "$command" >> "$config_file"
        ok "Added to PATH in $config_file"
    else
        warn "Couldn't write to $config_file. Manually add:"
        echo "  $command"
    fi
}

if [[ "$no_modify_path" != "true" ]] && [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
    step "Adding oc to PATH..."

    XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
    current_shell=$(basename "${SHELL:-bash}")

    case "$current_shell" in
        fish)
            config_files="$HOME/.config/fish/config.fish"
            path_cmd="fish_add_path $INSTALL_DIR"
            ;;
        zsh)
            config_files="${ZDOTDIR:-$HOME}/.zshrc"
            path_cmd="export PATH=$INSTALL_DIR:\$PATH"
            ;;
        bash)
            config_files="$HOME/.bashrc $HOME/.bash_profile $HOME/.profile"
            path_cmd="export PATH=$INSTALL_DIR:\$PATH"
            ;;
        *)
            config_files="$HOME/.bashrc $HOME/.profile"
            path_cmd="export PATH=$INSTALL_DIR:\$PATH"
            ;;
    esac

    added=false
    for file in $config_files; do
        if [[ -f "$file" ]]; then
            add_to_path "$file" "$path_cmd"
            added=true
            break
        fi
    done

    if [[ "$added" != "true" ]]; then
        warn "No shell config file found. Manually add to your PATH:"
        echo "  export PATH=$INSTALL_DIR:\$PATH"
    fi

    # Make it available in the current session
    export PATH="$INSTALL_DIR:$PATH"
else
    if [[ ":$PATH:" == *":$INSTALL_DIR:"* ]]; then
        ok "PATH already includes $INSTALL_DIR"
    fi
fi

# GitHub Actions support
if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    echo "$INSTALL_DIR" >> "$GITHUB_PATH"
    info "Added $INSTALL_DIR to \$GITHUB_PATH"
fi

# =============================================================================
# Done!
# =============================================================================

echo ""
_W=52
_line() { printf "${GREEN}${BOLD}  │${NC} %-${_W}s ${GREEN}${BOLD}│${NC}\n" "$1"; }
echo -e "${GREEN}${BOLD}  ┌$(printf '─%.0s' $(seq 1 $((_W+2))))┐${NC}"
_line ""
_line "        Installation complete!"
_line ""
_line "  To start:"
_line "    cd your-project"
_line "    oc"
_line ""
_line "  Web UI:"
_line "    oc web"
_line ""
_line "  Docs: github.com/$REPO"
_line ""
echo -e "${GREEN}${BOLD}  └$(printf '─%.0s' $(seq 1 $((_W+2))))┘${NC}"
echo ""

current_shell_name=$(basename "${SHELL:-bash}")
rc_file=""
case "$current_shell_name" in
    zsh)  rc_file="~/.zshrc" ;;
    fish) rc_file="~/.config/fish/config.fish" ;;
    *)    rc_file="~/.bashrc" ;;
esac

if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
    echo -e "  ${YELLOW}To use oc now, run:${NC}"
    echo ""
    echo -e "    export PATH=\"$INSTALL_DIR:\$PATH\""
    echo ""
    echo -e "  ${MUTED}Or restart your terminal (PATH was added to $rc_file)${NC}"
    echo ""
fi
