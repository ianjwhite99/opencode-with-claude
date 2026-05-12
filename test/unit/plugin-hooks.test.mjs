import assert from "node:assert/strict"
import test, { before, after } from "node:test"
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"

// Tier-2 coverage: drive each plugin hook with a fake OpenCode client.
// Runs a single real proxy instance for the whole file; the OS cleans it up
// when the Node test runner exits (registerCleanup is wired to process exit).

let hooks
let fakeHomeDir
let logEntries = []
let previousEnv = {}
let meridianModelMapperPromise

async function loadMeridianModelMapper() {
  if (meridianModelMapperPromise) return meridianModelMapperPromise

  const distDir = join(process.cwd(), "node_modules", "@rynfar", "meridian", "dist")
  const mapperFile = readdirSync(distDir).find((entry) => {
    if (!entry.endsWith(".js")) return false
    return readFileSync(join(distDir, entry), "utf8").includes(
      "function mapModelToClaudeModel",
    )
  })
  assert.ok(mapperFile, "expected Meridian dist to expose mapModelToClaudeModel")

  meridianModelMapperPromise = import(
    pathToFileURL(join(distDir, mapperFile)).href
  )
  return meridianModelMapperPromise
}

function makeClient() {
  return {
    app: {
      log: async ({ body }) => {
        // Capture log output so we can assert against it if needed.
        logEntries.push(body)
        return {}
      },
    },
  }
}

before(async () => {
  // Isolate ~/.config/meridian so tests don't read the developer's real files.
  fakeHomeDir = mkdtempSync(join(tmpdir(), "owc-hooks-"))
  mkdirSync(join(fakeHomeDir, ".config", "meridian"), { recursive: true })

  previousEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CLAUDE_PROXY_PORT: process.env.CLAUDE_PROXY_PORT,
    MERIDIAN_WORKDIR: process.env.MERIDIAN_WORKDIR,
    CLAUDE_PROXY_WORKDIR: process.env.CLAUDE_PROXY_WORKDIR,
  }

  process.env.HOME = fakeHomeDir
  process.env.USERPROFILE = fakeHomeDir
  delete process.env.MERIDIAN_WORKDIR
  delete process.env.CLAUDE_PROXY_WORKDIR

  // Use a random OS-assigned port so multiple runs don't collide.
  process.env.CLAUDE_PROXY_PORT = "0"

  const { ClaudeMaxPlugin } = await import(
    `../../dist/index.js?t=${Date.now()}${Math.random()}`
  )
  hooks = await ClaudeMaxPlugin({
    client: makeClient(),
    directory: fakeHomeDir,
    worktree: fakeHomeDir,
  })
})

