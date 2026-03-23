import type { Plugin } from "@opencode-ai/plugin"

export type LogLevel = "debug" | "info" | "warn" | "error"
export type LogFn = (level: LogLevel, message: string) => Promise<unknown>

/**
 * Create a logger bound to the plugin's client.
 */
export function createLogger(
  client: Parameters<Plugin>[0]["client"]
): LogFn {
  return (level, message) =>
    client.app.log({
      body: { service: "opencode-with-claude", level, message },
    })
}
