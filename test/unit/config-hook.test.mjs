import assert from "node:assert/strict"
import test from "node:test"

import * as pluginModule from "../../dist/index.js"

test("bundle exports only the real plugin entry", () => {
  assert.deepEqual(Object.keys(pluginModule).sort(), ["ClaudeMaxPlugin"])
  assert.equal(typeof pluginModule.ClaudeMaxPlugin, "function")
})

test("bundle does not expose helper functions that legacy loader would treat as plugins", () => {
  assert.equal("applyAnthropicProxyConfig" in pluginModule, false)
})
