import { spawnSync } from "child_process"
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  linkSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from "fs"
import { createRequire } from "module"
import { arch as osArch } from "os"
import { dirname, join } from "path"

import type { LogFn } from "./logger.ts"

const CLAUDE_CODE_PACKAGE = "@anthropic-ai/claude-code"
const SUPPORTED_ARCHES = new Set(["x64", "arm64"])

export type ClaudeLauncherRepairResult =
  | {
      status: "already-native" | "repaired"
      launcherPath: string
      nativePath: string
      nativePackage: string
    }
  | {
      status: "skipped"
      reason:
        | "wrapper-not-found"
        | "launcher-not-found"
        | "unsupported-platform"
        | "native-not-found"
      launcherPath?: string
      nativePackages?: string[]
    }
  | {
      status: "failed"
      reason: string
      launcherPath?: string
      nativePath?: string
    }

export interface ClaudeLauncherRepairOptions {
  platform?: NodeJS.Platform
  arch?: string
  isMusl?: boolean
  isRosetta?: boolean
  resolvePackageJson?: (packageName: string) => string | undefined
}

function tryResolve(
  resolve: NodeJS.RequireResolve,
  request: string,
): string | undefined {
  try {
    return resolve(request)
  } catch {
    return undefined
  }
}

function createPackageJsonResolver(): (packageName: string) => string | undefined {
  const localRequire = createRequire(import.meta.url)
  const resolvers: NodeJS.RequireResolve[] = []
  const meridianEntry = tryResolve(localRequire.resolve, "@rynfar/meridian")

  if (meridianEntry) {
    resolvers.push(createRequire(meridianEntry).resolve)
  }
  resolvers.push(localRequire.resolve)

  return (packageName) => {
    const request = `${packageName}/package.json`
    for (const resolve of resolvers) {
      const resolved = tryResolve(resolve, request)
      if (resolved) return resolved
    }
    return undefined
  }
}

function detectMusl(platform = process.platform): boolean {
  if (platform !== "linux") return false
  const report =
    typeof process.report?.getReport === "function"
      ? process.report.getReport()
      : null
  return report !== null && report.header?.glibcVersionRuntime === undefined
}

function detectRosetta(platform = process.platform, arch = osArch()): boolean {
  if (platform !== "darwin" || arch !== "x64") return false
  const result = spawnSync("sysctl", ["-n", "sysctl.proc_translated"], {
    encoding: "utf8",
  })
  return result.stdout?.trim() === "1"
}

export function getClaudeCodeNativePackageCandidates(
  platform: NodeJS.Platform,
  arch: string,
  options: { isMusl?: boolean; isRosetta?: boolean } = {},
): string[] {
  if (!SUPPORTED_ARCHES.has(arch)) return []

  if (platform === "linux") {
    return [
      `${CLAUDE_CODE_PACKAGE}-linux-${arch}${options.isMusl ? "-musl" : ""}`,
    ]
  }

  if (platform === "darwin") {
    const nativeArch = arch === "x64" && options.isRosetta ? "arm64" : arch
    const packages = [`${CLAUDE_CODE_PACKAGE}-darwin-${nativeArch}`]
    if (nativeArch !== arch) packages.push(`${CLAUDE_CODE_PACKAGE}-darwin-${arch}`)
    return packages
  }

  if (platform === "win32") {
    return [`${CLAUDE_CODE_PACKAGE}-win32-${arch}`]
  }

  return []
}

function nativeBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "claude.exe" : "claude"
}

function readMagic(filePath: string): Buffer {
  const fd = openSync(filePath, "r")
  try {
    const buffer = Buffer.alloc(4)
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    closeSync(fd)
  }
}

function hasMagic(buffer: Buffer, bytes: number[]): boolean {
  return bytes.every((byte, index) => buffer[index] === byte)
}

