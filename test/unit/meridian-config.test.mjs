import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// The module under test reads from os.homedir(). We override HOME/USERPROFILE
// for each test run so nothing escapes into the developer's real ~/.config.
async function withFakeHome(setup) {
  const dir = mkdtempSync(join(tmpdir(), "owc-meridian-"))
  const meridianDir = join(dir, ".config", "meridian")
  mkdirSync(meridianDir, { recursive: true })

  const prevHome = process.env.HOME
  const prevUserProfile = process.env.USERPROFILE
  const prevProfiles = process.env.MERIDIAN_PROFILES
  const prevDefault = process.env.MERIDIAN_DEFAULT_PROFILE

  process.env.HOME = dir
  process.env.USERPROFILE = dir
  delete process.env.MERIDIAN_PROFILES
  delete process.env.MERIDIAN_DEFAULT_PROFILE

  try {
    await setup(meridianDir)
  } finally {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = prevUserProfile
    if (prevProfiles === undefined) delete process.env.MERIDIAN_PROFILES
    else process.env.MERIDIAN_PROFILES = prevProfiles
    if (prevDefault === undefined) delete process.env.MERIDIAN_DEFAULT_PROFILE
    else process.env.MERIDIAN_DEFAULT_PROFILE = prevDefault

    rmSync(dir, { recursive: true, force: true })
  }
}

function collectLogs() {
  const entries = []
  const log = async (level, message) => {
    entries.push({ level, message })
  }
  return { log, entries }
}

// Re-import with a cache-busting query so each test observes current env/fs.
async function importLoader() {
  return await import(`../../src/meridian-config.ts?t=${Date.now()}${Math.random()}`)
}

test("loads profiles from disk when no env vars are set", async () => {
  await withFakeHome(async (meridianDir) => {
    writeFileSync(
      join(meridianDir, "profiles.json"),
      JSON.stringify([
        { id: "personal", claudeConfigDir: "/tmp/p" },
        { id: "work", claudeConfigDir: "/tmp/w" },
      ]),
    )
    writeFileSync(
      join(meridianDir, "settings.json"),
      JSON.stringify({ activeProfile: "work" }),
    )

    const { loadMeridianConfig } = await importLoader()
    const { log, entries } = collectLogs()
    const cfg = loadMeridianConfig(log)

    assert.equal(cfg.profiles.length, 2)
    assert.deepEqual(
      cfg.profiles.map((p) => p.id),
      ["personal", "work"],
    )
    assert.equal(cfg.defaultProfile, "work")
    assert.equal(cfg.sources.profiles, "disk")
    assert.equal(cfg.sources.defaultProfile, "disk")
    assert.equal(entries.length, 0, "no warnings on happy path")
  })
})

test("MERIDIAN_PROFILES env wins over profiles.json", async () => {
  await withFakeHome(async (meridianDir) => {
    writeFileSync(
      join(meridianDir, "profiles.json"),
      JSON.stringify([{ id: "disk-only" }]),
    )
    process.env.MERIDIAN_PROFILES = JSON.stringify([
      { id: "env-one", type: "api", apiKey: "xxx" },
      { id: "env-two" },
    ])

    const { loadMeridianConfig } = await importLoader()
    const cfg = loadMeridianConfig()

    assert.deepEqual(
      cfg.profiles.map((p) => p.id),
      ["env-one", "env-two"],
    )
    assert.equal(cfg.sources.profiles, "env")
  })
})

test("MERIDIAN_DEFAULT_PROFILE env wins over settings.json", async () => {
  await withFakeHome(async (meridianDir) => {
    writeFileSync(
      join(meridianDir, "profiles.json"),
      JSON.stringify([{ id: "a" }, { id: "b" }]),
    )
    writeFileSync(
      join(meridianDir, "settings.json"),
      JSON.stringify({ activeProfile: "a" }),
    )
    process.env.MERIDIAN_DEFAULT_PROFILE = "b"

    const { loadMeridianConfig } = await importLoader()
    const cfg = loadMeridianConfig()

    assert.equal(cfg.defaultProfile, "b")
    assert.equal(cfg.sources.defaultProfile, "env")
  })
})

