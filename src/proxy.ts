import { startProxyServer } from "opencode-claude-max-proxy"
import type { LogFn } from "./logger.js"

const IS_WINDOWS = process.platform === "win32"

// ---------------------------------------------------------------------------
// Proxy lifecycle
// ---------------------------------------------------------------------------

export interface StartProxyOptions {
  port: number
  log: LogFn
}

/**
 * Start the Claude Max proxy using the programmatic API.
 *
 * Returns the ProxyInstance which exposes `close()` for graceful shutdown.
 */
export async function startProxy(opts: StartProxyOptions) {
  const { port, log } = opts

  const proxy = await startProxyServer({
    port,
    host: "127.0.0.1",
    silent: true,
  })

  await log("info", `Claude Max proxy running on port ${proxy.config.port}`)

  return proxy
}

// ---------------------------------------------------------------------------
// Process cleanup
// ---------------------------------------------------------------------------

/**
 * Register cross-platform cleanup handlers that stop the proxy on exit.
 *
 * - `exit` and `SIGINT` work on all platforms.
 * - `SIGTERM` is only available on POSIX systems.
 */
export function registerCleanup(
  proxy: Awaited<ReturnType<typeof startProxy>>
): void {
  let cleaned = false

  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    void proxy.close()
  }

  process.on("exit", cleanup)
  process.on("SIGINT", cleanup)

  if (!IS_WINDOWS) {
    process.on("SIGTERM", cleanup)
  }
}