function looksNativeExecutable(
  filePath: string,
  platform: NodeJS.Platform,
): boolean {
  try {
    const magic = readMagic(filePath)
    if (platform === "linux") return hasMagic(magic, [0x7f, 0x45, 0x4c, 0x46])
    if (platform === "win32") return hasMagic(magic, [0x4d, 0x5a])
    if (platform !== "darwin") return false

    return [
      [0xfe, 0xed, 0xfa, 0xce],
      [0xce, 0xfa, 0xed, 0xfe],
      [0xfe, 0xed, 0xfa, 0xcf],
      [0xcf, 0xfa, 0xed, 0xfe],
      [0xca, 0xfe, 0xba, 0xbe],
      [0xbe, 0xba, 0xfe, 0xca],
    ].some((bytes) => hasMagic(magic, bytes))
  } catch {
    return false
  }
}

function ensureExecutable(filePath: string, platform: NodeJS.Platform): void {
  if (platform === "win32") return
  const mode = statSync(filePath).mode
  if ((mode & 0o111) === 0) chmodSync(filePath, 0o755)
}

function replaceLauncher(
  launcherPath: string,
  nativePath: string,
  platform: NodeJS.Platform,
): void {
  const tempPath = join(
    dirname(launcherPath),
    `.claude-launcher-${process.pid}-${Date.now()}.tmp`,
  )

  rmSync(tempPath, { force: true })
  try {
    try {
      linkSync(nativePath, tempPath)
    } catch {
      copyFileSync(nativePath, tempPath)
    }
    ensureExecutable(tempPath, platform)
    renameSync(tempPath, launcherPath)
  } finally {
    rmSync(tempPath, { force: true })
  }
}

export function repairClaudeCodeLauncherForRuntime(
  options: ClaudeLauncherRepairOptions = {},
): ClaudeLauncherRepairResult {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? osArch()
  const resolvePackageJson =
    options.resolvePackageJson ?? createPackageJsonResolver()
  const wrapperPackageJson = resolvePackageJson(CLAUDE_CODE_PACKAGE)

  if (!wrapperPackageJson) return { status: "skipped", reason: "wrapper-not-found" }

  const launcherPath = join(dirname(wrapperPackageJson), "bin", "claude.exe")
  if (!existsSync(launcherPath)) {
    return { status: "skipped", reason: "launcher-not-found", launcherPath }
  }

  const isMusl = options.isMusl ?? detectMusl(platform)
  const isRosetta = options.isRosetta ?? detectRosetta(platform, arch)
  const nativePackages = getClaudeCodeNativePackageCandidates(platform, arch, {
    isMusl,
    isRosetta,
  })

  if (nativePackages.length === 0) {
    return { status: "skipped", reason: "unsupported-platform", launcherPath }
  }

  const native = nativePackages
    .map((nativePackage) => {
      const packageJson = resolvePackageJson(nativePackage)
      if (!packageJson) return undefined
      const nativePath = join(dirname(packageJson), nativeBinaryName(platform))
      if (!existsSync(nativePath)) return undefined
      return { nativePackage, nativePath }
    })
    .find((entry) => entry !== undefined)

  if (!native) {
    return {
      status: "skipped",
      reason: "native-not-found",
      launcherPath,
      nativePackages,
    }
  }

  try {
    if (looksNativeExecutable(launcherPath, platform)) {
      ensureExecutable(launcherPath, platform)
      return { status: "already-native", launcherPath, ...native }
    }

    replaceLauncher(launcherPath, native.nativePath, platform)
    return { status: "repaired", launcherPath, ...native }
  } catch (err) {
    return {
      status: "failed",
      reason: err instanceof Error ? err.message : String(err),
      launcherPath,
      nativePath: native.nativePath,
    }
  }
}

export function repairClaudeCodeLauncher(log?: LogFn): ClaudeLauncherRepairResult {
  const result = repairClaudeCodeLauncherForRuntime()

  if (result.status === "repaired") {
    void log?.(
      "info",
      `[claude-max] Repaired Claude Code launcher at ${result.launcherPath}`,
    )
  } else if (result.status === "skipped" && result.reason === "native-not-found") {
    void log?.(
      "warn",
      `[claude-max] Could not repair Claude Code launcher: missing native package (${result.nativePackages?.join(", ")}). Reinstall without omitting optional dependencies.`,
    )
  } else if (result.status === "failed") {
    void log?.(
      "warn",
      `[claude-max] Could not repair Claude Code launcher: ${result.reason}`,
    )
  }

  return result
}
