import type { Plugin } from "@opencode-ai/plugin"

import { createLogger } from "./logger.js"
import { registerCleanup, startProxy } from "./proxy.js"

export const ClaudeMaxPlugin: Plugin = async ({ client, $, directory }) => {
  const log = createLogger(client)

  const port =
    parseInt(process.env.CLAUDE_PROXY_PORT || "", 10) || undefined

  const proxy = await startProxy({ port, log })

  const baseURL = `http://127.0.0.1:${proxy.port}`
  await log("info", `proxy ready at ${baseURL}`)

  registerCleanup(proxy)

  return {
    async config(input) {
      input.provider ??= {}
      input.provider.anthropic ??= {}
      input.provider.anthropic.options ??= {}
      input.provider.anthropic.options.baseURL = baseURL
      input.provider.anthropic.options.apiKey = "claude-max-proxy"
    },
    async "chat.headers"(incoming, output) {
      if (incoming.model.providerID !== "anthropic") return
      output.headers["x-opencode-session"] = incoming.sessionID
      output.headers["x-opencode-request"] = incoming.message.id
    },
  }
}
