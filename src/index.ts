import type { Plugin } from "@opencode-ai/plugin"

import { loadPrompt } from "./prompts"
import { createLogger } from "./logger"
import { registerCleanup, startProxy } from "./proxy"

export const ClaudeMaxPlugin: Plugin = async ({ client }) => {
  const log = createLogger(client)

  const port = process.env.CLAUDE_PROXY_PORT || 3456
  const proxy = await startProxy({ port, log })

  const baseURL = `http://127.0.0.1:${proxy.port}`
  await log("info", `proxy ready at ${baseURL}`)
  
  registerCleanup(proxy)

  let currentAgent: string

  return {
    async config(input) {
      const opts = ((input.provider ??= {}).anthropic ??= {}).options ??= {}
      opts.baseURL = baseURL
    },

    async "chat.message"(incoming, output) {
      if (incoming.model?.providerID !== "anthropic") return
      currentAgent = output.message.agent
    },

    async "experimental.chat.system.transform"(input, output) {
      if (input.model.providerID !== "anthropic") return
      output.system.splice(0, output.system.length, loadPrompt(currentAgent))
    },

    async "chat.headers"(incoming, output) {
      if (incoming.model.providerID !== "anthropic") return
      output.headers["x-opencode-session"] = incoming.sessionID
      output.headers["x-opencode-request"] = incoming.message.id
    },
  }
}
