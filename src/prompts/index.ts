import { readFileSync } from "fs"
import { homedir, platform } from "os"
import { join } from "path"

import plan from "./anthropic/plan.txt"
import build from "./anthropic/build.txt"

const prompts: Record<string, string> = { plan, build }

const getOpencodeConfigDir = () =>
  process.env.OPENCODE_CONFIG_DIR ??
  (process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : platform() === "win32" && process.env.APPDATA
      ? join(process.env.APPDATA, "opencode")
      : join(homedir(), ".config", "opencode"))

const loadAgentsPrompt = () => {
  try {
    return readFileSync(join(getOpencodeConfigDir(), "AGENTS.md"), "utf8").trim()
  } catch {
    return ""
  }
}

export const loadPrompt = (name: string): string => prompts[name] ?? prompts.build ?? ""

export const loadSystemPrompt = (name: string): string[] =>
  [loadPrompt(name), loadAgentsPrompt()].filter(Boolean)
