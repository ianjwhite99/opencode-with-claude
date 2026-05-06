import assert from "node:assert/strict"
import test, { before, after } from "node:test"
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// Tier-2 coverage: drive each plugin hook with a fake OpenCode client.
// Runs a single real proxy instance for the whole file; the OS cleans it up
// when the Node test runner exits (registerCleanup is wired to process exit).

let hooks
let fakeHomeDir
let logEntries = []
let previousEnv = {}

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
  }

  process.env.HOME = fakeHomeDir
  process.env.USERPROFILE = fakeHomeDir

  // Use a random OS-assigned port so multiple runs don't collide.
  process.env.CLAUDE_PROXY_PORT = "0"

  const { ClaudeMaxPlugin } = await import(
    `../../dist/index.js?t=${Date.now()}${Math.random()}`
  )
  hooks = await ClaudeMaxPlugin({ client: makeClient() })
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

test("system.transform strips the OpenCode prompt and keeps assembled context", async () => {
  const opencodePrompt = [
    "You are OpenCode, You and the user share the same workspace.",
    "",
    "OpenCode-specific tool and behavior instructions that should be stripped.",
  ].join("\n")
  const env = "<env>\nWorking directory: /tmp/project\n</env>"
  const agents = "# Fake agents marker\nproject-specific instructions here."
  const output = { system: [opencodePrompt, env, agents] }

  await hooks["experimental.chat.system.transform"](
    { model: { providerID: "anthropic" } },
    output,
  )

  assert.equal(output.system.includes(opencodePrompt), false)
  assert.equal(
    output.system.some((entry) => entry.includes("OpenCode-specific")),
    false,
  )
  assert.deepEqual(output.system, [env, agents])
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
  assert.equal(output.headers["x-opencode-agent-name"], "unknown")
  assert.equal(output.headers.keep, "me", "other headers should be preserved")
})

test("chat.headers forwards agent mode and sanitized agent name", async () => {
  const output = { headers: {} }
  await hooks["chat.headers"](
    {
      sessionID: "sess-123",
      agent: { name: "explore\u200b", mode: "subagent" },
      model: { providerID: "anthropic" },
      message: { id: "msg-abc" },
    },
    output,
  )
  assert.equal(output.headers["x-opencode-agent-mode"], "subagent")
  assert.equal(output.headers["x-opencode-agent-name"], "explore")
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
  assert.equal(output.headers["x-opencode-agent-name"], "unknown")
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
