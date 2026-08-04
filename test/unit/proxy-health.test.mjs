import assert from "node:assert/strict"
import test from "node:test"
import { createServer } from "node:http"
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

function installedMeridianVersion() {
  const manifest = join(REPO_ROOT, "node_modules", "@rynfar", "meridian", "package.json")
  return JSON.parse(readFileSync(manifest, "utf8")).version
}

// Coverage for the metadata checkProxyHealth reads off Meridian's /health:
// the embedded version and the login-renewal fields Meridian added in 1.58.0.
// Each case serves a crafted payload from a stub server, so the assertions
// depend on neither a real Claude login nor the installed Meridian version —
// including the pre-1.58.0 payload shape, which no installed version emits.

async function freshImport() {
  return await import(`../../src/proxy.ts?t=${Date.now()}${Math.random()}`)
}

async function withStubHealth({ payload, status = 200 }, assertions) {
  const server = createServer((req, res) => {
    if (!req.url?.startsWith("/health")) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(payload))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))

  // The helper resolves the URL through getProxyHost(), so a host override in
  // the developer's shell would point the check away from the stub.
  const prev = {
    MERIDIAN_HOST: process.env.MERIDIAN_HOST,
    CLAUDE_PROXY_HOST: process.env.CLAUDE_PROXY_HOST,
  }
  delete process.env.MERIDIAN_HOST
  delete process.env.CLAUDE_PROXY_HOST

  const logs = []
  try {
    const { checkProxyHealth } = await freshImport()
    const result = await checkProxyHealth(server.address().port, async (level, message) => {
      logs.push({ level, message })
    })
    await assertions({ result, logs })
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await new Promise((resolve) => server.close(resolve))
  }
}

function findLog(logs, level, substring) {
  return logs.find((l) => l.level === level && l.message.includes(substring))
}

const healthy = (auth = { loggedIn: true }, extra = {}) => ({
  status: "healthy",
  version: "1.60.0",
  auth,
  mode: "passthrough",
  ...extra,
})

test("healthy: logs the Meridian version and returns it", async () => {
  await withStubHealth({ payload: healthy() }, ({ result, logs }) => {
    assert.equal(result.ok, true)
    assert.equal(result.version, "1.60.0")
    assert.ok(findLog(logs, "info", "meridian 1.60.0"))
  })
})

test("healthy: Meridian's \"unknown\" placeholder is not reported as a version", async () => {
  await withStubHealth({ payload: healthy({ loggedIn: true }, { version: "unknown" }) }, ({ result, logs }) => {
    assert.equal(result.version, undefined)
    assert.equal(findLog(logs, "info", "meridian "), undefined)
  })
})

test("healthy: a payload without a version logs nothing about the version", async () => {
  const payload = healthy()
  delete payload.version

  await withStubHealth({ payload }, ({ result, logs }) => {
    assert.equal(result.ok, true)
    assert.equal(result.version, undefined)
    assert.equal(findLog(logs, "info", "meridian "), undefined)
  })
})

test("renewalRequiredSoon: warns with the day count and the fix", async () => {
  const payload = healthy({
    loggedIn: true,
    daysUntilRenewal: 3,
    renewalRequiredSoon: true,
  })

  await withStubHealth({ payload }, ({ result, logs }) => {
    assert.equal(result.ok, true)
    assert.equal(result.daysUntilRenewal, 3)
    assert.equal(result.renewalRequiredSoon, true)

    const warning = findLog(logs, "warn", "expires in 3 days")
    assert.ok(warning, "expected a warning naming the remaining days")
    assert.ok(warning.message.includes("claude login"))
  })
})

test("renewalRequiredSoon: one day reads as singular", async () => {
  const payload = healthy({
    loggedIn: true,
    daysUntilRenewal: 1,
    renewalRequiredSoon: true,
  })

  await withStubHealth({ payload }, ({ logs }) => {
    assert.ok(findLog(logs, "warn", "expires in 1 day."))
  })
})

