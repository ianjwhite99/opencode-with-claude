import assert from "node:assert/strict"
import test from "node:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  getClaudeCodeNativePackageCandidates,
  repairClaudeCodeLauncherForRuntime,
} from "../../src/claude-launcher.ts"

const WRAPPER_PACKAGE = "@anthropic-ai/claude-code"

function createPackage(root, packageName) {
  const packageDir = join(root, "node_modules", ...packageName.split("/"))
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: packageName }))
  return packageDir
}

function createResolver(root) {
  return (packageName) => {
    const packageJson = join(
      root,
      "node_modules",
      ...packageName.split("/"),
      "package.json",
    )
    return existsSync(packageJson) ? packageJson : undefined
  }
}

function withFakePackages(fn) {
  const root = mkdtempSync(join(tmpdir(), "owc-claude-launcher-"))
  try {
    return fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function createWrapperLauncher(root, bytes, mode = 0o644) {
  const wrapperDir = createPackage(root, WRAPPER_PACKAGE)
  const binDir = join(wrapperDir, "bin")
  mkdirSync(binDir, { recursive: true })
  const launcherPath = join(binDir, "claude.exe")
  writeFileSync(launcherPath, bytes, { mode })
  chmodSync(launcherPath, mode)
  return launcherPath
}

function createNativeBinary(root, packageName, bytes) {
  const nativeDir = createPackage(root, packageName)
  const nativePath = join(nativeDir, "claude")
  writeFileSync(nativePath, bytes, { mode: 0o755 })
  chmodSync(nativePath, 0o755)
  return nativePath
}

test("repairs a skipped-postinstall Claude launcher from the native package", () => {
  withFakePackages((root) => {
    const placeholder = Buffer.from([0x4d, 0x5a, 0x00, 0x00, 0x01])
    const nativeBytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x99])
    const launcherPath = createWrapperLauncher(root, placeholder)
    const nativePath = createNativeBinary(
      root,
      "@anthropic-ai/claude-code-linux-x64",
      nativeBytes,
    )

    const result = repairClaudeCodeLauncherForRuntime({
      platform: "linux",
      arch: "x64",
      isMusl: false,
      resolvePackageJson: createResolver(root),
    })

    assert.equal(result.status, "repaired")
    assert.equal(result.launcherPath, launcherPath)
    assert.equal(result.nativePath, nativePath)
    assert.deepEqual(readFileSync(launcherPath), nativeBytes)
    assert.notEqual(statSync(launcherPath).mode & 0o111, 0)
  })
})

test("leaves an existing native launcher in place", () => {
  withFakePackages((root) => {
    const launcherBytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x11])
    const nativeBytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x99])
    const launcherPath = createWrapperLauncher(root, launcherBytes, 0o755)
    createNativeBinary(root, "@anthropic-ai/claude-code-linux-x64", nativeBytes)

    const result = repairClaudeCodeLauncherForRuntime({
      platform: "linux",
      arch: "x64",
      isMusl: false,
      resolvePackageJson: createResolver(root),
    })

    assert.equal(result.status, "already-native")
    assert.deepEqual(readFileSync(launcherPath), launcherBytes)
  })
})

test("sets executable mode on a native non-Windows launcher", () => {
  withFakePackages((root) => {
    const launcherBytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x11])
    const launcherPath = createWrapperLauncher(root, launcherBytes, 0o644)
    createNativeBinary(
      root,
      "@anthropic-ai/claude-code-linux-x64",
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x99]),
    )

    const result = repairClaudeCodeLauncherForRuntime({
      platform: "linux",
      arch: "x64",
      isMusl: false,
      resolvePackageJson: createResolver(root),
    })

    assert.equal(result.status, "already-native")
    assert.notEqual(statSync(launcherPath).mode & 0o111, 0)
  })
})

test("reports native-not-found when optional native package is missing", () => {
  withFakePackages((root) => {
    createWrapperLauncher(root, Buffer.from([0x4d, 0x5a, 0x00, 0x00]))

    const result = repairClaudeCodeLauncherForRuntime({
      platform: "linux",
      arch: "x64",
      isMusl: false,
      resolvePackageJson: createResolver(root),
    })

    assert.equal(result.status, "skipped")
    assert.equal(result.reason, "native-not-found")
    assert.deepEqual(result.nativePackages, ["@anthropic-ai/claude-code-linux-x64"])
  })
})

test("selects the native macOS package when running x64 Node under Rosetta", () => {
  assert.deepEqual(
    getClaudeCodeNativePackageCandidates("darwin", "x64", { isRosetta: true }),
    [
      "@anthropic-ai/claude-code-darwin-arm64",
      "@anthropic-ai/claude-code-darwin-x64",
    ],
  )
})
