import assert from "node:assert/strict"
import test, { before, after } from "node:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"

// Drive the OpenCode v2 entry point (`default.setup(ctx)`) with a fake plugin
// context that records hook registrations and lets tests dispatch events.

let fakeHomeDir
let previousEnv = {}
let ctx
let cleanup
let stderrLines = []
let previousConsoleError
let plugin
let secondContext
let secondCleanup
let cleanupListenerCounts

const listenerCounts = () => ["exit", "SIGINT", "SIGTERM"].map((event) =>
  process.listenerCount(event),
)

async function proxyURL(context) {
  const input = await context.emit("model.request", modelRequest())
  return input.baseURL.replace(/\/v1$/, "")
}

function makeContext() {
  const hooks = { session: new Map(), agentTransforms: [] }
  const disposed = []
  const registration = (label) => ({
    dispose: async () => {
      disposed.push(label)
    },
  })
  return {
    hooks,
    disposed,
    app: { name: "opencode", version: "2.0.3", channel: "stable" },
    agent: {
      transform: async (callback) => {
        hooks.agentTransforms.push(callback)
        return registration("agent.transform")
      },
    },
    session: {
      hook: async (name, callback, options) => {
        const list = hooks.session.get(name) ?? []
        list.push({ callback, options })
        hooks.session.set(name, list)
        return registration(`session.${name}`)
      },
    },
    // Dispatch helpers used by the tests below.
    async emit(name, input) {
      for (const { callback, options } of hooks.session.get(name) ?? []) {
        if (options?.providerID && options.providerID !== input.model.providerID) continue
        await callback(input)
      }
      return input
    },
    runAgentTransform(agents) {
      const editor = { list: () => agents }
      for (const callback of hooks.agentTransforms) callback(editor)
    },
  }
}

const modelRequest = (overrides = {}) => ({
  sessionID: "sess-v2",
  agent: "build",
  model: { id: "claude-sonnet-4-5", providerID: "anthropic" },
  kind: "primary",
  headers: {},
  ...overrides,
})

before(async () => {
  fakeHomeDir = mkdtempSync(join(tmpdir(), "owc-v2-"))
  mkdirSync(join(fakeHomeDir, ".config", "meridian"), { recursive: true })
  previousEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CLAUDE_PROXY_PORT: process.env.CLAUDE_PROXY_PORT,
  }
  process.env.HOME = fakeHomeDir
  process.env.USERPROFILE = fakeHomeDir
  process.env.CLAUDE_PROXY_PORT = "0"

  previousConsoleError = console.error
  console.error = (...args) => {
    stderrLines.push(args.map(String).join(" "))
  }

  ;({ default: plugin } = await import(
    `${pathToFileURL(join(process.cwd(), "dist", "index.js")).href}?v2=${Date.now()}`
  ))
  cleanupListenerCounts = listenerCounts()
  ctx = makeContext()
  secondContext = makeContext()
  ;[cleanup, secondCleanup] = await Promise.all([
    plugin.setup(ctx),
    plugin.setup(secondContext),
  ])
})

after(async () => {
  await cleanup?.()
  await secondCleanup?.()
  console.error = previousConsoleError
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(fakeHomeDir, { recursive: true, force: true })
})

test("concurrent and repeated setup share one proxy and one set of cleanup listeners", async () => {
  assert.equal(await proxyURL(ctx), await proxyURL(secondContext))
  assert.equal(stderrLines.filter((line) => line.includes("proxy ready at http://")).length, 1)
  assert.deepEqual(listenerCounts(), cleanupListenerCounts.map((n, i) =>
    n + (i === 2 && process.platform === "win32" ? 0 : 1),
  ))

  const third = makeContext()
  const dispose = await plugin.setup(third)
  try {
    assert.equal(await proxyURL(third), await proxyURL(ctx))
  } finally {
    await dispose()
    await dispose()
  }
})

test("failed hook registration releases only its own shared runtime reference", async () => {
  const failing = makeContext()
  failing.session.hook = async () => { throw new Error("registration failed") }
  await assert.rejects(plugin.setup(failing), /registration failed/)
  assert.deepEqual(failing.disposed, ["agent.transform"])
  const response = await fetch(`${await proxyURL(ctx)}/health`)
  assert.equal(response.ok, true)
})

test("setup registers anthropic-scoped session hooks and an agent transform", () => {
  const names = [...ctx.hooks.session.keys()].sort()
  assert.deepEqual(names, ["compaction", "context", "generate", "model.request", "title"])
  for (const [name, list] of ctx.hooks.session) {
    for (const { options } of list) {
      assert.deepEqual(options, { providerID: "anthropic" }, `${name} must be scoped to anthropic`)
    }
  }
  assert.equal(ctx.hooks.agentTransforms.length, 1)
})

