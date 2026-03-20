#!/bin/bash
# =============================================================================
# opencode-with-claude launcher (non-Docker)
#
# Starts the proxy in the background, waits for health, launches OpenCode.
# Everything cleans up on exit.
#
# Usage:
#   ./bin/start.sh [opencode args...]
# =============================================================================

set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${BLUE}[opencode-with-claude]${NC} $1"; }
ok()    { echo -e "${GREEN}[opencode-with-claude]${NC} $1"; }
fail()  { echo -e "${RED}[opencode-with-claude]${NC} $1"; exit 1; }

# --- Preflight checks ---
command -v claude &>/dev/null || fail "Claude Code CLI not found. Run: npm install -g @anthropic-ai/claude-code"
command -v opencode &>/dev/null || fail "OpenCode not found. Run: npm install -g opencode-ai"
command -v claude-max-proxy &>/dev/null || fail "claude-max-proxy not found. Run: npm install -g opencode-claude-max-proxy"

# --- Check authentication ---
if ! claude auth status 2>&1 | grep -q '"loggedIn": true'; then
  fail "Claude not authenticated. Run: claude login"
fi

# --- Pick a random port ---
PORT=$(node -e "const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close() })" 2>/dev/null \
  || echo $((RANDOM + 10000)))

# --- Start proxy in background ---
info "Starting proxy on port $PORT..."
CLAUDE_PROXY_PORT=$PORT \
CLAUDE_PROXY_PASSTHROUGH=1 \
CLAUDE_PROXY_WORKDIR="$PWD" \
  claude-max-proxy > /dev/null 2>&1 &
PROXY_PID=$!

cleanup() {
  info "Shutting down proxy..."
  kill $PROXY_PID 2>/dev/null
  wait $PROXY_PID 2>/dev/null
}
trap cleanup EXIT INT TERM

# --- Wait for health ---
for i in $(seq 1 100); do
  if curl -sf "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
    ok "Proxy ready on port $PORT"
    break
  fi
  if ! kill -0 $PROXY_PID 2>/dev/null; then
    fail "Proxy failed to start"
  fi
  sleep 0.1
done

if ! curl -sf "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
  fail "Proxy didn't become healthy within 10 seconds"
fi

# --- Launch OpenCode ---
info "Launching OpenCode..."
ANTHROPIC_API_KEY=dummy \
ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" \
  opencode "$@"
