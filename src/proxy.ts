import type { AddressInfo } from "net"
import type { LogFn } from "./logger.js"
import { startProxyServer } from "opencode-claude-max-proxy"

const IS_WINDOWS = process.platform === "win32"

// ---------------------------------------------------------------------------
// Proxy lifecycle
// ---------------------------------------------------------------------------

export interface StartProxyOptions {
  port?: number
  log: LogFn
}

export interface ProxyHandle {
  port: number
  close(): Promise<void>
}

const DEFAULT_PORT = 3456

export async function startProxy(opts: StartProxyOptions): Promise<ProxyHandle> {
  const { port = DEFAULT_PORT, log } = opts

  const origError = console.error
  console.error = (...args: unknown[]) => {
    const msg = args.map(String).join(" ")
    if (msg.startsWith("[PROXY]")) {
      void log("debug", msg)
      return
    }
    origError.apply(console, args)
  }

  const attempt = async (p: number) => {
    try {
      return await startProxyServer({
        port: p,
        host: "127.0.0.1",
        silent: true,
      })
    } catch (err) {
      if (
        p !== 0 &&
        err instanceof Error &&
        "code" in err &&
        err.code === "EADDRINUSE"
      ) {
        await log(
          "info",
          `Port ${p} in use, starting on a random port instead...`
        )
        return startProxyServer({
          port: 0,
          host: "127.0.0.1",
          silent: true,
        })
      }
      throw err
    }
  }

  let proxy: Awaited<ReturnType<typeof startProxyServer>>
  try {
    proxy = await attempt(port)
  } catch (err) {
    console.error = origError
    throw err
  }

  const addr = proxy.server.address() as AddressInfo
  const actualPort = addr.port

  await log("info", `Claude Max proxy running on port ${actualPort}`)

  return {
    port: actualPort,
    close: async () => {
      console.error = origError
      await proxy.close()
    },
  }
}

// ---------------------------------------------------------------------------
// Process cleanup
// ---------------------------------------------------------------------------

export function registerCleanup(proxy: ProxyHandle): void {
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
