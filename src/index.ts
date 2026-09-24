import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import type { Plugin as OpenCodeV2 } from "@opencode/plugin"
import { scrubOpencodeFingerprints } from "@rynfar/meridian-plugin-opencode-scrub"

import {
  COMPACTION_AGENT,
  DETACHED_AGENTS,
  applyMeridianHeaders,
  resolveAgentMode,
  safeAgentName,
  type RequestIdentity,
} from "./headers"
import { createConsoleLogger, createLogger, type LogFn } from "./logger"
import {
  loadMeridianConfig,
  summarizeMeridianConfig,
} from "./meridian-config"
import {
  checkProxyHealth,
  getProxyBaseURL,
  registerCleanup,
  startProxy,
  type ProxyHandle,
} from "./proxy"

const PLUGIN_ID = "opencode-with-claude"
const ANTHROPIC = "anthropic"
const MAX_HUMAN_MESSAGES = 4096

// ---------------------------------------------------------------------------
// Shared runtime: the proxy lifecycle is identical on both OpenCode generations
// ---------------------------------------------------------------------------

interface Runtime {
  proxy: ProxyHandle
  /** Loopback URL of the running proxy, without an API version suffix. */
  baseURL: string
}

interface SharedRuntime {
  ready: Promise<Runtime>
  users: number
  closing?: Promise<void>
}

// OpenCode initializes plugins per project. Cache the in-flight startup too,
// so simultaneous project loads cannot race to bind the same port.
let sharedRuntime: SharedRuntime | undefined

async function acquireRuntime(log: LogFn) {
  while (sharedRuntime?.closing) await sharedRuntime.closing
  const shared = sharedRuntime ??= {
    ready: startRuntime(log),
    users: 0,
  }
  shared.users++

  let runtime: Runtime
  try {
    runtime = await shared.ready
  } catch (error) {
    if (sharedRuntime === shared) sharedRuntime = undefined
    throw error
  }

  let released = false
  return {
    baseURL: runtime.baseURL,
    release: async () => {
      if (released) return
      released = true
      if (--shared.users > 0) return
      shared.closing = runtime.proxy.close().finally(() => {
        if (sharedRuntime === shared) sharedRuntime = undefined
      })
      await shared.closing
    },
  }
}

async function startRuntime(log: LogFn): Promise<Runtime> {
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

  const unregisterCleanup = registerCleanup(proxy)
  const close = proxy.close
  let closing: Promise<void> | undefined
  proxy.close = () => {
    unregisterCleanup()
    return closing ??= close()
  }

  // Deliberately not awaited: this only produces log lines, and /health can
  // take seconds when Meridian's auth cache is cold. Blocking OpenCode's
  // startup on it would trade real latency for a diagnostic.
  void checkProxyHealth(proxy.port, log)

  return { proxy, baseURL }
}

/**
 * Keep user context, but scrub OpenCode fingerprints before Meridian
 * passthrough. Operates on the joined prompt; returns undefined when nothing
 * changed so callers can leave the original parts untouched.
 */
function scrubSystemPrompt(system: string[]): string | undefined {
  const joined = system.join("\n\n")
  const scrubbed = scrubOpencodeFingerprints(joined)
  return scrubbed === joined ? undefined : scrubbed
}

// ---------------------------------------------------------------------------
// OpenCode v1 (`@opencode-ai/plugin`): hook object returned from server()
// ---------------------------------------------------------------------------

const server: Plugin = async ({ client }) => {
  const log = createLogger(client)
  const agentModes = new Map<string, string>()
  const humanMessages = new Map<string, true>()

  const messageKey = (sessionID: string, messageID: string) =>
    `${sessionID}\u0000${messageID}`

  // v1 has no disposal hook, so its reference lives until process cleanup.
  const { baseURL } = await acquireRuntime(log)

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

    async "experimental.chat.system.transform"(input, output) {
      if (input.model.providerID !== ANTHROPIC) return
      const scrubbed = scrubSystemPrompt(output.system)
      if (scrubbed !== undefined) {
        output.system.splice(0, output.system.length, scrubbed)
      }
    },

    // Strip Anthropic beta flags and add the headers Meridian uses for
    // OpenCode sessions (see headers.ts for the title/summary detachment).
    async "chat.headers"(incoming, output) {
      if (incoming.model.providerID !== ANTHROPIC) return

      // OpenCode types this as a string, but at runtime some versions pass the
      // full agent object. Use .mode directly so subagents don't look primary.
      const agent = incoming.agent as unknown as
        | string
        | { name?: string; mode?: string }
      const hasAgentObject = typeof agent === "object" && agent !== null
      const agentName = safeAgentName(hasAgentObject ? agent.name : agent)

      const identity: RequestIdentity = {
        sessionID: incoming.sessionID,
        agentName,
        agentMode: resolveAgentMode(
          agentName,
          hasAgentObject ? agent.mode : undefined,
          agentModes,
        ),
        detached: DETACHED_AGENTS.has(agentName.toLowerCase()),
      }
      applyMeridianHeaders(output.headers, identity)

      output.headers["x-opencode-request"] = incoming.message.id
      output.headers["x-opencode-request-kind"] = humanMessages.has(
        messageKey(incoming.sessionID, incoming.message.id),
      )
        ? "human"
        : "synthetic"
    },
  }
}

