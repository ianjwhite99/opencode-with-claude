/**
 * Temporary patch for https://github.com/rynfar/meridian/issues/203
 *
 * Meridian's buildQueryOptions() hardcodes `permissionMode: "bypassPermissions"`
 * and `allowDangerouslySkipPermissions: true` on every SDK query() call. On
 * certain Claude CLI versions this causes the subprocess to exit with code 1,
 * surfacing as a misleading "authentication_error".
 *
 * This module patches the bundled meridian JS at runtime — before the module is
 * imported — to strip those two properties from the query options.
 *
 * REMOVAL: once the upstream issue is resolved, delete this file, remove the
 * applyMeridian203Patch() call from proxy.ts, and restore the static import.
 */

import { readFileSync, writeFileSync, readdirSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"

const PATCH_MARKER = "/* patched: meridian#203 */"

export function applyMeridian203Patch(): boolean {
  let meridianDist: string
  try {
    const meridianEntry = fileURLToPath(
      import.meta.resolve("@rynfar/meridian")
    )
    meridianDist = dirname(meridianEntry)
  } catch {
    return false
  }

  // Find the main bundle that contains buildQueryOptions
  let bundlePath: string | null = null
  let content: string | null = null

  for (const file of readdirSync(meridianDist)) {
    if (!file.endsWith(".js") || file === "server.js" || file === "cli.js")
      continue
    const path = join(meridianDist, file)
    const text = readFileSync(path, "utf8")
    if (text.includes("buildQueryOptions")) {
      bundlePath = path
      content = text
      break
    }
  }

  if (!bundlePath || !content) return false
  if (content.includes(PATCH_MARKER)) return true // already patched

  const target = "function buildQueryOptions(ctx) {"
  if (!content.includes(target)) return false

  const patched = content.replace(
    target,
    `${PATCH_MARKER}
function buildQueryOptions(ctx) {
  var _r = _buildQueryOptions_orig(ctx);
  delete _r.options.permissionMode;
  delete _r.options.allowDangerouslySkipPermissions;
  return _r;
}
function _buildQueryOptions_orig(ctx) {`
  )

  writeFileSync(bundlePath, patched, "utf8")
  return true
}
