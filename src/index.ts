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
  let agentModesLoaded: Promise<Map<string, string>> | undefined

  const loadAgentModes = async () => {
    const modes = new Map<string, string>()

    try {
      const response = await client.app.agents(
        directory ? { query: { directory } } : {}
      )
      if (response.error || !Array.isArray(response.data)) return modes

      for (const agent of response.data) {
        modes.set(agent.name, agent.mode)
        modes.set(agent.name.toLowerCase(), agent.mode)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      void log("debug", `could not load OpenCode agent modes: ${msg}`)
    }

    return modes
  }

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

      const agent = incoming.agent as
        | { name?: string; mode?: string }
        | string
        | undefined
      const agentDetails =
        typeof agent === "object" && agent !== null ? agent : undefined
      const rawAgentName = agentDetails?.name ?? String(agent ?? "unknown")
      const agentName =
        rawAgentName.replace(/[^\x20-\x7E]/g, "").trim() || "unknown"
      let agentMode = agentDetails?.mode
      if (!agentMode) {
        agentModesLoaded ??= loadAgentModes()
        const agentModes = await agentModesLoaded
        agentMode =
          agentModes.get(agentName) ?? agentModes.get(agentName.toLowerCase())
      }
      agentMode ??= "primary"

      output.headers["x-opencode-session"] = incoming.sessionID
      output.headers["x-opencode-request"] = incoming.message.id
      output.headers["x-opencode-agent-mode"] = agentMode
      output.headers["x-opencode-agent-name"] = agentName
    },
  }
}
