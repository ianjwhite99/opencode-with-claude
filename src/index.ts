import type { Plugin } from "@opencode-ai/plugin"

import { createLogger } from "./logger.js"
import { registerCleanup, startProxy } from "./proxy.js"

/**
 * OpenCode plugin that manages the Claude Max proxy lifecycle.
 *
 * On init:
 *  1. Verifies the Claude CLI is installed and authenticated
 *  2. Starts the proxy (port 3456, or falls back to a random port if in use)
 *  3. Registers cleanup handlers to stop the proxy on exit
 *  4. Returns a `config` hook that injects the proxy's baseURL into
 *     the Anthropic provider so each opencode instance gets its own proxy.
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

  // 3. Start the proxy
  const port =
    parseInt(process.env.CLAUDE_PROXY_PORT || "", 10) || undefined
  await log("info", "Starting Claude Max proxy...")

  const proxy = await startProxy({ port, log })

  const baseURL = `http://127.0.0.1:${proxy.port}`
  await log("info", `Claude Max proxy ready at ${baseURL}`)

  // 4. Register cleanup handlers
  registerCleanup(proxy)

  // 5. Configure the Anthropic provider to route through the proxy
  return {
    async config(input) {
      input.provider ??= {}
      input.provider.anthropic ??= {}
      input.provider.anthropic.options ??= {}
      input.provider.anthropic.options.baseURL = baseURL
      input.provider.anthropic.options.apiKey = "claude-max-proxy"
    },
  }
}
