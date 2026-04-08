# opencode-with-claude

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Use [OpenCode](https://opencode.ai) with your [Claude Max](https://claude.ai) subscription.

## What this is

An [OpenCode](https://opencode.ai) plugin that runs [Meridian](https://github.com/rynfar/meridian) *(formerly opencode-claude-max-proxy)* for you: **start OpenCode once** and the proxy comes up with it; **quit OpenCode** and the proxy stops. No separate proxy CLI or Docker container to manage.

**Compared to running the proxy yourself:**

- **One process to think about** — OpenCode owns the proxy lifecycle (start/stop) instead of you juggling two things.
- **Several OpenCode windows at once** — each instance gets its own proxy on an OS-assigned port, so ports do not collide and you avoid session issues from sharing one proxy across instances.
- **Explicit session headers** — the plugin adds session tracking on outgoing API calls, so the proxy does not have to infer sessions from fingerprints alone.

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

**1. Install the plugin**

```bash
npm install -g opencode-with-claude
```

**2. Authenticate with Claude (one-time)**

```bash
npm install -g @anthropic-ai/claude-code
claude login
```

**3. Add to your `opencode.json`**

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

No. Claude Max is not authenticated with API keys here. Run `claude login` once; the proxy uses that session (Agent SDK via OAuth). OpenCode still expects an `apiKey` field, so the plugin supplies a placeholder — it is not used for real auth.

**What if my Claude Max subscription lapses?**

The proxy will fail to authenticate. Run `claude auth status`. You need an active Claude Max plan; see [claude.ai](https://claude.ai) for current options and pricing.

**Can I run several OpenCode instances at once?**

Yes. The first instance uses port **3456** by default; others get a free OS-assigned port, so nothing extra to configure.

**Is this the same as using the Anthropic API directly?**

Not exactly. OpenCode speaks Anthropic-style HTTP to the local proxy; the proxy maps requests to the Claude Agent SDK and your Claude Max session. Usage limits follow your Max subscription, not Anthropic API billing tiers.

## Disclaimer

This project is an **unofficial wrapper** around Anthropic's publicly available Claude Agent SDK and OpenCode. It is not affiliated with, endorsed by, or supported by Anthropic or OpenCode.

**Use at your own risk.** The authors make no claims regarding compliance with Anthropic's Terms of Service. It is your responsibility to review and comply with Anthropic's [Terms of Service](https://www.anthropic.com/terms) and [Authorized Usage Policy](https://www.anthropic.com/aup). Terms may change at any time.

This project calls publicly available npm packages using your own authenticated account. No API keys are intercepted, no authentication is bypassed, and no proprietary systems are reverse-engineered.

## Credits

Built on top of [Meridian](https://github.com/rynfar/meridian) by [@rynfar](https://github.com/rynfar), which provides the core proxy that bridges the Anthropic Agent SDK to the standard API.

Powered by the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) by Anthropic and [OpenCode](https://opencode.ai).

## License

MIT
