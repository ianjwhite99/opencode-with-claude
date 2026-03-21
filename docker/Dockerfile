# =============================================================================
# opencode-with-claude: All-in-one Docker image
# OpenCode + Claude Max Proxy + Claude Code CLI
# =============================================================================

FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git unzip \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

RUN curl -fsSL https://bun.sh/install | bash \
    && cp /root/.bun/bin/bun /usr/local/bin/bun \
    && chmod 755 /usr/local/bin/bun

RUN npm install -g @anthropic-ai/claude-code opencode-claude-max-proxy opencode-ai \
    && npm cache clean --force

RUN useradd -m -s /bin/bash -u 1001 opencode \
    && mkdir -p \
      /home/opencode/.claude \
      /home/opencode/.config/opencode \
      /home/opencode/.local/share/opencode \
      /home/opencode/.local/state/opencode \
      /home/opencode/.cache/opencode \
      /home/opencode/workspace \
    && chown -R opencode:opencode /home/opencode

USER opencode
WORKDIR /home/opencode

COPY --chown=opencode:opencode --chmod=755 docker/entrypoint.sh /home/opencode/entrypoint.sh

ENV CLAUDE_PROXY_PASSTHROUGH=1 \
    CLAUDE_PROXY_HOST=127.0.0.1 \
    CLAUDE_PROXY_PORT=3456 \
    OPENCODE_HOST=0.0.0.0

ENTRYPOINT ["/home/opencode/entrypoint.sh"]

EXPOSE 4096