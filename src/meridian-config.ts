/**
 * Load Meridian proxy configuration from disk so the plugin can forward
 * it to `startProxyServer({ profiles, defaultProfile })`.
 *
 * Meridian's own CLI calls `enableDiskProfileDiscovery()` before starting
 * the server, but that function is not re-exported from `@rynfar/meridian`'s
 * public entry point and its private module has a hash-suffixed filename
 * that drifts between releases. Instead we read the same files Meridian's
 * CLI reads (`~/.config/meridian/profiles.json` and `settings.json`) and
 * pass them through the supported `ProxyConfig` API.
 *
 * Precedence matches Meridian's CLI:
 *   profiles:        MERIDIAN_PROFILES env var  >  profiles.json        >  []
 *   defaultProfile:  MERIDIAN_DEFAULT_PROFILE   >  settings.activeProfile  >  undefined
 *
 * This is a leaf module — no imports from proxy.ts or index.ts.
 */

import { existsSync, readFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"

import type { LogFn } from "./logger.ts"

export type ProfileType = "claude-max" | "api"

export interface ProfileConfig {
  /** Unique profile identifier (e.g. "personal", "work") */
  id: string
  /** Auth type — "claude-max" uses CLAUDE_CONFIG_DIR, "api" uses ANTHROPIC_API_KEY */
  type?: ProfileType
  /** Path to .claude config directory (claude-max profiles) */
  claudeConfigDir?: string
  /** Anthropic API key (api profiles) */
  apiKey?: string
  /** Anthropic base URL override (api profiles) */
  baseUrl?: string
}

export interface MeridianConfigResult {
  profiles: ProfileConfig[]
  defaultProfile?: string
  sources: {
    profiles: "env" | "disk" | "none"
    defaultProfile: "env" | "disk" | "none"
  }
}

const MERIDIAN_DIR = () => join(homedir(), ".config", "meridian")
const PROFILES_FILE = () => join(MERIDIAN_DIR(), "profiles.json")
const SETTINGS_FILE = () => join(MERIDIAN_DIR(), "settings.json")

function warn(log: LogFn | undefined, message: string): void {
  void log?.("warn", `[opencode-with-claude] ${message}`)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/**
 * Accept an unknown value and return only entries that look like a
 * ProfileConfig. Drops malformed entries with a warning rather than
 * throwing — matches Meridian's own "graceful degradation" posture.
 */
function sanitizeProfiles(
  raw: unknown,
  source: string,
  log: LogFn | undefined,
): ProfileConfig[] {
  if (!Array.isArray(raw)) {
    warn(log, `${source} must be a JSON array of profile objects; got ${typeof raw}. Ignoring.`)
    return []
  }
  const out: ProfileConfig[] = []
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id) {
      warn(log, `${source}: dropping profile without a string "id" field.`)
      continue
    }
    const p: ProfileConfig = { id: entry.id }
    if (entry.type === "claude-max" || entry.type === "api") p.type = entry.type
    if (typeof entry.claudeConfigDir === "string") p.claudeConfigDir = entry.claudeConfigDir
    if (typeof entry.apiKey === "string") p.apiKey = entry.apiKey
    if (typeof entry.baseUrl === "string") p.baseUrl = entry.baseUrl
    out.push(p)
  }
  return out
}

function readJsonFile(path: string, log: LogFn | undefined): unknown {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    warn(log, `failed to parse ${path}: ${msg}`)
    return undefined
  }
}

function loadProfilesFromEnv(log: LogFn | undefined): ProfileConfig[] | undefined {
  const raw = process.env.MERIDIAN_PROFILES
  if (!raw) return undefined
  try {
    return sanitizeProfiles(JSON.parse(raw), "MERIDIAN_PROFILES", log)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    warn(log, `failed to parse MERIDIAN_PROFILES env var: ${msg}`)
    return undefined
  }
}

function loadProfilesFromDisk(log: LogFn | undefined): ProfileConfig[] {
  const raw = readJsonFile(PROFILES_FILE(), log)
  if (raw === undefined) return []
  return sanitizeProfiles(raw, PROFILES_FILE(), log)
}

function loadActiveProfileFromDisk(log: LogFn | undefined): string | undefined {
  const raw = readJsonFile(SETTINGS_FILE(), log)
  if (!isRecord(raw)) return undefined
  const active = raw.activeProfile
  if (active === undefined) return undefined
  if (typeof active !== "string" || !active) {
    warn(log, `${SETTINGS_FILE()}: "activeProfile" must be a non-empty string; ignoring.`)
    return undefined
  }
  return active
}

/**
 * Load profiles + default profile from disk/env with CLI-parity precedence.
 * Never throws; all I/O and parse errors funnel through `log`.
 */
export function loadMeridianConfig(log?: LogFn): MeridianConfigResult {
  let profiles: ProfileConfig[] = []
  let profileSource: "env" | "disk" | "none" = "none"

  const envProfiles = loadProfilesFromEnv(log)
  if (envProfiles) {
    profiles = envProfiles
    profileSource = "env"
  } else {
    const diskProfiles = loadProfilesFromDisk(log)
    if (diskProfiles.length > 0) {
      profiles = diskProfiles
      profileSource = "disk"
    }
  }

  let defaultProfile: string | undefined
  let defaultSource: "env" | "disk" | "none" = "none"

  const envDefault = process.env.MERIDIAN_DEFAULT_PROFILE?.trim()
  if (envDefault) {
    defaultProfile = envDefault
    defaultSource = "env"
  } else {
    const diskDefault = loadActiveProfileFromDisk(log)
    if (diskDefault) {
      defaultProfile = diskDefault
      defaultSource = "disk"
    }
  }

  // Validate: if we have profiles, the selected default must exist among them.
  // Otherwise the proxy would silently fall back to the first profile for the
  // wrong reason. Warn and drop the mismatched id.
  if (
    defaultProfile &&
    profiles.length > 0 &&
    !profiles.some((p) => p.id === defaultProfile)
  ) {
    warn(
      log,
      `default profile "${defaultProfile}" (from ${defaultSource}) not found among configured profiles; ignoring.`,
    )
    defaultProfile = undefined
    defaultSource = "none"
  }

  return {
    profiles,
    defaultProfile,
    sources: { profiles: profileSource, defaultProfile: defaultSource },
  }
}

/**
 * Build a short, human-readable summary of the loaded config for logging.
 * Returns `undefined` when nothing was loaded (so callers can skip the log).
 */
export function summarizeMeridianConfig(cfg: MeridianConfigResult): string | undefined {
  if (cfg.profiles.length === 0) return undefined
  const ids = cfg.profiles.map((p) => p.id).join(", ")
  const active = cfg.defaultProfile ?? cfg.profiles[0]?.id
  const profSrc = cfg.sources.profiles
  const activeSrc = cfg.sources.defaultProfile === "none" ? "first" : cfg.sources.defaultProfile
  return `loaded ${cfg.profiles.length} meridian profile(s) from ${profSrc}: ${ids} (active: ${active} [${activeSrc}])`
}
