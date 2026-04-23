import assert from "node:assert/strict"
import test from "node:test"

// Pure-function coverage for the host/URL helpers in src/proxy.ts.
// Each test snapshot-restores the env vars it touches so the suite stays
// order-independent.

async function freshImport() {
  // Re-import with cache-busting so each test observes the current env.
  return await import(`../../src/proxy.ts?t=${Date.now()}${Math.random()}`)
}

function withEnv(vars, fn) {
  const prev = {}
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k]
    if (vars[k] === undefined) delete process.env[k]
    else process.env[k] = vars[k]
  }
  try {
    return fn()
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  }
}

test("getProxyHost: defaults to 127.0.0.1 when no env vars are set", async () => {
  const { getProxyHost } = await freshImport()
  await withEnv(
    { MERIDIAN_HOST: undefined, CLAUDE_PROXY_HOST: undefined },
    () => {
      assert.equal(getProxyHost(), "127.0.0.1")
    },
  )
})

test("getProxyHost: MERIDIAN_HOST wins over CLAUDE_PROXY_HOST", async () => {
  const { getProxyHost } = await freshImport()
  await withEnv(
    { MERIDIAN_HOST: "10.0.0.1", CLAUDE_PROXY_HOST: "10.0.0.2" },
    () => {
      assert.equal(getProxyHost(), "10.0.0.1")
    },
  )
})

test("getProxyHost: falls back to CLAUDE_PROXY_HOST when MERIDIAN_HOST is empty", async () => {
  const { getProxyHost } = await freshImport()
  await withEnv({ MERIDIAN_HOST: "", CLAUDE_PROXY_HOST: "192.168.1.1" }, () => {
    assert.equal(getProxyHost(), "192.168.1.1")
  })
})

test("getProxyHost: strips surrounding [] from bracketed IPv6 addresses", async () => {
  const { getProxyHost } = await freshImport()
  await withEnv({ MERIDIAN_HOST: "[::1]", CLAUDE_PROXY_HOST: undefined }, () => {
    assert.equal(getProxyHost(), "::1")
  })
})

test("getProxyHost: trims whitespace", async () => {
  const { getProxyHost } = await freshImport()
  await withEnv(
    { MERIDIAN_HOST: "  1.2.3.4  ", CLAUDE_PROXY_HOST: undefined },
    () => {
      assert.equal(getProxyHost(), "1.2.3.4")
    },
  )
})

test('getProxyConnectHost: "0.0.0.0" is rewritten to loopback', async () => {
  const { getProxyConnectHost } = await freshImport()
  assert.equal(getProxyConnectHost("0.0.0.0"), "127.0.0.1")
})

test('getProxyConnectHost: "::" is rewritten to ::1', async () => {
  const { getProxyConnectHost } = await freshImport()
  assert.equal(getProxyConnectHost("::"), "::1")
})

test('getProxyConnectHost: "[::]" is rewritten to ::1', async () => {
  const { getProxyConnectHost } = await freshImport()
  assert.equal(getProxyConnectHost("[::]"), "::1")
})

test("getProxyConnectHost: concrete hosts pass through unchanged", async () => {
  const { getProxyConnectHost } = await freshImport()
  assert.equal(getProxyConnectHost("10.0.0.5"), "10.0.0.5")
  assert.equal(getProxyConnectHost("example.com"), "example.com")
  assert.equal(getProxyConnectHost("::1"), "::1")
})

test("getProxyBaseURL: IPv4 + numeric port", async () => {
  const { getProxyBaseURL } = await freshImport()
  assert.equal(getProxyBaseURL(3456, "127.0.0.1"), "http://127.0.0.1:3456")
})

test("getProxyBaseURL: IPv4 + string port", async () => {
  const { getProxyBaseURL } = await freshImport()
  assert.equal(getProxyBaseURL("3456", "127.0.0.1"), "http://127.0.0.1:3456")
})

test("getProxyBaseURL: IPv6 host is wrapped in brackets", async () => {
  const { getProxyBaseURL } = await freshImport()
  assert.equal(getProxyBaseURL(3456, "::1"), "http://[::1]:3456")
})

test("getProxyBaseURL: 0.0.0.0 folds to 127.0.0.1 for connections", async () => {
  const { getProxyBaseURL } = await freshImport()
  assert.equal(getProxyBaseURL(3456, "0.0.0.0"), "http://127.0.0.1:3456")
})

test("getProxyBaseURL: :: folds to [::1]", async () => {
  const { getProxyBaseURL } = await freshImport()
  assert.equal(getProxyBaseURL(3456, "::"), "http://[::1]:3456")
})
