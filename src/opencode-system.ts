import { existsSync, readFileSync } from "fs"
import { homedir, platform } from "os"
import { dirname, join, resolve } from "path"

const AGENTS_FILENAMES = ["AGENTS.md", "Agents.md", "agents.md"]

const getOpenCodeConfigDir = () =>
  process.env.OPENCODE_CONFIG_DIR ??
  (process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : platform() === "win32" && process.env.APPDATA
      ? join(process.env.APPDATA, "opencode")
      : join(homedir(), ".config", "opencode"))

function readAgentsPrompt(dir: string | undefined): string | undefined {
  if (!dir) return undefined
  for (const filename of AGENTS_FILENAMES) {
    const path = join(dir, filename)
    try {
      if (!existsSync(path)) continue
      const prompt = readFileSync(path, "utf8").trim()
      if (prompt) return prompt
    } catch {
      return undefined
    }
  }
}

function extractEnvBlock(system: string[]): string | undefined {
  const match = system.join("\n\n").match(/<env>[\s\S]*?<\/env>/i)
  return match?.[0]?.trim()
}

function extractWorkingDirectory(envBlock: string | undefined): string | undefined {
  const match = envBlock?.match(/Working directory:\s*([^\n<]+)/i)
  return match?.[1]?.trim()
}

function uniqueDefined(values: Array<string | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

function readLocalAgentsPrompt(start: string | undefined): string | undefined {
  let dir = resolve(start ?? process.cwd())
  while (true) {
    const prompt = readAgentsPrompt(dir)
    if (prompt) return prompt

    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function loadAgentsPrompts(workingDirectory: string | undefined): string[] {
  return uniqueDefined([
    readLocalAgentsPrompt(workingDirectory),
    readAgentsPrompt(getOpenCodeConfigDir()),
  ])
}

export function buildStrippedOpenCodeSystem(system: string[]): string[] {
  const envBlock =
    extractEnvBlock(system) ?? `<env>\nWorking directory: ${process.cwd()}\n</env>`
  const workingDirectory = extractWorkingDirectory(envBlock)
  return [envBlock, ...loadAgentsPrompts(workingDirectory)]
}