test("setup logs the proxy URL to stderr (v2 has no plugin log API)", () => {
  const ready = stderrLines.find((line) => line.includes("proxy ready at http://"))
  assert.ok(ready, `expected a 'proxy ready' line, got:\n${stderrLines.join("\n")}`)
  assert.match(ready, /^\[opencode-with-claude\] info: /)
})

test("model.request points anthropic at the proxy's /v1 and adds session headers", async () => {
  const ready = stderrLines.find((line) => line.includes("proxy ready at http://"))
  const proxyURL = ready.slice(ready.indexOf("http://"))

  const input = await ctx.emit("model.request", modelRequest({
    headers: { "anthropic-beta": "some-flag", keep: "me" },
  }))
  assert.equal(input.baseURL, `${proxyURL}/v1`)
  assert.equal(input.headers["anthropic-beta"], undefined)
  assert.equal(input.headers.keep, "me")
  assert.equal(input.headers["x-opencode-session"], "sess-v2")
  assert.equal(input.headers["x-opencode-agent-name"], "build")
  assert.equal(input.headers["x-opencode-agent-mode"], "primary")
  assert.equal(input.headers["x-meridian-source"], undefined)
})

test("model.request leaves other providers alone", async () => {
  const input = await ctx.emit("model.request", modelRequest({
    model: { id: "gpt", providerID: "openai" },
    headers: { "anthropic-beta": "still-here" },
  }))
  assert.equal(input.baseURL, undefined)
  assert.deepEqual(input.headers, { "anthropic-beta": "still-here" })
})

test("model.request detaches title requests from the session lease", async () => {
  for (const request of [
    modelRequest({ kind: "title", agent: "title" }),
    modelRequest({ kind: "primary", agent: "title" }),
    modelRequest({ kind: "primary", agent: "summary" }),
    modelRequest({ kind: "generate", agent: "build" }),
  ]) {
    request.headers = { "X-OpenCode-Session": "stale", "x-session-affinity": "stale" }
    const input = await ctx.emit("model.request", request)
    assert.equal(input.headers["x-opencode-session"], undefined, JSON.stringify(request))
    assert.equal(input.headers["X-OpenCode-Session"], undefined)
    assert.equal(input.headers["x-session-affinity"], undefined)
    assert.equal(input.headers["x-opencode-agent-mode"], "subagent")
    assert.equal(input.headers["x-meridian-source"], `subagent-${request.agent}`)
    assert.equal(input.headers["x-opencode-agent-name"], request.agent)
  }
})

test("model.request keeps compaction in the session on the subagent tier", async () => {
  const input = await ctx.emit("model.request", modelRequest({
    kind: "compaction",
    agent: "compaction",
  }))
  assert.equal(input.headers["x-opencode-session"], "sess-v2")
  assert.equal(input.headers["x-opencode-agent-mode"], "primary")
  assert.equal(input.headers["x-meridian-source"], "subagent-compaction")
})

test("model.request resolves agent modes from the agent transform, with built-in fallbacks", async () => {
  // Built-in subagents are known even before the transform has run.
  let input = await ctx.emit("model.request", modelRequest({ agent: "explore" }))
  assert.equal(input.headers["x-opencode-agent-mode"], "subagent")

  ctx.runAgentTransform([
    { id: "build", mode: "primary" },
    { id: "reviewer", mode: "subagent" },
    { id: "helper", mode: "all" },
  ])
  input = await ctx.emit("model.request", modelRequest({ agent: "reviewer" }))
  assert.equal(input.headers["x-opencode-agent-mode"], "subagent")
  input = await ctx.emit("model.request", modelRequest({ agent: "helper" }))
  assert.equal(input.headers["x-opencode-agent-mode"], "primary")
  input = await ctx.emit("model.request", modelRequest({ agent: "unknown-agent" }))
  assert.equal(input.headers["x-opencode-agent-mode"], "primary")
})

test("model.request strips non-ASCII from the agent name", async () => {
  const input = await ctx.emit("model.request", modelRequest({ agent: "explore​" }))
  assert.equal(input.headers["x-opencode-agent-name"], "explore")
  assert.equal(input.headers["x-opencode-agent-mode"], "subagent")
})

