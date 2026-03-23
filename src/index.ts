import type { Plugin } from "@opencode-ai/plugin"

import { createLogger } from "./logger.js"
import { registerCleanup, startProxy } from "./proxy.js"

const DEFAULT_PORT = 3456

/**
 * OpenCode plugin that manages the Claude Max proxy lifecycle.
 *
 * On init:
 *  1. Verifies the Claude CLI is installed and authenticated
 *  2. Starts the proxy on a local port via the programmatic API
 *  3. Registers cleanup handlers to stop the proxy on exit
 *
 * Requires provider config in opencode.json to route API traffic through the proxy:
 *   "provider": { "anthropic": { "options": { "baseURL": "http://127.0.0.1:3456", "apiKey": "dummy" } } }
 */
export const ClaudeMaxPlugin: Plugin = async ({ client, $, directory }) => {
  const log = createLogger(client)

  // 1. Verify Claude CLI is installed
  try {
    await $`claude --version`
  } catch {
    throw new Error(
      "Claude Code CLI not found. Install it with: npm install -g @anthropic-ai/claude-code"
    )
  }

  // 2. Verify authentication
  let authOutput: string
  try {
    authOutput = await $`claude auth status`.text()
  } catch {
    throw new Error("Failed to check Claude auth status. Run: claude login")
  }

  if (!authOutput.includes('"loggedIn": true')) {
    throw new Error("Claude not authenticated. Run: claude login")
  }

  await log("info", "Claude authentication verified")

  // 3. Determine port
  const port =
    parseInt(process.env.CLAUDE_PROXY_PORT || "", 10) || DEFAULT_PORT

  // 4. Start the proxy
  await log("info", `Starting Claude Max proxy on port ${port}...`)

  const proxy = await startProxy({ port, log })

  await log("info", `Claude Max proxy ready on port ${proxy.config.port}`)

  // 5. Register cleanup handlers
  registerCleanup(proxy)

  return {}
}
