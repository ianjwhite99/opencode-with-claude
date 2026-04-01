/**
 * Patches the claude-agent-sdk to not auto-detect Bun as the executable.
 *
 * OpenCode embeds Bun, so process.versions.bun is set — but `bun` may not
 * be in PATH. The SDK uses this check to decide whether to spawn `bun cli.js`
 * or `node cli.js`. We force it to always use node.
 */

import { readFileSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"

export function applyMeridian203Patch(): boolean {
  try {
    const sdkEntry = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"))
    const sdkPath = join(dirname(sdkEntry), "sdk.mjs")
    const content = readFileSync(sdkPath, "utf8")

    const target = "process.versions.bun!==void 0"
    if (!content.includes(target)) return false

    writeFileSync(sdkPath, content.replaceAll(target, "false"), "utf8")
    return true
  } catch {
    return false
  }
}
