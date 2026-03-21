# opencode-with-claude

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Use [OpenCode](https://opencode.ai) with your [Claude Max](https://claude.ai) subscription — no API credits needed.

One command to install. One command to run.

## How It Works

```
┌─────────────┐       ┌──────────────────┐       ┌───────────────┐
│   OpenCode   │──────▶│  Claude Max Proxy │──────▶│   Claude Max   │
│   (TUI/Web)  │ :3456 │  (local server)   │  SDK  │  (your $100/mo │
│              │◀──────│                    │◀──────│   subscription)│
└─────────────┘       └──────────────────┘       └───────────────┘
```

[OpenCode](https://opencode.ai) speaks the Anthropic REST API. Claude Max provides access via the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) (not the REST API). The [opencode-claude-max-proxy](https://github.com/rynfar/opencode-claude-max-proxy) bridges the gap — it accepts API requests from OpenCode and translates them into Agent SDK calls using your Claude Max session.

## Quick Start

### One-liner install

```bash
curl -fsSL https://raw.githubusercontent.com/ianjwhite99/opencode-with-claude/main/install.sh | bash
```

This installs everything you need:
- [Claude Code CLI](https://www.npmjs.com/package/@anthropic-ai/claude-code) — authentication with Claude
- [OpenCode](https://www.npmjs.com/package/opencode-ai) — the coding assistant
- [opencode-claude-max-proxy](https://www.npmjs.com/package/opencode-claude-max-proxy) — bridges OpenCode to Claude Max
- **`oc`** — launcher that ties it all together

Then run:

```bash
cd your-project
oc
```

That's it. The `oc` command starts the proxy in the background, waits for it to be ready, and launches OpenCode.

## Prerequisites

- **Node.js >= 18** — [nodejs.org](https://nodejs.org)
- **Claude Max subscription** — the $100/mo plan on [claude.ai](https://claude.ai)
- **curl** — for proxy health checks (pre-installed on most systems)

### Supported Platforms

| Platform | Native | Docker |
|----------|--------|--------|
| macOS (Intel & Apple Silicon) | Yes | Yes |
| Linux (x86_64 & arm64) | Yes | Yes |
| Windows (WSL2) | Yes | Yes |

Windows requires [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install). Native Windows (cmd/PowerShell) is not supported.

## Install Methods

### Option 1: curl one-liner (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/ianjwhite99/opencode-with-claude/main/install.sh | bash
```

Installer options:

```bash
# Skip the Claude login prompt
curl -fsSL ... | bash -s -- --no-auth

# Don't modify shell PATH
curl -fsSL ... | bash -s -- --no-modify-path

# Show help
curl -fsSL ... | bash -s -- --help
```

### Option 2: git clone

```bash
git clone https://github.com/ianjwhite99/opencode-with-claude.git
cd opencode-with-claude
./bin/setup.sh
```

### Option 3: Docker

```bash
git clone https://github.com/ianjwhite99/opencode-with-claude.git
cd opencode-with-claude

# Build and start
docker compose up -d

# Authenticate (first time only)
docker exec -it -u opencode opencode-with-claude claude login

# Access web UI
open http://localhost:4096
```

### Option 4: Manual

Install the three components yourself:

```bash
npm install -g @anthropic-ai/claude-code opencode-ai opencode-claude-max-proxy

# Authenticate
claude login

# Clear any existing OpenCode Anthropic auth
opencode auth logout
```

Then either use the `oc` launcher from this repo, or start manually:

```bash
# Terminal 1: start the proxy
CLAUDE_PROXY_PASSTHROUGH=1 claude-max-proxy

# Terminal 2: start OpenCode pointed at the proxy
ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://127.0.0.1:3456 opencode
```

## Usage

### `oc` command

The `oc` launcher handles everything — starts the proxy, waits for health, launches OpenCode, and cleans up on exit:

```bash
oc              # Start OpenCode TUI in current directory
oc web          # Start OpenCode web UI on port 4096
oc --help       # Show help
oc --version    # Show component versions
```

All arguments are passed through to `opencode`, so anything that works with `opencode` works with `oc`.

### Docker

```bash
# Start the container
docker compose up -d

# Access the web UI
open http://localhost:4096

# Run claude commands inside the container
docker exec -it -u opencode opencode-with-claude claude login
docker exec -it -u opencode opencode-with-claude claude auth status

# Run opencode commands inside the container
docker exec -it -u opencode opencode-with-claude opencode auth list
```

## Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_PROXY_PORT` | random | Port for the proxy server |
| `CLAUDE_PROXY_WORKDIR` | `$PWD` | Working directory for the proxy |
| `OC_SKIP_AUTH_CHECK` | unset | Set to `1` to skip Claude auth check on launch |

### OpenCode config

The `oc` launcher sets `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` as environment variables, so no config file changes are needed.

If you prefer a config file (e.g., for running OpenCode without the `oc` launcher), copy the template:

```bash
cp config/opencode.json ~/.config/opencode/opencode.json
```

This sets OpenCode to use the proxy at `http://127.0.0.1:3456` with a dummy API key.

### Docker volumes

The Docker setup persists data across restarts:

| Volume | Path | Purpose |
|--------|------|---------|
| `opencode-data` | `~/.local/share/opencode` | OpenCode data |
| `opencode-state` | `~/.local/state/opencode` | OpenCode state |
| `opencode-cache` | `~/.cache/opencode` | OpenCode cache |
| `opencode-config` | `~/.config/opencode` | OpenCode config |
| `claude-auth` | `~/.claude` | Claude authentication |

Your workspace is mounted from `~/workspace` on the host.

## Troubleshooting

### "Claude not authenticated"

```bash
claude login
```

This opens a browser for OAuth. Your Claude Max subscription credentials are needed.

### "Proxy failed to start"

1. Check Claude auth: `claude auth status`
2. Try starting the proxy manually: `CLAUDE_PROXY_PASSTHROUGH=1 claude-max-proxy`
3. Check if the port is in use: `lsof -i :3456`

### "Proxy didn't become healthy within 10 seconds"

The proxy takes a moment to initialize. If this persists:
- Ensure `claude auth status` shows `loggedIn: true`
- Check your internet connection
- Try a specific port: `CLAUDE_PROXY_PORT=3456 oc`

### Port conflicts

The `oc` launcher uses a random available port by default. To use a fixed port:

```bash
CLAUDE_PROXY_PORT=3456 oc
```

### Updating components

```bash
npm update -g @anthropic-ai/claude-code opencode-ai opencode-claude-max-proxy
```

Or re-run the installer, which will update all components.

## Uninstalling

Remove the `oc` launcher and clean up PATH entries:

```bash
curl -fsSL https://raw.githubusercontent.com/ianjwhite99/opencode-with-claude/main/install.sh | bash -s -- --uninstall
```

This removes the `oc` launcher from `~/.opencode/bin` and cleans up any PATH entries added to your shell config. To also remove the underlying tools:

```bash
npm uninstall -g @anthropic-ai/claude-code opencode-ai opencode-claude-max-proxy
```

## Project Structure

```
opencode-with-claude/
├── install.sh           # curl | bash one-liner installer
├── README.md            # This file
├── Dockerfile           # All-in-one Docker image
├── docker-compose.yml   # Docker Compose config
├── config/
│   └── opencode.json    # OpenCode config template
└── bin/
    ├── oc               # Launcher: proxy + opencode in one command
    ├── setup.sh         # Git clone setup script
    ├── entrypoint.sh    # Docker entrypoint
    ├── claude           # Docker wrapper for claude CLI
    └── opencode         # Docker wrapper for opencode CLI
```

## FAQ

**Do I need an Anthropic API key?**

No. The proxy authenticates through your Claude Max subscription via `claude login`. The `ANTHROPIC_API_KEY=dummy` value is just a placeholder that OpenCode requires to be set — it's never actually used.

**What happens if my Claude Max subscription expires?**

The proxy will fail to authenticate. Run `claude auth status` to check. You'll need an active Claude Max ($100/mo) or Claude Max with Team ($200/mo) subscription.

**Can I use this with multiple projects at the same time?**

Yes. The `oc` launcher assigns a random port for each terminal session, so you can run multiple instances in different project directories simultaneously.

**Is this the same as using the Anthropic API?**

Not exactly. The proxy translates between the Anthropic REST API format and the Claude Agent SDK. From OpenCode's perspective it looks like the API, but under the hood it uses your Claude Max session. Rate limits are determined by your Claude Max subscription, not API tier limits.

**Why `claude login` instead of an API key?**

Claude Max doesn't provide API access. Authentication goes through the Claude Code CLI's OAuth flow, which grants an Agent SDK session token tied to your subscription.

## Disclaimer

This project is an **unofficial wrapper** around Anthropic's publicly available Claude Agent SDK and OpenCode. It is not affiliated with, endorsed by, or supported by Anthropic or OpenCode.

**Use at your own risk.** The authors make no claims regarding compliance with Anthropic's Terms of Service. It is your responsibility to review and comply with Anthropic's [Terms of Service](https://www.anthropic.com/terms) and [Authorized Usage Policy](https://www.anthropic.com/aup). Terms may change at any time.

This project calls publicly available npm packages using your own authenticated account. No API keys are intercepted, no authentication is bypassed, and no proprietary systems are reverse-engineered.

## Credits

Built on top of [opencode-claude-max-proxy](https://github.com/rynfar/opencode-claude-max-proxy) by [@rynfar](https://github.com/rynfar), which provides the core proxy that bridges the Anthropic Agent SDK to the standard API. This project wraps that proxy with a streamlined installer and launcher to make setup as easy as possible.

Powered by the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) by Anthropic and [OpenCode](https://opencode.ai).

## License

MIT
