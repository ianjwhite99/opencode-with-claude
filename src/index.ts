import type { Plugin } from "@opencode-ai/plugin"
import { scrubOpencodeFingerprints } from "@rynfar/meridian-plugin-opencode-scrub"

import { createLogger } from "./logger"
import {
  loadMeridianConfig,
  summarizeMeridianConfig,
} from "./meridian-config"
import { getProxyBaseURL, registerCleanup, startProxy } from "./proxy"

export const ClaudeMaxPlugin: Plugin = async ({ client, directory }) => {
  const log = createLogger(client)
  const agentModes = new Map<string, string>()

  if (
    directory &&
    !process.env.MERIDIAN_WORKDIR &&
    !process.env.CLAUDE_PROXY_WORKDIR
  ) {
    process.env.MERIDIAN_WORKDIR = directory
  }

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

  return {
    // Set the base URL for the Anthropic provider
    async config(input) {
      for (const [name, agent] of Object.entries(input.agent ?? {})) {
        if (!agent?.mode) continue
        agentModes.set(name.toLowerCase(), agent.mode)
      }

      const anthropic = input.provider?.anthropic
      if (!anthropic) return
      ;(anthropic.options ??= {}).baseURL = baseURL
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

      output.headers["x-opencode-session"] = incoming.sessionID
      output.headers["x-opencode-request"] = incoming.message.id
      output.headers["x-opencode-agent-mode"] = agentMode
      output.headers["x-opencode-agent-name"] = agentName
    },
  }
}
