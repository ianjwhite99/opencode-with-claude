import { spawn, type ChildProcess } from "child_process"
import { createRequire } from "module"
import path from "path"

import { pipeStreamToLog, type LogFn } from "./logger.js"

const IS_WINDOWS = process.platform === "win32"
const HEALTH_INTERVAL_MS = 100

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the claude-max-proxy binary from this package's bundled dependency.
 */
export function resolveProxyBin(): string {
  const require = createRequire(import.meta.url)
  const proxyPkgPath = require.resolve(
    "opencode-claude-max-proxy/package.json"
  )
  const proxyDir = path.dirname(proxyPkgPath)
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

  return path.join(proxyDir, binPath)
}

/**
 * Determine the spawn command + args for a given proxy binary path.
 *
 * - `.js` / `.cjs` / `.mjs` files are run via the current Node process.
 * - `.cmd` / `.bat` files (Windows) are run with `shell: true`.
 * - Everything else is spawned directly.
 */
function resolveProxyCommand(proxyBin: string): {
  command: string
  args: string[]
  shell: boolean
} {
  const ext = path.extname(proxyBin).toLowerCase()

  if (ext === ".js" || ext === ".cjs" || ext === ".mjs") {
    return { command: process.execPath, args: [proxyBin], shell: false }
  }

  if (IS_WINDOWS && (ext === ".cmd" || ext === ".bat")) {
    return { command: proxyBin, args: [], shell: true }
  }

  return { command: proxyBin, args: [], shell: false }
}

// ---------------------------------------------------------------------------
// Spawn & lifecycle
// ---------------------------------------------------------------------------

export interface SpawnProxyOptions {
  proxyBin: string
  cwd: string
  port: number
  sessionDir: string
  log: LogFn
}

/**
 * Spawn the proxy process and wire up logging + event handlers.
 */
export function spawnProxy(opts: SpawnProxyOptions): ChildProcess {
  const { proxyBin, cwd, port, sessionDir, log } = opts
  const { command, args, shell } = resolveProxyCommand(proxyBin)

  const proxy = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      CLAUDE_PROXY_PORT: String(port),
      CLAUDE_PROXY_PASSTHROUGH: "1",
      CLAUDE_PROXY_SESSION_DIR: sessionDir,
      CLAUDE_PROXY_WORKDIR: cwd,
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell,
    detached: false,
  })

  pipeStreamToLog(proxy.stdout, "info", log)
  pipeStreamToLog(proxy.stderr, "error", log)

  proxy.on("error", (err: Error) => {
    void log("error", `Proxy process error: ${err.message}`)
  })

  proxy.on("exit", (code, signal) => {
    void log(
      code === 0 ? "info" : "warn",
      `Proxy exited (code=${code ?? "null"}, signal=${signal ?? "null"})`
    )
  })

  return proxy
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

/**
 * Poll the proxy health endpoint until it responds OK or timeout.
 */
export async function waitForHealth(
  port: number,
  timeoutMs: number,
  proxy: ChildProcess
): Promise<void> {
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
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

// ---------------------------------------------------------------------------
// Process cleanup
// ---------------------------------------------------------------------------

/**
 * Kill a child process safely, suppressing errors if already dead.
 */
export function killProxy(proxy: ChildProcess): void {
  try {
    proxy.kill()
  } catch {
    // Already exited
  }
}

/**
 * Register cross-platform cleanup handlers that kill the proxy on exit.
 *
 * - `exit` and `SIGINT` work on all platforms.
 * - `SIGTERM` is only available on POSIX systems.
 */
export function registerCleanup(proxy: ChildProcess): void {
  let cleaned = false

  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    killProxy(proxy)
  }

  process.on("exit", cleanup)
  process.on("SIGINT", cleanup)

  if (!IS_WINDOWS) {
    process.on("SIGTERM", cleanup)
  }
}
