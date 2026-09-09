import type { Plugin } from "@opencode-ai/plugin"
import { scrubOpencodeFingerprints } from "@rynfar/meridian-plugin-opencode-scrub"

import { createLogger } from "./logger"
import {
  loadMeridianConfig,
  summarizeMeridianConfig,
} from "./meridian-config"
import {
  checkProxyHealth,
  getProxyBaseURL,
  registerCleanup,
  startProxy,
} from "./proxy"

const MAX_HUMAN_MESSAGES = 4096
export const ClaudeMaxPlugin: Plugin = async ({ client }) => {
  const log = createLogger(client)
  const agentModes = new Map<string, string>()
  const humanMessages = new Map<string, true>()

  const messageKey = (sessionID: string, messageID: string) =>
    `${sessionID}\u0000${messageID}`

  const meridianConfig = loadMeridianConfig(log)
  const summary = summarizeMeridianConfig(meridianConfig)
  if (summary) void log("info", summary)

  const port = process.env.CLAUDE_PROXY_PORT || 3456
  const proxy = await startProxy({
    port,
    log,
    profiles: meridianConfig.profiles,
    defaultProfile: meridianConfig.defaultProfile,
  })

  const baseURL = getProxyBaseURL(proxy.port)
  void log("info", `proxy ready at ${baseURL}`)

  registerCleanup(proxy)

  // Deliberately not awaited: this only produces log lines, and /health can
  // take seconds when Meridian's auth cache is cold. Blocking OpenCode's
  // startup on it would trade real latency for a diagnostic.
  void checkProxyHealth(proxy.port, log)

  return {
    // Set the base URL for the Anthropic provider
    async config(input) {
      for (const [name, agent] of Object.entries(input.agent ?? {})) {
        if (!agent?.mode) continue
        agentModes.set(name.toLowerCase(), agent.mode)
      }

      const anthropic = input.provider?.anthropic
      if (!anthropic) return
      if (!anthropic.options) anthropic.options = {}
      anthropic.options.baseURL = baseURL
    },

    async "chat.message"(input, output) {
      const key = messageKey(input.sessionID, output.message.id)
      humanMessages.delete(key)
      humanMessages.set(key, true)
      if (humanMessages.size > MAX_HUMAN_MESSAGES) {
        const oldest = humanMessages.keys().next().value
        if (oldest !== undefined) humanMessages.delete(oldest)
      }
    },

    // Keep user context, but scrub OpenCode fingerprints before Meridian passthrough.
    async "experimental.chat.system.transform"(input, output) {
      if (input.model.providerID !== "anthropic") return
      const systemContext = output.system.join("\n\n")
      const scrubbed = scrubOpencodeFingerprints(systemContext)
      if (scrubbed !== systemContext) {
        output.system.splice(0, output.system.length, scrubbed)
      }
    },

    // Strip Anthropic beta flags and add headers Meridian uses for OpenCode sessions.
    async "chat.headers"(incoming, output) {
      if (incoming.model.providerID !== "anthropic") return
      delete output.headers["anthropic-beta"]

      // OpenCode types this as a string, but at runtime newer versions pass the
      // full agent object. Use .mode directly so subagents don't look primary.
      const agent = incoming.agent as unknown as
        | string
        | { name?: string; mode?: string }
      const hasAgentObject = typeof agent === "object" && agent !== null
      const rawAgentName = hasAgentObject ? agent.name : agent
      const agentName =
        String(rawAgentName ?? "unknown").replace(/[^\x20-\x7E]/g, "").trim() ||
        "unknown"
      const agentMode =
        hasAgentObject && typeof agent.mode === "string"
          ? agent.mode
          : agentModes.get(agentName.toLowerCase()) ?? "primary"

      // OpenCode's title generator runs on the *same* session id as the user's
      // first prompt, concurrently. Meridian serialises requests per session
      // (a turn lease) and rejects whichever one waited with "This session
      // advanced while the request was waiting" — about half the time that is
      // the user's prompt, so the first message of a fresh session fails.
      // Detach the title request: no session header means no lease, and the
      // subagent mode marks it as an independent flow.
      const isTitleRequest = agentName.toLowerCase() === "title"
      if (!isTitleRequest) {
        output.headers["x-opencode-session"] = incoming.sessionID
      }
      output.headers["x-opencode-request"] = incoming.message.id
      output.headers["x-opencode-request-kind"] = humanMessages.has(
        messageKey(incoming.sessionID, incoming.message.id),
      )
        ? "human"
        : "synthetic"
      output.headers["x-opencode-agent-mode"] = isTitleRequest
        ? "subagent"
        : agentMode
      output.headers["x-opencode-agent-name"] = agentName
    },
  }
}
