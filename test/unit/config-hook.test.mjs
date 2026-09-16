import assert from "node:assert/strict"
import test from "node:test"

import * as pluginModule from "../../dist/index.js"

// OpenCode 1.17–1.18.3 iterate *every* export of a plugin module and load each
// one, so anything beyond the default export would start a second proxy.
// OpenCode 1.18.4+ reads `default.server`; OpenCode 2 reads `default.id` and
// `default.setup`. One default export serves all three.
test("bundle exports only the default plugin definition", () => {
  assert.deepEqual(Object.keys(pluginModule), ["default"])
})

test("default export carries the v1 server() and v2 setup() entry points", () => {
  const plugin = pluginModule.default
  assert.equal(plugin.id, "opencode-with-claude")
  assert.equal(typeof plugin.server, "function")
  assert.equal(typeof plugin.setup, "function")
  assert.equal("tui" in plugin, false, "v1 rejects a module that has both server() and tui()")
})

test("bundle does not expose helper functions that legacy loaders would treat as plugins", () => {
  assert.equal("applyAnthropicProxyConfig" in pluginModule, false)
  assert.equal("applyMeridianHeaders" in pluginModule, false)
})
