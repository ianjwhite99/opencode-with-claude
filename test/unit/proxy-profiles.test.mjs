import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import test from "node:test"
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs"
import { fileURLToPath } from "node:url"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

// Integration test: start the proxy via our wrapper with profiles loaded from
// a fake ~/.config/meridian, then verify the live /profiles endpoint serves
// them. Directly reproduces the issue #99 user scenario end-to-end.

async function withFakeHome(setup) {
  const dir = mkdtempSync(join(tmpdir(), "owc-proxy-"))
  const meridianDir = join(dir, ".config", "meridian")
  mkdirSync(meridianDir, { recursive: true })

  const prev = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    MERIDIAN_PROFILES: process.env.MERIDIAN_PROFILES,
    MERIDIAN_DEFAULT_PROFILE: process.env.MERIDIAN_DEFAULT_PROFILE,
  }

  process.env.HOME = dir
  process.env.USERPROFILE = dir
  delete process.env.MERIDIAN_PROFILES
  delete process.env.MERIDIAN_DEFAULT_PROFILE

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

const profileRunnerPath = fileURLToPath(
  new URL("./helpers/profile-persistence-runner.mjs", import.meta.url),
)

async function runProfilePersistenceHelper(mode, homeDir, profileId) {
  return await new Promise((resolvePromise, reject) => {
    const args = [
      "--experimental-strip-types",
      profileRunnerPath,
      mode,
      homeDir,
    ]
    if (profileId) args.push(profileId)

    const child = spawn(process.execPath, args, {
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })

    child.on("error", reject)
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `profile helper failed (${mode}, exit ${code})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        )
        return
      }

      try {
        resolvePromise(JSON.parse(stdout || "{}"))
      } catch (err) {
        reject(
          new Error(
            `profile helper returned invalid JSON (${mode})\nstdout:\n${stdout}\nstderr:\n${stderr}\nerror: ${err}`,
          ),
        )
      }
    })
  })
}

test("live proxy /profiles reflects disk profiles and active selection", async () => {
  await withFakeHome(async (meridianDir) => {
    writeFileSync(
      join(meridianDir, "profiles.json"),
      JSON.stringify([
        { id: "personal", claudeConfigDir: join(meridianDir, "profiles", "personal") },
        { id: "work", claudeConfigDir: join(meridianDir, "profiles", "work") },
      ]),
    )
    writeFileSync(
      join(meridianDir, "settings.json"),
      JSON.stringify({ activeProfile: "work" }),
    )

    const { loadMeridianConfig } = await freshImport("../../src/meridian-config.ts")
    const { startProxy, getProxyBaseURL } = await freshImport("../../src/proxy.ts")

    const cfg = loadMeridianConfig()
    const proxy = await startProxy({
      port: 0,
      log: undefined,
      profiles: cfg.profiles,
      defaultProfile: cfg.defaultProfile,
    })

    try {
      const res = await fetch(`${getProxyBaseURL(proxy.port)}/profiles/list`, {
        signal: AbortSignal.timeout(10_000),
      })
      assert.equal(res.status, 200, "GET /profiles/list should return 200")
      const body = await res.json()

      assert.ok(Array.isArray(body.profiles), "expected profiles array")
      const ids = body.profiles.map((p) => p.id).sort()
      assert.deepEqual(ids, ["personal", "work"])
      assert.equal(body.activeProfile, "work")
    } finally {
      await proxy.close()
    }
  })
})

test("POST /profiles/active updates the active profile for subsequent requests", async () => {
  await withFakeHome(async (meridianDir) => {
    writeFileSync(
      join(meridianDir, "profiles.json"),
      JSON.stringify([{ id: "personal" }, { id: "work" }]),
    )
    writeFileSync(
      join(meridianDir, "settings.json"),
      JSON.stringify({ activeProfile: "personal" }),
    )

    const { loadMeridianConfig } = await freshImport("../../src/meridian-config.ts")
    const { startProxy, getProxyBaseURL } = await freshImport("../../src/proxy.ts")

    const cfg = loadMeridianConfig()
    const proxy = await startProxy({
      port: 0,
      log: undefined,
      profiles: cfg.profiles,
      defaultProfile: cfg.defaultProfile,
    })

    try {
      const baseURL = getProxyBaseURL(proxy.port)

      // Initial: personal is active.
      let res = await fetch(`${baseURL}/profiles/list`, {
        signal: AbortSignal.timeout(10_000),
      })
      let body = await res.json()
      assert.equal(body.activeProfile, "personal")

      // Flip to work.
      res = await fetch(`${baseURL}/profiles/active`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile: "work" }),
        signal: AbortSignal.timeout(10_000),
      })
      assert.equal(res.status, 200, "POST /profiles/active should return 200")
      body = await res.json()
      assert.equal(body.success, true)
      assert.equal(body.activeProfile, "work")

      // Re-fetch: the list reflects the new active profile.
      res = await fetch(`${baseURL}/profiles/list`, {
        signal: AbortSignal.timeout(10_000),
      })
      body = await res.json()
      assert.equal(body.activeProfile, "work")
      assert.ok(
        body.profiles.find((p) => p.id === "work")?.isActive,
        "work profile should be flagged as isActive",
      )

      // Meridian captures its settings path at module-load time, so asserting
      // on-disk persistence inside this shared test process is brittle across
      // the wider suite. The observable API behavior after switching is the
      // important contract for this wrapper-level regression test.
    } finally {
      await proxy.close()
    }
  })
})

test("POST /profiles/active survives restart and is read on next startup", async () => {
  await withFakeHome(async (meridianDir) => {
    writeFileSync(
      join(meridianDir, "profiles.json"),
      JSON.stringify([{ id: "personal" }, { id: "work" }]),
    )
    writeFileSync(
      join(meridianDir, "settings.json"),
      JSON.stringify({ activeProfile: "personal" }),
    )

    const homeDir = resolve(meridianDir, "..", "..")

    const before = await runProfilePersistenceHelper("inspect", homeDir)
    assert.equal(before.activeProfile, "personal")

    const switched = await runProfilePersistenceHelper("switch", homeDir, "work")
    assert.equal(switched.success, true)
    assert.equal(switched.activeProfile, "work")

    const after = await runProfilePersistenceHelper("inspect", homeDir)
    assert.equal(
      after.activeProfile,
      "work",
      "fresh startup should restore the switched profile from settings.json",
    )
    assert.ok(
      after.profiles.find((p) => p.id === "work")?.isActive,
      "work should still be the active profile after restart",
    )
  })
})

test("POST /profiles/active with an unknown id returns 400", async () => {
  await withFakeHome(async (meridianDir) => {
    writeFileSync(
      join(meridianDir, "profiles.json"),
      JSON.stringify([{ id: "only" }]),
    )

    const { loadMeridianConfig } = await freshImport("../../src/meridian-config.ts")
    const { startProxy, getProxyBaseURL } = await freshImport("../../src/proxy.ts")

    const cfg = loadMeridianConfig()
    const proxy = await startProxy({
      port: 0,
      log: undefined,
      profiles: cfg.profiles,
      defaultProfile: cfg.defaultProfile,
    })

    try {
      const res = await fetch(`${getProxyBaseURL(proxy.port)}/profiles/active`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile: "does-not-exist" }),
        signal: AbortSignal.timeout(10_000),
      })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(body.error, /Unknown profile/i)
    } finally {
      await proxy.close()
    }
  })
})

test("live proxy with no disk config reports no profiles", async () => {
  await withFakeHome(async () => {
    const { loadMeridianConfig } = await freshImport("../../src/meridian-config.ts")
    const { startProxy, getProxyBaseURL } = await freshImport("../../src/proxy.ts")

    const cfg = loadMeridianConfig()
    assert.equal(cfg.profiles.length, 0)

    const proxy = await startProxy({
      port: 0,
      log: undefined,
      profiles: cfg.profiles,
      defaultProfile: cfg.defaultProfile,
    })

    try {
      const res = await fetch(`${getProxyBaseURL(proxy.port)}/profiles/list`, {
        signal: AbortSignal.timeout(10_000),
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.deepEqual(body.profiles, [])
    } finally {
      await proxy.close()
    }
  })
})
