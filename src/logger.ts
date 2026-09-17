import type { Plugin } from "@opencode-ai/plugin"

export type LogLevel = "debug" | "info" | "warn" | "error"
export type LogFn = (level: LogLevel, message: string) => Promise<unknown>

const ERROR_PATTERNS =
  /authenticat|credentials|expired|not logged in|exit(?:ed)? with code|crash|unhealthy|401|402|billing|subscription/i
const WARN_PATTERNS =
  /rate.limit|429|overloaded|503|stale.session|timeout|timed out/i

/**
 * Create a logger bound to the plugin's client (OpenCode v1).
 */
export function createLogger(
  client: Parameters<Plugin>[0]["client"]
): LogFn {
  return (level, message) =>
    client.app.log({
      body: { service: "opencode-with-claude", level, message },
    })
}

/**
 * Create a logger for hosts without a log API (OpenCode v2 gives plugins no
 * `client.app.log`). Lines go to stderr, which OpenCode v2 captures into its
 * own log stream; debug lines are dropped so the proxy's per-request chatter
 * does not flood it.
 */
export function createConsoleLogger(): LogFn {
  return async (level, message) => {
    if (level === "debug") return
    console.error(`[opencode-with-claude] ${level}: ${message}`)
  }
}

/**
 * Classify a proxy log message into a log level.
 */
export function classifyProxyLog(msg: string): LogLevel {
  if (ERROR_PATTERNS.test(msg)) return "error"
  if (WARN_PATTERNS.test(msg)) return "warn"
  return "debug"
}
