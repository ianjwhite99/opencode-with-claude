import { fileURLToPath } from "node:url"

const mode = process.argv[2]
const homeDir = process.argv[3]
const targetProfile = process.argv[4]

if (!mode || !homeDir) {
  throw new Error("usage: node profile-persistence-runner.mjs <mode> <homeDir> [profileId]")
}

process.env.HOME = homeDir
process.env.USERPROFILE = homeDir

const meridianConfigModule = fileURLToPath(
  new URL("../../../src/meridian-config.ts", import.meta.url),
)
const proxyModule = fileURLToPath(
  new URL("../../../src/proxy.ts", import.meta.url),
)

const { loadMeridianConfig } = await import(meridianConfigModule)
const { startProxy, getProxyBaseURL } = await import(proxyModule)

const cfg = loadMeridianConfig()
const proxy = await startProxy({
  port: 0,
  log: undefined,
  profiles: cfg.profiles,
  defaultProfile: cfg.defaultProfile,
})

try {
  const baseURL = getProxyBaseURL(proxy.port)

  if (mode === "switch") {
    if (!targetProfile) throw new Error("switch mode requires a profile id")

    const res = await fetch(`${baseURL}/profiles/active`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: targetProfile }),
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      throw new Error(`switch failed: ${res.status} ${await res.text()}`)
    }

    const body = await res.json()
    process.stdout.write(JSON.stringify(body))
  } else if (mode === "inspect") {
    const res = await fetch(`${baseURL}/profiles/list`, {
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      throw new Error(`inspect failed: ${res.status} ${await res.text()}`)
    }

    const body = await res.json()
    process.stdout.write(JSON.stringify(body))
  } else {
    throw new Error(`unknown mode: ${mode}`)
  }
} finally {
  await proxy.close()
}
