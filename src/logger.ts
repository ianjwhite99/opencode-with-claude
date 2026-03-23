import type { Plugin } from "@opencode-ai/plugin"
import type { Readable } from "stream"

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

/**
 * Pipe a child-process stream into the plugin logger, line-by-line.
 */
export function pipeStreamToLog(
  stream: Readable | null,
  level: LogLevel,
  log: LogFn
): void {
  if (!stream) return

  stream.setEncoding("utf8")

  let buffer = ""

  stream.on("data", (chunk: string) => {
    buffer += chunk
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ""

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed) void log(level, `[proxy] ${trimmed}`)
    }
  })

  stream.on("end", () => {
    const trimmed = buffer.trim()
    if (trimmed) void log(level, `[proxy] ${trimmed}`)
  })
}