test("renewalRequiredSoon: a non-positive day count reads as today", async () => {
  const payload = healthy({
    loggedIn: true,
    daysUntilRenewal: 0,
    renewalRequiredSoon: true,
  })

  await withStubHealth({ payload }, ({ logs }) => {
    assert.ok(findLog(logs, "warn", "expires today"))
  })
})

test("renewalRequiredSoon false: no warning, flag still reported", async () => {
  const payload = healthy({
    loggedIn: true,
    daysUntilRenewal: 20,
    renewalRequiredSoon: false,
  })

  await withStubHealth({ payload }, ({ result, logs }) => {
    assert.equal(result.renewalRequiredSoon, false)
    assert.equal(result.daysUntilRenewal, 20)
    assert.equal(
      logs.find((l) => l.level === "warn"),
      undefined,
    )
  })
})

test("Meridian without the renewal fields: no warning, nothing invented", async () => {
  const payload = healthy({
    loggedIn: true,
    email: "user@example.com",
    subscriptionType: "max",
  })

  await withStubHealth({ payload }, ({ result, logs }) => {
    assert.equal(result.ok, true)
    assert.equal(result.renewalRequiredSoon, undefined)
    assert.equal(result.daysUntilRenewal, undefined)
    assert.equal(
      logs.find((l) => l.level === "warn"),
      undefined,
    )
  })
})

test("a malformed auth field is ignored rather than trusted", async () => {
  const payload = healthy({
    loggedIn: true,
    daysUntilRenewal: "soon",
    renewalRequiredSoon: "yes",
  })

  await withStubHealth({ payload }, ({ result, logs }) => {
    assert.equal(result.daysUntilRenewal, undefined)
    assert.equal(result.renewalRequiredSoon, undefined)
    assert.equal(
      logs.find((l) => l.level === "warn"),
      undefined,
    )
  })
})

test("degraded: still reports the version and stays usable", async () => {
  const payload = {
    status: "degraded",
    version: "1.60.0",
    error: "Could not verify auth status",
    mode: "passthrough",
  }

  await withStubHealth({ payload }, ({ result, logs }) => {
    assert.equal(result.ok, true)
    assert.equal(result.version, "1.60.0")
    assert.equal(result.message, "Could not verify auth status")
    assert.ok(findLog(logs, "info", "meridian 1.60.0"))
    assert.ok(findLog(logs, "warn", "Could not verify auth status"))
  })
})

test("unhealthy: not ok, version still reported", async () => {
  const payload = {
    status: "unhealthy",
    version: "1.60.0",
    error: "Not logged in. Run: claude login",
    auth: { loggedIn: false },
  }

  await withStubHealth({ payload, status: 503 }, ({ result, logs }) => {
    assert.equal(result.ok, false)
    assert.equal(result.version, "1.60.0")
    assert.ok(findLog(logs, "error", "Not logged in"))
  })
})

test("resolveMeridianVersion: reports the installed package's version", async () => {
  const { resolveMeridianVersion } = await freshImport()
  assert.equal(resolveMeridianVersion(), installedMeridianVersion())
})

// Meridian only reports a version on /health if the embedding host supplies
// one, so assert against a live proxy rather than a stub: this is the wiring
// that decides whether real users see a version or "unknown". Only the version
// is asserted — auth status varies by machine, and every /health branch carries
// the field.
test("startProxy: a live proxy reports the real version on /health", async () => {
  const home = mkdtempSync(join(tmpdir(), "owc-health-"))
  mkdirSync(join(home, ".config", "meridian"), { recursive: true })
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home

  try {
    const { startProxy, getProxyBaseURL } = await freshImport()
    const proxy = await startProxy({ port: 0, log: undefined })
    try {
      const res = await fetch(`${getProxyBaseURL(proxy.port)}/health`, {
        signal: AbortSignal.timeout(30_000),
      })
      const body = await res.json()
      assert.equal(body.version, installedMeridianVersion())
    } finally {
      await proxy.close()
    }
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(home, { recursive: true, force: true })
  }
})
