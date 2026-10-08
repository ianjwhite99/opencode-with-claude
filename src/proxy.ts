import type { AddressInfo } from "net"
import { classifyProxyLog, type LogFn } from "./logger.ts"
import type { ProfileConfig } from "./meridian-config.ts"
import {
  describeMeridianSource,
  loadMeridian,
  type StartProxyServer,
} from "./meridian-source.ts"

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

  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
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

export async function startProxy(
  opts: StartProxyOptions
): Promise<ProxyHandle> {
  // Embedded mode executes tools in OpenCode. An external service configures
  // passthrough itself and must not change its environment on module import.
  process.env.MERIDIAN_PASSTHROUGH ??= "true"
  const { port = DEFAULT_PORT, log, profiles, defaultProfile } = opts
  const host = getProxyHost()
  const meridian = await loadMeridian(log)
  const { startProxyServer, version } = meridian

  // The plugin embeds Meridian, so this line is the only place a user (or a
  // bug report) can see which build is actually running.
  void log?.("info", describeMeridianSource(meridian))

  const origError = console.error
  console.error = (...args: unknown[]) => {
    const msg = args.map(String).join(" ")
    if (msg.startsWith("[PROXY]")) {
      void log?.(classifyProxyLog(msg as string), msg)
      return
    }
    origError.apply(console, args)
  }

  const tryStart = (p: number) =>
    new Promise<Awaited<ReturnType<StartProxyServer>>>((resolve, reject) => {
      startProxyServer({
        port: p,
        host,
        silent: true,
        profiles,
        defaultProfile,
        version,
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
    })

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

  let proxy: Awaited<ReturnType<StartProxyServer>>
  try {
    proxy = await attempt(typeof port === "string" ? parseInt(port, 10) : port)
  } catch (err) {
    console.error = origError
    throw err
  }

  const addr = proxy.server.address() as AddressInfo | null
  const actualPort = addr?.port ?? proxy.config?.port ?? DEFAULT_PORT

  void log?.("info", `Claude Max proxy running on port ${actualPort}`)

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
  /** Meridian version behind the proxy. Absent on releases that omit it. */
  version?: string
  /** Days until the Claude login itself expires, when Meridian reports it. */
  daysUntilRenewal?: number
  /** True when Meridian flags the login as needing renewal soon. */
  renewalRequiredSoon?: boolean
}

type RenewalFields = Pick<
  HealthResult,
  "daysUntilRenewal" | "renewalRequiredSoon"
>

/**
 * Read the login-renewal fields Meridian added to /health in 1.58.0. Older
 * releases omit them, so every field is optional and an absent field means
 * "unknown" — never "expiring".
 */
function readRenewal(auth: unknown): RenewalFields {
  if (typeof auth !== "object" || auth === null) return {}
  const record = auth as Record<string, unknown>
  const out: RenewalFields = {}
  if (
    typeof record.daysUntilRenewal === "number" &&
    Number.isFinite(record.daysUntilRenewal)
  ) {
    out.daysUntilRenewal = record.daysUntilRenewal
  }
  if (typeof record.renewalRequiredSoon === "boolean") {
    out.renewalRequiredSoon = record.renewalRequiredSoon
  }
  return out
}

/**
 * Phrase the remaining login window. Meridian ceils the day count to match
 * Claude Code's own "your login expires in N days" warning, so the number
 * here reads identically to the one the terminal prints.
 */
function describeRenewalWindow(days: number | undefined): string {
  if (days === undefined) return "soon"
  if (days <= 0) return "today"
  if (days === 1) return "in 1 day"
  return `in ${days} days`
}

/**
 * Meridian's first /health probes the Claude login, which takes ~5s on a cold
 * auth cache (subsequent calls answer in tens of milliseconds). A tighter
 * budget than that reports "Health check failed" against a proxy that is in
 * fact healthy — the one startup line a user is most likely to take for a real
 * fault. Nothing awaits this check, so the extra headroom costs no latency.
 */
const HEALTH_TIMEOUT_MS = 15_000

export async function checkProxyHealth(
  port: string | number,
  log: LogFn | undefined
): Promise<HealthResult> {
  try {
    const res = await fetch(getProxyBaseURL(port) + "/health", {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })
    const body = (await res.json()) as Record<string, unknown>
    // Meridian answers with the literal string "unknown" when it has no
    // version to report, which carries no information worth logging.
    const reported = body.version
    const version =
      typeof reported === "string" && reported !== "unknown"
        ? reported
        : undefined
    const renewal = readRenewal(body.auth)

    // The plugin embeds Meridian as a library, so nothing else tells a user
    // which build is actually running when they file a bug report.
    if (version) void log?.("info", `[claude-max] meridian ${version}`)

    // A dead refresh token is the one auth failure nothing automated
    // recovers from, and it is knowable days ahead. OpenCode users never see
    // Meridian's dashboard, so this is their only notice.
    if (renewal.renewalRequiredSoon) {
      void log?.(
        "warn",
        `[claude-max] Claude login expires ${describeRenewalWindow(renewal.daysUntilRenewal)}. Run 'claude login' to renew — the proxy cannot refresh it for you.`
      )
    }

    if (body.status === "healthy") return { ok: true, version, ...renewal }

    if (body.status === "degraded") {
      const detail =
        typeof body.error === "string"
          ? body.error
          : "Could not verify auth status"
      void log?.(
        "warn",
        `[claude-max] ${detail}. Requests may still work — if they hang, try running 'claude login' in your terminal.`
      )
      return { ok: true, message: detail, version, ...renewal }
    }

    // "unhealthy" or unexpected status
    const detail =
      typeof body.error === "string"
        ? body.error
        : `Proxy health check returned status: ${body.status ?? res.status}`

    void log?.("error", `[claude-max] ${detail}`)
    return { ok: false, message: detail, version, ...renewal }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    void log?.("error", `[claude-max] Health check failed: ${msg}`)
    return { ok: false, message: `Health check failed: ${msg}` }
  }
}

// ---------------------------------------------------------------------------
// Process cleanup
// ---------------------------------------------------------------------------

export function registerCleanup(proxy: ProxyHandle): () => void {
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

  return () => {
    process.removeListener("exit", cleanup)
    process.removeListener("SIGINT", cleanup)
    if (!IS_WINDOWS) process.removeListener("SIGTERM", cleanup)
  }
}
