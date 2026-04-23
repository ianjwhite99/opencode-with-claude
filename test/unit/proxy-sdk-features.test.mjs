import assert from "node:assert/strict"
import test from "node:test"
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// Regression test: Meridian reads ~/.config/meridian/sdk-features.json lazily
// at request time, so the plugin needs no init hook to honor it. This test
// plants an overriding sdk-features.json under a fake HOME and verifies that
// the live proxy's /features endpoint reflects the overrides.

async function withFakeHome(setup) {
  const dir = mkdtempSync(join(tmpdir(), "owc-sdkfeat-"))
  const meridianDir = join(dir, ".config", "meridian")
  mkdirSync(meridianDir, { recursive: true })

  const prevHome = process.env.HOME
  const prevUserProfile = process.env.USERPROFILE
  process.env.HOME = dir
  process.env.USERPROFILE = dir

  try {
    await setup(meridianDir)
  } finally {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = prevUserProfile
    rmSync(dir, { recursive: true, force: true })
  }
}

async function freshImport(relPath) {
  return await import(`${relPath}?t=${Date.now()}${Math.random()}`)
}

test("sdk-features.json overrides surface on /features without any plugin init", async () => {
  await withFakeHome(async (meridianDir) => {
    // Override a well-known scalar we can assert on later. `memory` is a
    // boolean default so we flip it to verify the override is picked up.
    writeFileSync(
      join(meridianDir, "sdk-features.json"),
      JSON.stringify({
        opencode: {
          memory: true,
          maxBudgetUsd: 0.5,
        },
      }),
    )

    const { startProxy, getProxyBaseURL } = await freshImport("../../src/proxy.ts")
    const proxy = await startProxy({ port: 0, log: undefined })

    try {
      const res = await fetch(
        `${getProxyBaseURL(proxy.port)}/settings/api/features`,
        { signal: AbortSignal.timeout(10_000) },
      )
      assert.equal(
        res.status,
        200,
        "GET /settings/api/features should return 200",
      )
      const body = await res.json()

      assert.ok(
        body && typeof body === "object",
        "expected an adapters map in the response",
      )

      const opencode = body.opencode
      assert.ok(opencode, "expected an 'opencode' adapter entry")
      assert.equal(opencode.memory, true, "memory override should be honored")
      assert.equal(
        opencode.maxBudgetUsd,
        0.5,
        "maxBudgetUsd override should be honored",
      )
    } finally {
      await proxy.close()
    }
  })
})

test("PATCH /settings/api/features/:adapter persists to sdk-features.json", async () => {
  await withFakeHome(async (meridianDir) => {
    // Seed the same base config as the read-path test so Meridian's module-
    // level cache cannot smear unrelated state into this assertion.
    writeFileSync(
      join(meridianDir, "sdk-features.json"),
      JSON.stringify({
        opencode: {
          memory: true,
          maxBudgetUsd: 0.5,
        },
      }),
    )

    const { startProxy, getProxyBaseURL } = await freshImport("../../src/proxy.ts")
    const proxy = await startProxy({ port: 0, log: undefined })

    try {
      const baseURL = getProxyBaseURL(proxy.port)

      // Apply an override via the HTTP API.
      let res = await fetch(`${baseURL}/settings/api/features/opencode`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ memory: true, thinking: "enabled" }),
        signal: AbortSignal.timeout(10_000),
      })
      assert.equal(res.status, 200, "PATCH should return 200")
      const patchBody = await res.json()
      assert.equal(patchBody.ok, true)

      // Re-GET: the override is visible.
      res = await fetch(`${baseURL}/settings/api/features`, {
        signal: AbortSignal.timeout(10_000),
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.opencode.memory, true)
      assert.equal(body.opencode.thinking, "enabled")
      assert.equal(body.opencode.maxBudgetUsd, 0.5)

      assert.ok(
        existsSync(join(meridianDir, "sdk-features.json")),
        "PATCH should have written sdk-features.json",
      )
      const persisted = JSON.parse(
        readFileSync(join(meridianDir, "sdk-features.json"), "utf8"),
      )
      assert.deepEqual(persisted, {
        opencode: {
          memory: true,
          maxBudgetUsd: 0.5,
          thinking: "enabled",
        },
      })
    } finally {
      await proxy.close()
    }
  })
})

test("PATCH with invalid value returns 400 and does not write the file", async () => {
  await withFakeHome(async (meridianDir) => {
    const { startProxy, getProxyBaseURL } = await freshImport("../../src/proxy.ts")
    const proxy = await startProxy({ port: 0, log: undefined })

    try {
      const res = await fetch(
        `${getProxyBaseURL(proxy.port)}/settings/api/features/opencode`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ thinking: "not-a-valid-value" }),
          signal: AbortSignal.timeout(10_000),
        },
      )
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.ok(body.error, "expected an error message in the response")

      // The write should never have happened (no file, or unchanged file).
      const path = join(meridianDir, "sdk-features.json")
      if (existsSync(path)) {
        const persisted = JSON.parse(readFileSync(path, "utf8"))
        assert.equal(
          persisted.opencode?.thinking,
          undefined,
          "invalid value should not have been persisted",
        )
      }
    } finally {
      await proxy.close()
    }
  })
})
