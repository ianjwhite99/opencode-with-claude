#!/bin/bash
# =============================================================================
# opencode-with-claude entrypoint
#
# Handles root→user switch, SSH/git config, Claude auth, proxy, and OpenCode.
# =============================================================================

set -e

# --- Root → user switch (for Docker volume ownership) ---
if [ "$(id -u)" = "0" ]; then
    # Copy root's Claude auth to opencode user if login was done as root
    if [ -f /root/.claude.json ] && [ ! -f /home/opencode/.claude/.claude.json ]; then
        cp /root/.claude.json /home/opencode/.claude/.claude.json 2>/dev/null || true
    fi
    if [ -d /root/.claude ] && [ "$(ls -A /root/.claude 2>/dev/null)" ]; then
        cp -rn /root/.claude/* /home/opencode/.claude/ 2>/dev/null || true
    fi

    chown opencode:opencode /home/opencode
    chown -R opencode:opencode \
      /home/opencode/.claude \
      /home/opencode/.config/opencode \
      /home/opencode/.local/share/opencode \
      /home/opencode/.local/state/opencode \
      /home/opencode/.cache/opencode \
      /home/opencode/workspace
    exec su opencode -s /bin/bash -c "$0"
fi

PROXY_PORT="${CLAUDE_PROXY_PORT:-3456}"
CLAUDE_DIR="/home/opencode/.claude"

# --- SSH & Git setup ---
if [ -d /tmp/.ssh ] && [ -n "$(ls -A /tmp/.ssh 2>/dev/null)" ]; then
  cp -r /tmp/.ssh /home/opencode/.ssh
  chmod 700 /home/opencode/.ssh
  chmod 600 /home/opencode/.ssh/* 2>/dev/null || true
  chmod 644 /home/opencode/.ssh/*.pub /home/opencode/.ssh/known_hosts 2>/dev/null || true
fi

if [ -f /tmp/.gitconfig ] && [ -s /tmp/.gitconfig ]; then
  cp /tmp/.gitconfig /home/opencode/.gitconfig
fi

git config --global --add safe.directory "*"

# --- Claude auth persistence ---
CLAUDE_JSON="/home/opencode/.claude.json"
CLAUDE_JSON_VOL="$CLAUDE_DIR/.claude.json"

if [ -f "$CLAUDE_JSON_VOL" ] && [ ! -f "$CLAUDE_JSON" ]; then
  ln -sf "$CLAUDE_JSON_VOL" "$CLAUDE_JSON"
elif [ -f "$CLAUDE_JSON" ] && [ ! -L "$CLAUDE_JSON" ] && [ -w "$CLAUDE_DIR" ]; then
  cp "$CLAUDE_JSON" "$CLAUDE_JSON_VOL" 2>/dev/null || true
  rm -f "$CLAUDE_JSON"
  ln -sf "$CLAUDE_JSON_VOL" "$CLAUDE_JSON"
fi

# --- Check Claude authentication ---
echo "[opencode-with-claude] Checking Claude authentication..."
if claude auth status 2>&1 | grep -q '"loggedIn": true'; then
  EMAIL=$(claude auth status 2>&1 | grep -o '"email": "[^"]*"' | head -1)
  echo "[opencode-with-claude] Authenticated: $EMAIL"
else
  echo ""
  echo "============================================"
  echo "  Claude Code CLI is not authenticated!"
  echo ""
  echo "  Run:"
  echo "    docker exec -it -u opencode opencode-with-claude claude login"
  echo "============================================"
  echo ""
  echo "[opencode-with-claude] Starting without auth. Proxy will fail until you log in."
fi

# --- Auto-update components if requested ---
if [ "${OC_AUTO_UPDATE:-}" = "true" ] || [ "${OC_AUTO_UPDATE:-}" = "1" ]; then
  echo "[opencode-with-claude] Auto-updating components..."
  npm install -g @anthropic-ai/claude-code opencode-ai opencode-claude-max-proxy 2>&1 | tail -5
  echo "[opencode-with-claude] Update complete."
fi

# --- Auto-update components if requested ---
if [ "${OC_AUTO_UPDATE:-}" = "true" ] || [ "${OC_AUTO_UPDATE:-}" = "1" ]; then
  echo "[opencode-with-claude] Auto-updating components..."
  npm install -g @anthropic-ai/claude-code opencode-ai opencode-claude-max-proxy 2>&1 | tail -5
  echo "[opencode-with-claude] Update complete."
fi

# --- Start proxy in background ---
# Unset vars that would cause the SDK subprocess to loop back to the proxy
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY 2>/dev/null || true

echo "[opencode-with-claude] Starting proxy on port $PROXY_PORT..."
CLAUDE_PROXY_WORKDIR=/home/opencode/workspace \
CLAUDE_PROXY_PORT="$PROXY_PORT" \
CLAUDE_PROXY_PASSTHROUGH="${CLAUDE_PROXY_PASSTHROUGH:-1}" \
  claude-max-proxy &
PROXY_PID=$!

cleanup() {
  echo "[opencode-with-claude] Shutting down..."
  kill $PROXY_PID 2>/dev/null
  wait $PROXY_PID 2>/dev/null
}
trap cleanup EXIT INT TERM

# --- Wait for proxy to be healthy ---
echo "[opencode-with-claude] Waiting for proxy..."
for i in $(seq 1 100); do
  if curl -sf "http://127.0.0.1:$PROXY_PORT/health" > /dev/null 2>&1; then
    echo "[opencode-with-claude] Proxy is ready!"
    break
  fi
  if ! kill -0 $PROXY_PID 2>/dev/null; then
    echo "[opencode-with-claude] WARNING: Proxy process died, continuing anyway..."
    break
  fi
  sleep 0.1
done

# --- Launch OpenCode ---
echo "[opencode-with-claude] Starting OpenCode web on port 4096..."
export ANTHROPIC_API_KEY=dummy
export ANTHROPIC_BASE_URL="http://127.0.0.1:$PROXY_PORT"

exec opencode web --hostname 0.0.0.0 --port 4096
