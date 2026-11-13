// Only inspect the V2 hook fields needed below; non-system messages stay intact.
// This adapter has no runtime dependency on OpenCode's SDK.
type ChronologicalMessage = {
  role: string
  content: Array<{
    type: string
    id?: string
    providerExecuted?: boolean
    text?: string
    cache?: unknown
  }>
}

/**
 * Meridian's OpenCode adapter resumes tool checkpoints from user messages.
 * Newer Claude models let OpenCode emit chronological `system` messages.
 * Meridian 1.82+ accepts one only as the final message after a complete tool
 * result batch, and delivers it as user text either way; an update anywhere
 * else (e.g. ahead of the user's next prompt) still breaks the resume, as does
 * any update on an older build loaded via `MERIDIAN_PATH`. Use OpenCode's
 * escaped, lower-authority fallback at the same position instead of losing
 * updates during SDK resume.
 */
export function normalizeSystemUpdates(messages: unknown[]): void {
  const history = messages as ChronologicalMessage[]
  const pending = new Set<string>()
  // Preflight the entire original request so invalid histories are never
  // partially rewritten before the protocol performs its own validation.
  for (const message of history) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (
          part.type === "tool-call" &&
          part.providerExecuted !== true &&
          typeof part.id === "string"
        ) {
          pending.add(part.id)
        }
      }
    } else if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type === "tool-result" && typeof part.id === "string") pending.delete(part.id)
      }
    } else if (message.role === "system") {
      // Leave invalid updates to OpenCode's own protocol validation: system
      // updates cannot split local tool calls from their results or carry media.
      if (
        pending.size > 0 ||
        message.content.some((part) => part.type !== "text" || typeof part.text !== "string")
      ) return
    }
  }
  for (const [index, message] of history.entries()) {
    if (message.role === "system") {
      const text = message.content
        .map((part) => part.text).join("\n")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
      // Match OpenCode's fallback: collapse text parts and keep the last cache
      // hint, not individual system-part metadata or provider-specific fields.
      const cache = message.content.at(-1)?.cache
      messages[index] = {
        ...message,
        role: "user",
        content: [{
          type: "text",
          text: `<system-update>\n${text}\n</system-update>`,
          ...(cache === undefined ? {} : { cache }),
        }],
      }
    }
  }
}
