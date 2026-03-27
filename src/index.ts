import type { Plugin } from "@opencode-ai/plugin"

import { createLogger } from "./logger.js"
import { checkProxyHealth, registerCleanup, startProxy } from "./proxy.js"

export const ClaudeMaxPlugin: Plugin = async ({ client, $, directory }) => {
  const log = createLogger(client)

  const port =
    parseInt(process.env.CLAUDE_PROXY_PORT || "", 10) || undefined

  const proxy = await startProxy({ port, log })

  const baseURL = `http://127.0.0.1:${proxy.port}`
  await log("info", `proxy ready at ${baseURL}`)

  registerCleanup(proxy)

  // Run an initial health check so auth / setup issues are surfaced
  // immediately rather than silently hanging on the first request.
  const initialHealth = await checkProxyHealth(proxy.port, log)
  if (!initialHealth.ok) {
    await log(
      "error",
      `[claude-max] Proxy started but is not healthy: ${initialHealth.message}. Requests will likely fail.`
    )
  }

  return {
    async config(input) {
      input.provider ??= {}
      input.provider.anthropic ??= {}
      input.provider.anthropic.options ??= {}
      input.provider.anthropic.options.baseURL = baseURL
      input.provider.anthropic.options.apiKey = "claude-max-proxy"
    },
    async "chat.params"(incoming, output) {
      if (incoming.provider?.info?.id !== "anthropic") return

      const health = await checkProxyHealth(proxy.port, log)
      if (!health.ok) {
        throw new Error(
          `Claude Max proxy is not healthy: ${health.message}`
        )
      }
    },
    async "chat.headers"(incoming, output) {
      if (incoming.model.providerID !== "anthropic") return
      output.headers["x-opencode-session"] = incoming.sessionID
      output.headers["x-opencode-request"] = incoming.message.id
    },
  }
}
