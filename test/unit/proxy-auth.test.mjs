import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// Coverage for Meridian's MERIDIAN_API_KEY gate. When the env var is set,
// protected routes (including /profiles/list) require an x-api-key header.
// The plugin doesn't set this key itself, but we want to confirm our wrapper
// still surfaces the gate correctly so that users who configure it see the
// expected 401/200 responses.

async function withFakeHomeAndKey(setup, { apiKey }) {
  const dir = mkdtempSync(join(tmpdir(), "owc-auth-"))
  const meridianDir = join(dir, ".config", "meridian")
  mkdirSync(meridianDir, { recursive: true })

  const prev = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    MERIDIAN_API_KEY: process.env.MERIDIAN_API_KEY,
  }

  process.env.HOME = dir
  process.env.USERPROFILE = dir
  if (apiKey === undefined) delete process.env.MERIDIAN_API_KEY
  else process.env.MERIDIAN_API_KEY = apiKey

  try {
    await setup(meridianDir)
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

async function freshImport(relPath) {
  return await import(`${relPath}?t=${Date.now()}${Math.random()}`)
}

test("MERIDIAN_API_KEY set: /profiles/list without header returns 401", async () => {
  await withFakeHomeAndKey(
    async () => {
      const { startProxy, getProxyBaseURL } = await freshImport(
        "../../src/proxy.ts",
      )
      const proxy = await startProxy({ port: 0, log: undefined })

      try {
        const res = await fetch(`${getProxyBaseURL(proxy.port)}/profiles/list`, {
          signal: AbortSignal.timeout(10_000),
        })
        assert.equal(res.status, 401)
      } finally {
        await proxy.close()
      }
    },
    { apiKey: "test-secret-key" },
  )
})

test("MERIDIAN_API_KEY set: /profiles/list with correct x-api-key returns 200", async () => {
  await withFakeHomeAndKey(
    async () => {
      const { startProxy, getProxyBaseURL } = await freshImport(
        "../../src/proxy.ts",
      )
      const proxy = await startProxy({ port: 0, log: undefined })

      try {
        const res = await fetch(`${getProxyBaseURL(proxy.port)}/profiles/list`, {
          headers: { "x-api-key": "test-secret-key" },
          signal: AbortSignal.timeout(10_000),
        })
        assert.equal(res.status, 200)
      } finally {
        await proxy.close()
      }
    },
    { apiKey: "test-secret-key" },
  )
})
