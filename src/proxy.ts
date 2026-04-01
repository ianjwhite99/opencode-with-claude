import type { AddressInfo } from "net"
import type { LogFn, LogLevel } from "./logger"
import { applyMeridian203Patch } from "./patches/meridian-203"

// Patch the SDK's Bun detection before importing meridian.
// Remove this block once meridian passes executable: "node" upstream.
applyMeridian203Patch()
const { startProxyServer } = await import("@rynfar/meridian")

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

const ERROR_PATTERNS =
  /authenticat|credentials|expired|not logged in|exit(?:ed)? with code|crash|unhealthy|401|402|billing|subscription/i
const WARN_PATTERNS =
  /rate.limit|429|overloaded|503|stale.session|timeout|timed out/i

function classifyProxyLog(msg: string): LogLevel {
  if (ERROR_PATTERNS.test(msg)) return "error"
  if (WARN_PATTERNS.test(msg)) return "warn"
  return "debug"
}

export async function startProxy(opts: StartProxyOptions): Promise<ProxyHandle> {
  const { port = DEFAULT_PORT, log } = opts

  const origError = console.error
  console.error = (...args: unknown[]) => {
    const msg = args.map(String).join(" ")
    if (msg.startsWith("[PROXY]")) {
      void log(classifyProxyLog(msg), msg)
      return
    }
    origError.apply(console, args)
  }

  const tryStart = (p: number) =>
    new Promise<Awaited<ReturnType<typeof startProxyServer>>>(
      (resolve, reject) => {
        startProxyServer({
          port: p,
          host: "127.0.0.1",
          silent: true,
        }).then((proxy) => {
          // EADDRINUSE is emitted asynchronously on the server – the
          // promise from startProxyServer resolves before the error
          // fires.  We must listen for it explicitly.
          const onError = (err: NodeJS.ErrnoException) => {
            reject(err)
          }
          proxy.server.once("error", onError)

          // If the server is already listening (address() is set),
          // we're good.  Otherwise wait for the "listening" event.
          if (proxy.server.listening) {
            proxy.server.removeListener("error", onError)
            resolve(proxy)
          } else {
            proxy.server.once("listening", () => {
              proxy.server.removeListener("error", onError)
              resolve(proxy)
            })
          }
        }, reject)
      }
    )

  const attempt = async (p: number) => {
    try {
      return await tryStart(p)
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
        return tryStart(0)
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

  const addr = proxy.server.address() as AddressInfo | null
  const actualPort = addr?.port ?? proxy.config?.port ?? DEFAULT_PORT

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
// Health check
// ---------------------------------------------------------------------------

export interface HealthResult {
  ok: boolean
  message?: string
}

export async function checkProxyHealth(
  port: number,
  log: LogFn
): Promise<HealthResult> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(5_000),
    })
    const body = await res.json() as Record<string, unknown>

    if (body.status === "healthy") return { ok: true }

    if (body.status === "degraded") {
      const detail =
        typeof body.error === "string"
          ? body.error
          : "Could not verify auth status"
      await log(
        "warn",
        `[claude-max] ${detail}. Requests may still work — if they hang, try running 'claude login' in your terminal.`
      )
      return { ok: true, message: detail }
    }

    // "unhealthy" or unexpected status
    const detail =
      typeof body.error === "string"
        ? body.error
        : `Proxy health check returned status: ${body.status ?? res.status}`

    await log("error", `[claude-max] ${detail}`)
    return { ok: false, message: detail }
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : String(err)
    await log("error", `[claude-max] Health check failed: ${msg}`)
    return { ok: false, message: `Health check failed: ${msg}` }
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