test("malformed profiles.json is logged and does not throw", async () => {
  await withFakeHome(async (meridianDir) => {
    writeFileSync(join(meridianDir, "profiles.json"), "{not json")

    const { loadMeridianConfig } = await importLoader()
    const { log, entries } = collectLogs()
    const cfg = loadMeridianConfig(log)

    assert.deepEqual(cfg.profiles, [])
    assert.equal(cfg.defaultProfile, undefined)
    assert.equal(cfg.sources.profiles, "none")
    assert.ok(entries.some((e) => e.level === "warn"), "expected a warn log")
  })
})

test("malformed MERIDIAN_PROFILES env is logged and falls back to disk", async () => {
  await withFakeHome(async (meridianDir) => {
    writeFileSync(
      join(meridianDir, "profiles.json"),
      JSON.stringify([{ id: "disk" }]),
    )
    process.env.MERIDIAN_PROFILES = "not valid json"

    const { loadMeridianConfig } = await importLoader()
    const { log, entries } = collectLogs()
    const cfg = loadMeridianConfig(log)

    assert.deepEqual(
      cfg.profiles.map((p) => p.id),
      ["disk"],
    )
    assert.equal(cfg.sources.profiles, "disk")
    assert.ok(
      entries.some((e) => e.message.includes("MERIDIAN_PROFILES")),
      "expected a warn referencing MERIDIAN_PROFILES",
    )
  })
})

test("activeProfile not in profiles drops defaultProfile with a warn", async () => {
  await withFakeHome(async (meridianDir) => {
    writeFileSync(
      join(meridianDir, "profiles.json"),
      JSON.stringify([{ id: "only-one" }]),
    )
    writeFileSync(
      join(meridianDir, "settings.json"),
      JSON.stringify({ activeProfile: "does-not-exist" }),
    )

    const { loadMeridianConfig } = await importLoader()
    const { log, entries } = collectLogs()
    const cfg = loadMeridianConfig(log)

    assert.equal(cfg.profiles.length, 1)
    assert.equal(cfg.defaultProfile, undefined)
    assert.equal(cfg.sources.defaultProfile, "none")
    assert.ok(
      entries.some((e) => e.message.includes("does-not-exist")),
      "expected a warn naming the missing profile",
    )
  })
})

test("profile entries without a string id are dropped with a warn", async () => {
  await withFakeHome(async (meridianDir) => {
    writeFileSync(
      join(meridianDir, "profiles.json"),
      JSON.stringify([{ id: "good" }, { claudeConfigDir: "/tmp/bad" }, null]),
    )

    const { loadMeridianConfig } = await importLoader()
    const { log, entries } = collectLogs()
    const cfg = loadMeridianConfig(log)

    assert.deepEqual(
      cfg.profiles.map((p) => p.id),
      ["good"],
    )
    assert.ok(entries.filter((e) => e.level === "warn").length >= 1)
  })
})

test("missing config files return empty config with no warnings", async () => {
  await withFakeHome(async () => {
    const { loadMeridianConfig } = await importLoader()
    const { log, entries } = collectLogs()
    const cfg = loadMeridianConfig(log)

    assert.deepEqual(cfg.profiles, [])
    assert.equal(cfg.defaultProfile, undefined)
    assert.equal(cfg.sources.profiles, "none")
    assert.equal(cfg.sources.defaultProfile, "none")
    assert.equal(entries.length, 0)
  })
})

test("summarizeMeridianConfig formats a useful log line", async () => {
  await withFakeHome(async (meridianDir) => {
    writeFileSync(
      join(meridianDir, "profiles.json"),
      JSON.stringify([{ id: "a" }, { id: "b" }]),
    )
    writeFileSync(
      join(meridianDir, "settings.json"),
      JSON.stringify({ activeProfile: "b" }),
    )

    const { loadMeridianConfig, summarizeMeridianConfig } = await importLoader()
    const cfg = loadMeridianConfig()
    const line = summarizeMeridianConfig(cfg)

    assert.ok(line, "expected a summary string")
    assert.match(line, /loaded 2 meridian profile/i)
    assert.match(line, /\ba, b\b/)
    assert.match(line, /active: b/)
  })
})