test("context hook scrubs OpenCode fingerprints but keeps user context", async () => {
  // Same fixture as the v1 system.transform test, split into v2 system parts.
  const system = [
    {
      type: "text",
      text: [
        "You are OpenCode, the best coding agent on the planet.",
        "",
        "When the user directly asks about OpenCode, use docs from https://opencode.ai/docs",
        "",
        "Keep this tool guidance.",
      ].join("\n"),
    },
    {
      type: "text",
      text: [
        "You are powered by the model named claude-opus-4-6. The exact model ID is anthropic/claude-opus-4-6",
        "Here is some useful information about the environment you are running in:",
        "<env>",
        "  Working directory: /tmp/project",
        "</env>",
      ].join("\n"),
    },
    { type: "text", text: "# Fake agents marker\nproject-specific instructions here." },
  ]
  const input = await ctx.emit("context", {
    sessionID: "sess-v2",
    agent: "build",
    model: { id: "claude-sonnet-4-5", providerID: "anthropic" },
    system,
    messages: [],
    options: {},
    tools: {},
  })
  assert.equal(input.system.length, 1)
  assert.equal(input.system[0].type, "text")
  assert.match(input.system[0].text, /Fake agents marker/)
  assert.match(input.system[0].text, /Keep this tool guidance/)
  assert.doesNotMatch(input.system[0].text, /OpenCode/)
  assert.doesNotMatch(input.system[0].text, /opencode\.ai\/docs/)
  assert.doesNotMatch(input.system[0].text, /powered by the model named/)
  assert.doesNotMatch(input.system[0].text, /Working directory:/)
})

test("context hook leaves a clean system prompt untouched", async () => {
  const system = [{ type: "text", text: "Plain instructions.", cache: { type: "ephemeral" } }]
  const input = await ctx.emit("context", {
    sessionID: "sess-v2",
    agent: "build",
    model: { id: "claude-sonnet-4-5", providerID: "anthropic" },
    system,
    messages: [],
    options: {},
    tools: {},
  })
  assert.equal(input.system.length, 1)
  assert.equal(input.system[0], system[0], "unchanged parts keep their cache hints")
})

test("context hook ignores non-anthropic providers", async () => {
  const system = [{ type: "text", text: "You are OpenCode." }]
  const input = await ctx.emit("context", {
    sessionID: "sess-v2",
    agent: "build",
    model: { id: "gpt", providerID: "openai" },
    system: [...system],
    messages: [],
    options: {},
    tools: {},
  })
  assert.deepEqual(input.system, system)
})

test("cleanup disposes every registration and stops the proxy", async () => {
  const ready = stderrLines.find((line) => line.includes("proxy ready at http://"))
  const proxyURL = ready.slice(ready.indexOf("http://"))
  const before = await fetch(`${proxyURL}/health`, { signal: AbortSignal.timeout(5_000) })
  assert.equal(before.ok, true, "proxy should answer /health while the plugin is loaded")

  await cleanup()
  await cleanup()

  const stillRunning = await fetch(`${proxyURL}/health`, { signal: AbortSignal.timeout(5_000) })
  assert.equal(stillRunning.ok, true, "another plugin instance still owns the proxy")
  await secondCleanup()

  assert.deepEqual(
    [...ctx.disposed].sort(),
    [
      "agent.transform",
      "session.compaction",
      "session.context",
      "session.generate",
      "session.model.request",
      "session.title",
    ],
  )
  await assert.rejects(
    fetch(`${proxyURL}/health`, { signal: AbortSignal.timeout(2_000) }),
    "proxy should be closed after cleanup",
  )
  assert.deepEqual(listenerCounts(), cleanupListenerCounts)
})

test("setup can restart after final disposal, including while close is in flight", async () => {
  const first = makeContext()
  const disposeFirst = await plugin.setup(first)
  const closing = disposeFirst()
  const next = makeContext()
  const nextSetup = plugin.setup(next)
  await closing
  const disposeNext = await nextSetup
  try {
    const response = await fetch(`${await proxyURL(next)}/health`)
    assert.equal(response.ok, true)
  } finally {
    await disposeNext()
  }
  assert.deepEqual(listenerCounts(), cleanupListenerCounts)
})

test("a failed startup is not cached and the next setup can retry", async () => {
  process.env.CLAUDE_PROXY_PORT = "-1"
  try {
    const attempts = await Promise.allSettled([
      plugin.setup(makeContext()),
      plugin.setup(makeContext()),
    ])
    for (const attempt of attempts) {
      assert.equal(attempt.status, "rejected")
      assert.equal(attempt.reason.code, "ERR_SOCKET_BAD_PORT")
    }
  } finally {
    process.env.CLAUDE_PROXY_PORT = "0"
  }

  const recovered = makeContext()
  const dispose = await plugin.setup(recovered)
  try {
    const response = await fetch(`${await proxyURL(recovered)}/health`)
    assert.equal(response.ok, true)
  } finally {
    await dispose()
  }
  assert.deepEqual(listenerCounts(), cleanupListenerCounts)
})
