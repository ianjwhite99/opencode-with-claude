import type { Plugin } from "@opencode-ai/plugin"
import { createHash } from "crypto"
import { tmpdir } from "os"
import path from "path"

import { createLogger } from "./logger.js"
import {
  killProxy,
  registerCleanup,
  resolveProxyBin,
  spawnProxy,
  waitForHealth,
} from "./proxy.js"

const DEFAULT_PORT = 3456
const HEALTH_TIMEOUT_MS = 10_000

/**
 * OpenCode plugin that manages the Claude Max proxy lifecycle.
 *
 * On init:
 *  1. Verifies the Claude CLI is installed and authenticated
 *  2. Resolves the bundled claude-max-proxy binary
 *  3. Spawns the proxy on a local port
 *  4. Waits for the proxy to become healthy
 *  5. Registers cleanup handlers to kill the proxy on exit
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

  // 3. Resolve proxy binary
  let proxyBin: string
  try {
    proxyBin = resolveProxyBin()
  } catch (err) {
    throw new Error(
      `Failed to resolve claude-max-proxy binary: ${err instanceof Error ? err.message : err}`
    )
  }

  // 4. Determine port & session directory
  const port =
    parseInt(process.env.CLAUDE_PROXY_PORT || "", 10) || DEFAULT_PORT

  const sessionScope = createHash("sha256")
    .update(directory)
    .digest("hex")
    .slice(0, 16)

  const sessionDir = path.join(
    tmpdir(),
    "opencode-with-claude",
    `proxy-sessions-${sessionScope}`
  )

  // 5. Spawn the proxy
  await log("info", `Starting Claude Max proxy on port ${port}...`)
  await log("info", `Session directory: ${sessionDir}`)

  const proxy = spawnProxy({
    proxyBin,
    cwd: directory,
    port,
    sessionDir,
    log,
  })

  // 6. Wait for the proxy to become healthy
  try {
    await waitForHealth(port, HEALTH_TIMEOUT_MS, proxy)
  } catch (err) {
    killProxy(proxy)
    throw err
  }

  await log("info", `Claude Max proxy ready on port ${port}`)

  // 7. Register cleanup handlers
  registerCleanup(proxy)

  return {}
}