test("summarizeMeridianConfig returns undefined when nothing is loaded", async () => {
  await withFakeHome(async () => {
    const { loadMeridianConfig, summarizeMeridianConfig } = await importLoader()
    const cfg = loadMeridianConfig()
    assert.equal(summarizeMeridianConfig(cfg), undefined)
  })
})

// -----------------------------------------------------------------------------
// Edge cases added for coverage tier 1
// -----------------------------------------------------------------------------

test("API profile round-trips type, apiKey, baseUrl", async () => {
  await withFakeHome(async (meridianDir) => {
    writeFileSync(
      join(meridianDir, "profiles.json"),
      JSON.stringify([
        {
          id: "direct-api",
          type: "api",
          apiKey: "sk-ant-x",
          baseUrl: "https://api.example.com",
        },
      ]),
    )

    const { loadMeridianConfig } = await importLoader()
    const cfg = loadMeridianConfig()
    assert.equal(cfg.profiles.length, 1)
    assert.deepEqual(cfg.profiles[0], {
      id: "direct-api",
      type: "api",
      apiKey: "sk-ant-x",
      baseUrl: "https://api.example.com",
    })
  })
})

test("unknown profile type is stripped but profile is kept", async () => {
  await withFakeHome(async (meridianDir) => {
    writeFileSync(
      join(meridianDir, "profiles.json"),
      JSON.stringify([
        { id: "weird", type: "something-else", claudeConfigDir: "/tmp/w" },
      ]),
    )

    const { loadMeridianConfig } = await importLoader()
    const cfg = loadMeridianConfig()
    assert.equal(cfg.profiles.length, 1)
    assert.equal(cfg.profiles[0].id, "weird")
    assert.equal(cfg.profiles[0].type, undefined, "unknown type should be stripped")
    assert.equal(cfg.profiles[0].claudeConfigDir, "/tmp/w")
  })
})

test("non-string scalar fields are dropped while the profile survives", async () => {
  await withFakeHome(async (meridianDir) => {
    writeFileSync(
      join(meridianDir, "profiles.json"),
      JSON.stringify([
        {
          id: "mixed",
          claudeConfigDir: 42,
          apiKey: null,
          baseUrl: { bogus: true },
        },
      ]),
    )

    const { loadMeridianConfig } = await importLoader()
    const cfg = loadMeridianConfig()
    assert.equal(cfg.profiles.length, 1)
    assert.deepEqual(cfg.profiles[0], { id: "mixed" })
  })
})

test("unknown top-level profile fields do not leak through", async () => {
  await withFakeHome(async (meridianDir) => {
    writeFileSync(
      join(meridianDir, "profiles.json"),
      JSON.stringify([
        {
          id: "a",
          extraField: "nope",
          metadata: { anything: true },
          claudeConfigDir: "/tmp/a",
        },
      ]),
    )

    const { loadMeridianConfig } = await importLoader()
    const cfg = loadMeridianConfig()
    assert.equal(cfg.profiles.length, 1)
    assert.deepEqual(Object.keys(cfg.profiles[0]).sort(), [
      "claudeConfigDir",
      "id",
    ])
  })
})

test("MERIDIAN_PROFILES=\"\" is treated as unset and disk is consulted", async () => {
  await withFakeHome(async (meridianDir) => {
    writeFileSync(
      join(meridianDir, "profiles.json"),
      JSON.stringify([{ id: "from-disk" }]),
    )
    process.env.MERIDIAN_PROFILES = ""

    const { loadMeridianConfig } = await importLoader()
    const cfg = loadMeridianConfig()
    assert.deepEqual(
      cfg.profiles.map((p) => p.id),
      ["from-disk"],
    )
    assert.equal(cfg.sources.profiles, "disk")
  })
})

