# opencode-with-claude

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Use [OpenCode](https://opencode.ai) with your [Claude Max](https://claude.ai) subscription.

## How It Works

```
┌─────────────┐              ┌────────────────────┐       ┌─────────────────┐
│  OpenCode   │─────────────▶│  Claude Max Proxy  │──────▶│    Anthropic    │
│  (TUI/Web)  │ :3456 / auto │   (local server)   │  SDK  │    Claude Max   │
│             │◀─────────────│                    │◀──────│                 │
└─────────────┘              └────────────────────┘       └─────────────────┘
```

[OpenCode](https://opencode.ai) speaks the Anthropic REST API. Claude Max provides access via the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) (not the REST API). The [opencode-claude-max-proxy](https://github.com/rynfar/opencode-claude-max-proxy) bridges the gap — it accepts API requests from OpenCode and translates them into Agent SDK calls using your Claude Max session.

## Quick Start

There are three ways to get started: the **plugin** (recommended), the **standalone installer**, or **Docker**.

### Option A: OpenCode Plugin (recommended)

The plugin manages the proxy lifecycle automatically — it starts the proxy when OpenCode launches, configures the Anthropic provider, and cleans up on exit. Each OpenCode instance gets its own proxy on an OS-assigned port, so multiple instances can run simultaneously without conflicts.

**1. Authenticate with Claude (one-time)**

```bash
npm install -g @anthropic-ai/claude-code
claude login
```

**2. Add to your `opencode.json`**

Global (`~/.config/opencode/opencode.json`) or project-level:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-with-claude"],
  "provider": {
    "anthropic": {
      "options": {
        "baseURL": "http://127.0.0.1:3456",
        "apiKey": "dummy"
      }
    }
  }
}
```

The `apiKey` is a dummy value — authentication goes through your Claude Max session, not an API key. The `baseURL` points to the default proxy port (3456). If that port is already in use (e.g. another opencode instance), the plugin automatically starts the proxy on a different port and overrides the `baseURL` at runtime.

**3. Run OpenCode**

```bash
opencode
```

### Option B: Standalone Installer (`oc` launcher)

A one-liner that installs all dependencies and gives you the `oc` command — no config files to edit.

```bash
curl -fsSL https://raw.githubusercontent.com/ianjwhite99/opencode-with-claude/main/install.sh | bash
```

This installs:
- [Claude Code CLI](https://www.npmjs.com/package/@anthropic-ai/claude-code) — authentication with Claude
- [OpenCode](https://www.npmjs.com/package/opencode-ai) — the coding assistant
- [opencode-claude-max-proxy](https://www.npmjs.com/package/opencode-claude-max-proxy) — bridges OpenCode to Claude Max
- **`oc`** — launcher that ties it all together

Then run:

```bash
cd your-project
oc
```

The `oc` command starts the proxy in the background, waits for it to be ready, and launches OpenCode.

### Option C: Docker

Run everything in a container with the OpenCode web UI exposed on port 4096.

```bash
git clone https://github.com/ianjwhite99/opencode-with-claude.git
cd opencode-with-claude

# Build and start
docker compose -f docker/docker-compose.yml up -d

# Authenticate (first time only)
docker exec -it -u opencode opencode-with-claude claude login

# Open the web UI
open http://localhost:4096
```

The container runs the proxy and OpenCode web UI together. Your `~/workspace` directory is mounted into the container, and Claude auth, OpenCode data, and config are persisted across restarts via Docker volumes.

## Prerequisites

- **Node.js >= 18** — [nodejs.org](https://nodejs.org) (or Bun/Deno) — not needed for Docker
- **Claude Max subscription** — the $100/mo plan on [claude.ai](https://claude.ai)

## `oc` Launcher Reference

The `oc` launcher handles everything — starts the proxy, waits for health, launches OpenCode, and cleans up on exit:

```bash
oc              # Start OpenCode TUI in current directory
oc web          # Start OpenCode web UI on port 4096
oc update       # Update all components to latest versions
oc --help       # Show help
oc --version    # Show component versions
```

All arguments are passed through to `opencode`, so anything that works with `opencode` works with `oc`.

### Installer Options

```bash
# Skip the Claude login prompt
curl -fsSL ... | bash -s -- --no-auth

# Don't modify shell PATH
curl -fsSL ... | bash -s -- --no-modify-path

# Show help
curl -fsSL ... | bash -s -- --help
```

### Uninstalling

Remove the `oc` launcher and clean up PATH entries:

```bash
curl -fsSL https://raw.githubusercontent.com/ianjwhite99/opencode-with-claude/main/install.sh | bash -s -- --uninstall
```

This removes the `oc` launcher from `~/.opencode/bin` and cleans up any PATH entries added to your shell config. To also remove the underlying tools:

```bash
npm uninstall -g @anthropic-ai/claude-code opencode-ai opencode-claude-max-proxy
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_PROXY_PORT` | `3456` | Preferred port for the proxy (falls back to a random port if in use) |
| `CLAUDE_PROXY_WORKDIR` | `$PWD` | Working directory for the proxy |
| `OC_SKIP_AUTH_CHECK` | unset | Set to `1` to skip Claude auth check on `oc` launch |
| `OC_AUTO_UPDATE` | unset | Set to `true` or `1` to auto-update components on Docker container start |

## Troubleshooting

### "Claude Code CLI not found"

```bash
npm install -g @anthropic-ai/claude-code
```

### "Claude not authenticated"

```bash
claude login
```

This opens a browser for OAuth. Your Claude Max subscription credentials are needed.

### "Proxy failed to start"

1. Check Claude auth: `claude auth status`
2. Ensure your internet connection is working
3. If using a manual port override, check if it's in use: `lsof -i :$CLAUDE_PROXY_PORT`

### Updating components

```bash
# oc launcher
oc update

# Plugin / manual
npm install -g @anthropic-ai/claude-code opencode-ai opencode-claude-max-proxy

# Docker
docker compose -f docker/docker-compose.yml build --no-cache && docker compose -f docker/docker-compose.yml up -d
```

## Development

### Project Structure

```
opencode-with-claude/
├── src/
│   ├── index.ts           # Plugin entry point
│   ├── proxy.ts           # Proxy lifecycle management
│   └── logger.ts          # Plugin logger
├── bin/
│   └── oc                 # Standalone launcher
├── docker/
│   ├── Dockerfile         # All-in-one Docker image
│   ├── docker-compose.yml # Docker Compose config
│   └── entrypoint.sh      # Docker entrypoint
├── install.sh             # curl | bash installer
├── test/
│   ├── run.sh             # Test runner
│   └── opencode.json      # Test config
├── package.json
└── tsconfig.json
```

### Build

```bash
npm install
npm run build
```

### Test locally

```bash
./test/run.sh              # Build and launch OpenCode with the plugin
./test/run.sh --clean      # Remove build artifacts
```

## FAQ

**Do I need an Anthropic API key?**

No. The proxy authenticates through your Claude Max subscription via `claude login`. The plugin automatically sets a dummy API key — it's never actually used for authentication.

**What happens if my Claude Max subscription expires?**

The proxy will fail to authenticate. Run `claude auth status` to check. You'll need an active Claude Max ($100/mo) or Claude Max with Team ($200/mo) subscription.

**Plugin, `oc`, or Docker — which should I use?**

The **plugin** is recommended if you already use OpenCode — it integrates with OpenCode's plugin system and requires no extra commands. Use the **`oc` launcher** if you want a one-command install from scratch or prefer not to edit config files. Use **Docker** if you want an isolated environment or want to run the web UI as a service.

**Can I use this with multiple projects at the same time?**

Yes. The first instance uses port 3456 by default. Additional instances automatically fall back to a random OS-assigned port, so they all work simultaneously without any extra configuration.

**Is this the same as using the Anthropic API?**

Not exactly. The proxy translates between the Anthropic REST API format and the Claude Agent SDK. From OpenCode's perspective it looks like the API, but under the hood it uses your Claude Max session. Rate limits are determined by your Claude Max subscription, not API tier limits.

**Why `claude login` instead of an API key?**

Claude Max doesn't provide API access. Authentication goes through the Claude Code CLI's OAuth flow, which grants an Agent SDK session token tied to your subscription.

## Disclaimer

This project is an **unofficial wrapper** around Anthropic's publicly available Claude Agent SDK and OpenCode. It is not affiliated with, endorsed by, or supported by Anthropic or OpenCode.

**Use at your own risk.** The authors make no claims regarding compliance with Anthropic's Terms of Service. It is your responsibility to review and comply with Anthropic's [Terms of Service](https://www.anthropic.com/terms) and [Authorized Usage Policy](https://www.anthropic.com/aup). Terms may change at any time.

This project calls publicly available npm packages using your own authenticated account. No API keys are intercepted, no authentication is bypassed, and no proprietary systems are reverse-engineered.

## Credits

Built on top of [opencode-claude-max-proxy](https://github.com/rynfar/opencode-claude-max-proxy) by [@rynfar](https://github.com/rynfar), which provides the core proxy that bridges the Anthropic Agent SDK to the standard API.

Powered by the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) by Anthropic and [OpenCode](https://opencode.ai).

## License

MIT