// ---------------------------------------------------------------------------
// OpenCode v2 (`@opencode/plugin`): hooks registered on the setup context
// ---------------------------------------------------------------------------

type Registration = { dispose: () => Promise<void> }

/**
 * v2 tells us *why* a request is made (`kind`) as well as which agent makes
 * it, so the hidden one-shots can be detached by kind and not only by the
 * built-in agent id.
 */
function identityV2(
  input: { sessionID: string; agent: unknown; kind: string },
  agentModes: ReadonlyMap<string, string>,
): RequestIdentity {
  const agentName = safeAgentName(input.agent)
  const key = agentName.toLowerCase()
  const detached =
    input.kind === "title" ||
    input.kind === "generate" ||
    DETACHED_AGENTS.has(key)
  const compaction = input.kind === "compaction" || key === COMPACTION_AGENT
  return {
    sessionID: String(input.sessionID),
    agentName,
    // Compaction stays in the session's lineage; the source marker lets
    // Meridian pick the subagent tier for it without splitting the session.
    agentMode: compaction
      ? "primary"
      : resolveAgentMode(agentName, undefined, agentModes),
    detached,
    source: compaction && !detached ? "subagent-compaction" : undefined,
  }
}

const setup: OpenCodeV2.Plugin["setup"] = async (ctx) => {
  const log = createConsoleLogger()
  const agentModes = new Map<string, string>()
  const registrations: Registration[] = []

  const { release, baseURL } = await acquireRuntime(log)
  // The Anthropic SDK resolves `/messages` (and `/models`) against this, so
  // it needs the version segment that v1 provider config used to carry.
  const anthropicBaseURL = `${baseURL}/v1`

  const dispose = async () => {
    const results = await Promise.allSettled(
      registrations.splice(0).map((registration) => registration.dispose()),
    )
    await release()
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    )
    if (failures.length > 0) {
      throw new AggregateError(failures, `${PLUGIN_ID}: failed to dispose hooks`)
    }
  }

  try {
    // Built-in agents are part of the assembled agent set, so the transform
    // sees every mode the v1 config hook could see, plus the built-ins.
    registrations.push(
      await ctx.agent.transform((editor) => {
        agentModes.clear()
        for (const agent of editor.list()) {
          agentModes.set(String(agent.id).toLowerCase(), agent.mode)
        }
      }),
    )

    registrations.push(
      await ctx.session.hook(
        "model.request",
        (input) => {
          input.baseURL = anthropicBaseURL
          applyMeridianHeaders(input.headers, identityV2(input, agentModes))
        },
        { providerID: ANTHROPIC },
      ),
    )

    // Every request that carries a system prompt: the agent loop, compaction,
    // titles, and plugin-driven generation.
    for (const name of ["context", "compaction", "title", "generate"] as const) {
      registrations.push(
        await ctx.session.hook(
          name,
          (input) => {
            const scrubbed = scrubSystemPrompt(input.system.map((part) => part.text))
            if (scrubbed !== undefined) {
              input.system.splice(0, input.system.length, {
                type: "text",
                text: scrubbed,
              })
            }
          },
          { providerID: ANTHROPIC },
        ),
      )
    }
  } catch (error) {
    await dispose().catch(() => {})
    throw error
  }

  return dispose
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * One module serves both OpenCode generations:
 *
 * - v1 (1.17+) reads `default.server`. Older 1.x loaders iterate *every*
 *   export and accept an object with `server`, which is why this file has no
 *   named exports: a second export would load the plugin (and the proxy)
 *   twice.
 * - v2 reads `default.id` and `default.setup` and ignores `server`.
 */
const plugin: PluginModule & OpenCodeV2.Plugin = {
  id: PLUGIN_ID,
  server,
  setup,
}

export default plugin