test('MERIDIAN_PROFILES="[]" wins and prevents disk fallback (CLI parity)', async () => {
  await withFakeHome(async (meridianDir) => {
    writeFileSync(
      join(meridianDir, "profiles.json"),
      JSON.stringify([{ id: "disk-only" }]),
    )
    process.env.MERIDIAN_PROFILES = "[]"

    const { loadMeridianConfig } = await importLoader()
    const cfg = loadMeridianConfig()
    assert.deepEqual(cfg.profiles, [])
    assert.equal(
      cfg.sources.profiles,
      "env",
      "empty env array should still be tagged as env source",
    )
  })
})

test('MERIDIAN_PROFILES="{}" (object, not array) logs a warn and is still env-sourced', async () => {
  await withFakeHome(async (meridianDir) => {
    writeFileSync(
      join(meridianDir, "profiles.json"),
      JSON.stringify([{ id: "disk-only" }]),
    )
    process.env.MERIDIAN_PROFILES = "{}"

    const { loadMeridianConfig } = await importLoader()
    const { log, entries } = collectLogs()
    const cfg = loadMeridianConfig(log)
    assert.deepEqual(cfg.profiles, [])
    assert.equal(cfg.sources.profiles, "env")
    assert.ok(
      entries.some(
        (e) => e.level === "warn" && e.message.includes("MERIDIAN_PROFILES"),
      ),
      "expected a warn naming MERIDIAN_PROFILES",
    )
  })
})

test("MERIDIAN_DEFAULT_PROFILE=whitespace is treated as unset", async () => {
  await withFakeHome(async (meridianDir) => {
    writeFileSync(
      join(meridianDir, "profiles.json"),
      JSON.stringify([{ id: "a" }, { id: "b" }]),
    )
    writeFileSync(
      join(meridianDir, "settings.json"),
      JSON.stringify({ activeProfile: "a" }),
    )
    process.env.MERIDIAN_DEFAULT_PROFILE = "   "

    const { loadMeridianConfig } = await importLoader()
    const cfg = loadMeridianConfig()
    assert.equal(cfg.defaultProfile, "a", "should fall through to settings.json")
    assert.equal(cfg.sources.defaultProfile, "disk")
  })
})

test("settings.json with non-object / non-string / empty-string activeProfile", async (t) => {
  await t.test("settings.json as a top-level array is silently ignored", async () => {
    await withFakeHome(async (meridianDir) => {
      writeFileSync(
        join(meridianDir, "profiles.json"),
        JSON.stringify([{ id: "a" }]),
      )
      writeFileSync(join(meridianDir, "settings.json"), JSON.stringify([]))

      const { loadMeridianConfig } = await importLoader()
      const { log, entries } = collectLogs()
      const cfg = loadMeridianConfig(log)
      assert.equal(cfg.defaultProfile, undefined)
      assert.equal(
        entries.length,
        0,
        "unexpected shape should be silent, not warn",
      )
    })
  })

  await t.test("activeProfile=42 (non-string) warns and returns undefined", async () => {
    await withFakeHome(async (meridianDir) => {
      writeFileSync(
        join(meridianDir, "profiles.json"),
        JSON.stringify([{ id: "a" }]),
      )
      writeFileSync(
        join(meridianDir, "settings.json"),
        JSON.stringify({ activeProfile: 42 }),
      )

      const { loadMeridianConfig } = await importLoader()
      const { log, entries } = collectLogs()
      const cfg = loadMeridianConfig(log)
      assert.equal(cfg.defaultProfile, undefined)
      assert.ok(
        entries.some(
          (e) => e.level === "warn" && e.message.includes("activeProfile"),
        ),
        "expected a warn about activeProfile shape",
      )
    })
  })

  await t.test('activeProfile="" (empty string) warns and returns undefined', async () => {
    await withFakeHome(async (meridianDir) => {
      writeFileSync(
        join(meridianDir, "profiles.json"),
        JSON.stringify([{ id: "a" }]),
      )
      writeFileSync(
        join(meridianDir, "settings.json"),
        JSON.stringify({ activeProfile: "" }),
      )

      const { loadMeridianConfig } = await importLoader()
      const { log, entries } = collectLogs()
      const cfg = loadMeridianConfig(log)
      assert.equal(cfg.defaultProfile, undefined)
      assert.ok(
        entries.some((e) => e.level === "warn"),
        "expected a warn",
      )
    })
  })
})
