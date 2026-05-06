import type { Plugin } from "@opencode-ai/plugin"

import { createLogger } from "./logger"
import {
  ensureOpenCodeClientPromptPassthrough,
  loadMeridianConfig,
  summarizeMeridianConfig,
} from "./meridian-config"
import { getProxyBaseURL, registerCleanup, startProxy } from "./proxy"

export const ClaudeMaxPlugin: Plugin = async ({ client }) => {
  const log = createLogger(client)

  const meridianConfig = loadMeridianConfig(log)
  const summary = summarizeMeridianConfig(meridianConfig)
  if (summary) void log("info", summary)

  ensureOpenCodeClientPromptPassthrough(log)

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

  return {
    // Set the base URL for the Anthropic provider
    async config(input) {
      const anthropic = input.provider?.anthropic
      if (!anthropic) return
      ;(anthropic.options ??= {}).baseURL = baseURL
    },

    // Keep OpenCode-assembled context, but strip the built-in OpenCode prompt.
    async "experimental.chat.system.transform"(input, output) {
      if (input.model.providerID !== "anthropic") return
      if (/^\s*You are OpenCode\b/i.test(output.system[0] ?? "")) {
        output.system.shift()
      }
    },

    // Strip Anthropic beta flags and add headers Meridian uses for OpenCode sessions.
    async "chat.headers"(incoming, output) {
      if (incoming.model.providerID !== "anthropic") return
      delete output.headers["anthropic-beta"]

      const agent = incoming.agent as
        | { name?: string; mode?: string }
        | string
        | undefined
      const agentDetails =
        typeof agent === "object" && agent !== null ? agent : undefined
      const rawAgentName = agentDetails?.name ?? String(agent ?? "unknown")
      const agentMode = agentDetails?.mode ?? "primary"

      output.headers["x-opencode-session"] = incoming.sessionID
      output.headers["x-opencode-request"] = incoming.message.id
      output.headers["x-opencode-agent-mode"] = agentMode
      output.headers["x-opencode-agent-name"] = rawAgentName
        .replace(/[^\x20-\x7E]/g, "")
        .trim() || "unknown"
    },
  }
}
