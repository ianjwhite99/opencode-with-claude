# opencode-with-claude

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Use [OpenCode](https://opencode.ai) with your [Claude Max](https://claude.ai) subscription.

## Why?

This is a wrapper on top of [opencode-claude-max-proxy](https://github.com/rynfar/opencode-claude-max-proxy) with a key difference: instead of requiring you to start the proxy manually via the CLI or Docker, the OpenCode plugin manages the proxy lifecycle automatically. It spins up a dedicated proxy instance when OpenCode starts and tears it down on exit.

Each OpenCode instance gets its own proxy on an OS-assigned port, which means multiple instances can run simultaneously without conflicts — and without hitting concurrent session timeouts that occur when all requests are funneled through a single proxy. The plugin also injects session tracking headers directly into API requests, so the proxy doesn't need to rely on fingerprint-based session matching.

## How It Works

```
┌─────────────┐              ┌────────────────────┐       ┌─────────────────┐
│  OpenCode   │─────────────▶│  Claude Max Proxy  │──────▶│    Anthropic    │
│  (TUI/Web)  │ :3456 / auto │   (local server)   │  SDK  │    Claude Max   │
│             │◀─────────────│                    │◀──────│                 │
└─────────────┘              └────────────────────┘       └─────────────────┘
```

## Quick Start

The plugin hooks into OpenCode's plugin system. When OpenCode launches, it starts the proxy, configures the Anthropic provider, and cleans everything up on exit.

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

> **Note:** The `apiKey` is a placeholder — authentication goes through your Claude Max session via `claude login`, not an API key. The `baseURL` is the default proxy port. If port 3456 is already in use (e.g., another OpenCode instance), the plugin automatically starts the proxy on a different port and overrides the `baseURL` at runtime.

**3. Run OpenCode**

```bash
opencode
```

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

## Development

### Project Structure

```
opencode-with-claude/
├── src/
│   ├── index.ts           # Plugin entry point
│   ├── proxy.ts           # Proxy lifecycle management
│   └── logger.ts          # Plugin logger
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
