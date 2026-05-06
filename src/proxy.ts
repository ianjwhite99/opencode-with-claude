import type { AddressInfo } from "net"
import { repairClaudeCodeLauncher } from "./claude-launcher.ts"
import { classifyProxyLog, type LogFn } from "./logger.ts"
import type { ProfileConfig } from "./meridian-config.ts"
import { startProxyServer } from "@rynfar/meridian"

// Enable passthrough mode so the proxy returns tool_use blocks to OpenCode
// for execution, rather than running them internally. Without this, tool
// calls are filtered from the response stream and never shown in the TUI.
process.env.MERIDIAN_PASSTHROUGH ??= "true"

const IS_WINDOWS = process.platform === "win32"

// ---------------------------------------------------------------------------
// Proxy lifecycle
// ---------------------------------------------------------------------------

export interface StartProxyOptions {
  port?: string | number
  log: LogFn | undefined
  /** Named auth profiles forwarded to Meridian's ProxyConfig. */
  profiles?: ProfileConfig[]
  /** Default profile id when no x-meridian-profile header is sent. */
  defaultProfile?: string
}

export interface ProxyHandle {
  port: string | number
  close(): Promise<void>
}

const DEFAULT_PORT = 3456
const DEFAULT_HOST = "127.0.0.1"

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
}

export function getProxyHost(): string {
  const host =
    process.env.MERIDIAN_HOST?.trim() ||
    process.env.CLAUDE_PROXY_HOST?.trim() ||
    DEFAULT_HOST

  return host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host
}

export function getProxyConnectHost(host = getProxyHost()): string {
  // Wildcard bind addresses are not stable dial targets, so keep in-process
  // traffic on loopback unless the user picked a concrete host.
  if (host === "0.0.0.0") return DEFAULT_HOST
  if (host === "::" || host === "[::]") return "::1"
  return host
}

export function getProxyBaseURL(
  port: string | number,
  host = getProxyHost()
): string {
  return `http://${formatHostForUrl(getProxyConnectHost(host))}:${port}`
}

export async function startProxy(opts: StartProxyOptions): Promise<ProxyHandle> {
  const { port = DEFAULT_PORT, log, profiles, defaultProfile } = opts
  const host = getProxyHost()

  const origError = console.error
  console.error = (...args: unknown[]) => {
    const msg = args.map(String).join(" ")
    if (msg.startsWith("[PROXY]")) {
      void log?.(classifyProxyLog(msg as string), msg)
      return
    }
    origError.apply(console, args)
  }

  repairClaudeCodeLauncher(log)

  const tryStart = (p: number) =>
    new Promise<Awaited<ReturnType<typeof startProxyServer>>>(
      (resolve, reject) => {
        startProxyServer({
          port: p,
          host,
          silent: true,
          profiles,
          defaultProfile,
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
        void log?.(
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
    proxy = await attempt(typeof port === "string" ? parseInt(port, 10) : port)
  } catch (err) {
    console.error = origError
    throw err
  }

  const addr = proxy.server.address() as AddressInfo | null
  const actualPort = addr?.port ?? proxy.config?.port ?? DEFAULT_PORT

  void log?.( "info", `Claude Max proxy running on port ${actualPort}`)

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
  port: string | number,
  log: LogFn | undefined
): Promise<HealthResult> {
  try {
    const res = await fetch(getProxyBaseURL(port) + "/health", {
      signal: AbortSignal.timeout(5_000),
    })
    const body = await res.json() as Record<string, unknown>

    if (body.status === "healthy") return { ok: true }

    if (body.status === "degraded") {
      const detail =
        typeof body.error === "string"
          ? body.error
          : "Could not verify auth status"
      void log?.(
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

    void log?.( "error", `[claude-max] ${detail}`)
    return { ok: false, message: detail }
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : String(err)
    void log?.( "error", `[claude-max] Health check failed: ${msg}`)
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