after(async () => {
  // ClaudeMaxPlugin starts the proxy internally but doesn't return its
  // handle, so we trigger its registerCleanup() hook by emitting SIGINT
  // and waiting a short tick for the async close() to drain the event loop.
  // Without this, the open server keeps node:test from exiting.
  process.emit("SIGINT")
  await new Promise((resolve) => setTimeout(resolve, 250))

  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  rmSync(fakeHomeDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// config hook
// ---------------------------------------------------------------------------

test("config hook rewrites provider.anthropic.options.baseURL to the proxy URL", async () => {
  const input = {
    provider: { anthropic: { options: { baseURL: "https://api.anthropic.com" } } },
  }
  await hooks.config(input)
  assert.match(input.provider.anthropic.options.baseURL, /^http:\/\/.+:\d+$/)
})

test("config hook creates options when missing on the anthropic provider", async () => {
  const input = { provider: { anthropic: {} } }
  await hooks.config(input)
  assert.ok(input.provider.anthropic.options)
  assert.match(input.provider.anthropic.options.baseURL, /^http:\/\//)
})

test("config hook is a no-op when no anthropic provider exists", async () => {
  const input = { provider: { openai: { options: { baseURL: "other" } } } }
  await hooks.config(input)
  assert.deepEqual(input, {
    provider: { openai: { options: { baseURL: "other" } } },
  })
})

// ---------------------------------------------------------------------------
// system prompt handling
// ---------------------------------------------------------------------------

test("system.transform scrubs OpenCode fingerprints and keeps user context", async () => {
  const opencodePrompt = [
    "You are OpenCode, the best coding agent on the planet.",
    "",
    "If the user asks for help or wants to give feedback inform them of the following:",
    "- To give feedback, users should report the issue at",
    "  https://github.com/anomalyco/opencode",
    "",
    "When the user directly asks about OpenCode, use docs from https://opencode.ai/docs",
    "",
    "It is best for the user if OpenCode honestly applies rigorous standards.",
    "Keep this tool guidance.",
  ].join("\n")
  const env = [
    "You are powered by the model named claude-opus-4-6. The exact model ID is anthropic/claude-opus-4-6",
    "Here is some useful information about the environment you are running in:",
    "<env>",
    "  Working directory: /tmp/project",
    "</env>",
  ].join("\n")
  const agents = "# Fake agents marker\nproject-specific instructions here."
  const output = { system: [opencodePrompt, env, agents] }

  await hooks["experimental.chat.system.transform"](
    { model: { providerID: "anthropic" } },
    output,
  )

  assert.equal(output.system.length, 1)
  const scrubbed = output.system[0]
  assert.match(scrubbed, /You are an expert coding assistant/)
  assert.match(scrubbed, /Keep this tool guidance/)
  assert.match(scrubbed, /Fake agents marker/)
  assert.match(scrubbed, /the assistant honestly applies/)
  assert.doesNotMatch(scrubbed, /OpenCode/)
  assert.doesNotMatch(scrubbed, /github\.com\/anomalyco\/opencode/)
  assert.doesNotMatch(scrubbed, /opencode\.ai\/docs/)
  assert.doesNotMatch(scrubbed, /powered by the model named/)
  assert.doesNotMatch(scrubbed, /<env>/)
  assert.doesNotMatch(scrubbed, /Working directory:/)
})

test("system.transform ignores non-anthropic providers", async () => {
  const system = [
    "You are OpenCode, You and the user share the same workspace.",
    "<env>\nWorking directory: /tmp/project\n</env>",
  ]
  const output = { system: [...system] }

  await hooks["experimental.chat.system.transform"](
    { model: { providerID: "openai" } },
    output,
  )

  assert.deepEqual(output.system, system)
})

test("plugin does not mutate Meridian sdk-features.json", () => {
  assert.equal(
    existsSync(join(fakeHomeDir, ".config", "meridian", "sdk-features.json")),
    false,
  )
})

test("plugin provides Meridian cwd through process env", () => {
  assert.equal(process.env.MERIDIAN_WORKDIR, fakeHomeDir)
})

// ---------------------------------------------------------------------------
// chat.headers — strip anthropic-beta, add OpenCode/Meridian headers
// ---------------------------------------------------------------------------

test("chat.headers strips anthropic-beta and adds session + request IDs", async () => {
  const output = { headers: { "anthropic-beta": "some-flag", keep: "me" } }
  await hooks["chat.headers"](
    {
      sessionID: "sess-123",
      model: { providerID: "anthropic" },
      message: { id: "msg-abc" },
    },
    output,
  )
  assert.equal(output.headers["anthropic-beta"], undefined)
  assert.equal(output.headers["x-opencode-session"], "sess-123")
  assert.equal(output.headers["x-opencode-request"], "msg-abc")
  assert.equal(output.headers["x-opencode-agent-mode"], "primary")
  assert.equal(output.headers.keep, "me", "other headers should be preserved")
})

test("chat.headers strips non-ASCII before mode lookup", async () => {
  await hooks.config({
    agent: {
      explore: { mode: "subagent" },
    },
  })

  const output = { headers: {} }
  await hooks["chat.headers"](
    {
      sessionID: "sess-123",
      agent: "explore\u200b",
      model: { providerID: "anthropic" },
      message: { id: "msg-abc" },
    },
    output,
  )
  assert.equal(output.headers["x-opencode-agent-mode"], "subagent")
  assert.equal(output.headers["x-opencode-agent-name"], "explore")
})

test("chat.headers reads mode from runtime agent objects", async () => {
  const output = { headers: {} }
  await hooks["chat.headers"](
    {
      sessionID: "sess-123",
      agent: { name: "runtime-only", mode: "subagent" },
      model: { providerID: "anthropic" },
      message: { id: "msg-abc" },
    },
    output,
  )
  assert.equal(output.headers["x-opencode-agent-mode"], "subagent")
  assert.equal(output.headers["x-opencode-agent-name"], "runtime-only")
})

test("chat.headers prefers runtime agent mode over cached config", async () => {
  await hooks.config({
    agent: {
      explore: { mode: "primary" },
    },
  })

  const output = { headers: {} }
  await hooks["chat.headers"](
    {
      sessionID: "sess-123",
      agent: { name: "explore", mode: "subagent" },
      model: { providerID: "anthropic" },
      message: { id: "msg-abc" },
    },
    output,
  )
  assert.equal(output.headers["x-opencode-agent-mode"], "subagent")
  assert.equal(output.headers["x-opencode-agent-name"], "explore")
})

test("chat.headers keeps exact subagent mode without an agent name", async () => {
  const output = { headers: {} }
  await hooks["chat.headers"](
    {
      sessionID: "sess-123",
      agent: { mode: "subagent" },
      model: { providerID: "anthropic" },
      message: { id: "msg-abc" },
    },
    output,
  )
  assert.equal(output.headers["x-opencode-agent-mode"], "subagent")
  assert.equal(output.headers["x-opencode-agent-name"], "unknown")
})

test("chat.headers subagent mode selects Meridian non-extended tier", async () => {
  const { mapModelToClaudeModel } = await loadMeridianModelMapper()

  const subagentOutput = { headers: {} }
  await hooks["chat.headers"](
    {
      sessionID: "sess-123",
      agent: { name: "explore", mode: "subagent" },
      model: { providerID: "anthropic" },
      message: { id: "msg-subagent" },
    },
    subagentOutput,
  )

  const primaryOutput = { headers: {} }
  await hooks["chat.headers"](
    {
      sessionID: "sess-123",
      agent: { name: "build", mode: "primary" },
      model: { providerID: "anthropic" },
      message: { id: "msg-primary" },
    },
    primaryOutput,
  )

  assert.equal(
    mapModelToClaudeModel(
      "claude-opus-4-7",
      undefined,
      subagentOutput.headers["x-opencode-agent-mode"],
    ),
    "opus",
  )
  assert.equal(
    mapModelToClaudeModel(
      "claude-opus-4-7",
      undefined,
      primaryOutput.headers["x-opencode-agent-mode"],
    ),
    "opus[1m]",
  )
})

test("chat.headers resolves string agent modes from OpenCode config", async () => {
  await hooks.config({
    agent: {
      explore: { mode: "subagent" },
      build: { mode: "primary" },
    },
  })

  const output = { headers: {} }
  await hooks["chat.headers"](
    {
      sessionID: "sess-123",
      agent: "explore",
      model: { providerID: "anthropic" },
      message: { id: "msg-abc", agent: "explore" },
    },
    output,
  )
  assert.equal(output.headers["x-opencode-agent-mode"], "subagent")
})

test("chat.headers is safe when anthropic-beta header was never present", async () => {
  const output = { headers: {} }
  await hooks["chat.headers"](
    {
      sessionID: "s",
      model: { providerID: "anthropic" },
      message: { id: "m" },
    },
    output,
  )
  assert.equal(output.headers["x-opencode-session"], "s")
  assert.equal(output.headers["x-opencode-request"], "m")
  assert.equal(output.headers["x-opencode-agent-mode"], "primary")
})

test("chat.headers is a no-op for non-anthropic providers", async () => {
  const output = { headers: { "anthropic-beta": "still-here" } }
  await hooks["chat.headers"](
    {
      sessionID: "s",
      model: { providerID: "openai" },
      message: { id: "m" },
    },
    output,
  )
  assert.deepEqual(output.headers, { "anthropic-beta": "still-here" })
})

// ---------------------------------------------------------------------------
// Logger instrumentation
// ---------------------------------------------------------------------------

test("plugin logs 'proxy ready' during startup", () => {
  // The before-hook already invoked ClaudeMaxPlugin. One of the startup log
  // entries should announce the proxy URL.
  assert.ok(
    logEntries.some(
      (e) =>
        e.service === "opencode-with-claude" &&
        typeof e.message === "string" &&
        e.message.startsWith("proxy ready at http://"),
    ),
    "expected a 'proxy ready at ...' log entry from startup",
  )
})
