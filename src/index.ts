import type { Plugin } from "@opencode-ai/plugin"
import { spawn, type ChildProcess } from "child_process"
import { createRequire } from "module"

const DEFAULT_PORT = 3456
const HEALTH_TIMEOUT_MS = 10_000
const HEALTH_INTERVAL_MS = 100

/**
 * Resolve the claude-max-proxy binary from this package's bundled dependency.
 */
function resolveProxyBin(): string {
  const require = createRequire(import.meta.url)
  const proxyPkgPath = require.resolve(
    "opencode-claude-max-proxy/package.json"
  )
  const proxyDir = proxyPkgPath.replace(/\/package\.json$/, "")
  const proxyPkg = require(proxyPkgPath)
  const binEntries = proxyPkg.bin
  if (!binEntries || typeof binEntries !== "object") {
    throw new Error(
      "Could not find claude-max-proxy binary in opencode-claude-max-proxy package"
    )
  }
  const binPath = Object.values(binEntries)[0] as string
  if (!binPath) {
    throw new Error("claude-max-proxy package has no bin entry")
  }
  return `${proxyDir}/${binPath}`
}

/**
 * Poll the proxy health endpoint until it responds OK or timeout.
 */
async function waitForHealth(
  port: number,
  timeoutMs: number,
  proxy: ChildProcess
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    // Check if proxy process died
    if (proxy.exitCode !== null) {
      throw new Error(
        "Claude Max proxy process exited unexpectedly. Is Claude authenticated? Run: claude login"
      )
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      if (res.ok) return
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS))
  }
  throw new Error(
    `Claude Max proxy didn't become healthy within ${timeoutMs / 1000}s. Check: claude auth status`
  )
}

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
  const log = (level: "debug" | "info" | "warn" | "error", message: string) =>
    client.app.log({
      body: { service: "opencode-with-claude", level, message },
    })

  // 1. Check claude CLI exists
  try {
    await $`which claude`
  } catch {
    throw new Error(
      "Claude Code CLI not found. Install it with: npm install -g @anthropic-ai/claude-code"
    )
  }

  // 2. Check authentication
  let authOutput: string
  try {
    authOutput = await $`claude auth status`.text()
  } catch {
    throw new Error(
      "Failed to check Claude auth status. Run: claude login"
    )
  }

  if (!authOutput.includes('"loggedIn": true')) {
    throw new Error("Claude not authenticated. Run: claude login")
  }

  await log("info", "Claude authentication verified")

  // 3. Resolve proxy binary (bundled dependency)
  let proxyBin: string
  try {
    proxyBin = resolveProxyBin()
  } catch (err) {
    throw new Error(
      `Failed to resolve claude-max-proxy binary: ${err instanceof Error ? err.message : err}`
    )
  }

  // 4. Pick port
  const port = parseInt(process.env.CLAUDE_PROXY_PORT || "", 10) || DEFAULT_PORT

  // 5. Spawn proxy
  await log("info", `Starting Claude Max proxy on port ${port}...`)

  const proxy: ChildProcess = spawn(proxyBin, [], {
    env: {
      ...process.env,
      CLAUDE_PROXY_PORT: String(port),
      CLAUDE_PROXY_PASSTHROUGH: "1",
      CLAUDE_PROXY_WORKDIR: directory,
    },
    stdio: "ignore",
    detached: false,
  })

  proxy.on("error", (err: Error) => {
    log("error", `Proxy process error: ${err.message}`)
  })

  // 6. Wait for health
  try {
    await waitForHealth(port, HEALTH_TIMEOUT_MS, proxy)
  } catch (err) {
    // Kill the proxy if health check fails
    try {
      proxy.kill()
    } catch {}
    throw err
  }

  await log("info", `Claude Max proxy ready on port ${port}`)

  // 7. Cleanup on exit
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    try {
      proxy.kill()
    } catch {}
  }
  process.on("exit", cleanup)
  process.on("SIGINT", cleanup)
  process.on("SIGTERM", cleanup)

  // No hooks needed -- proxy runs as a sidecar process.
  // Provider config in opencode.json routes API traffic through the proxy.
  return {}
}
