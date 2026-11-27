/**
 * SMI-7271: what will get the native SQLite driver back, decided by what the
 * installed better-sqlite3 package can do, never by the shape of its load error.
 *
 * Two installs ship different packages. The MCP server's better-sqlite3 (12.x)
 * builds its binary through an install script, so a rebuild is its fix. The
 * CLI's (13.x) has `gypfile: false` and no install script: it only loads a
 * prebuilt binary from `prebuilds/<platform>-<arch>.node` and can build
 * nothing, so "rebuild" or "enable install scripts" is advice it cannot use,
 * whatever the load error said (a damaged 13.x prebuilt throws the same
 * `ERR_DLOPEN_FAILED` a damaged 12.x build does). So this module reads the
 * package itself. The load error stays the CAUSE, shown under
 * `SKILLSMITH_DEBUG` (createDatabase.ts); it never picks the advice.
 *
 * Resolved with a `require` created in this directory, the same place
 * `betterSqlite3Driver.ts` loads the package from (in the CLI's bundle, the
 * same file).
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

/**
 * - `not-installed`: the package does not resolve (or its manifest is
 *   unreadable): it was skipped (`--omit=optional`) or failed to install.
 * - `rebuild`: the package can build its binary (12.x).
 * - `no-prebuilt`: a prebuilt-only package (13.x) with no binary for `target`.
 * - `prebuilt-failed`: a prebuilt-only package whose binary for `target` exists
 *   and did not load (damaged, or it does not match this Node.js).
 */
export type NativeDriverAdvice =
  | { kind: 'not-installed' }
  | { kind: 'rebuild' }
  | { kind: 'no-prebuilt'; target: string }
  | { kind: 'prebuilt-failed'; target: string }

/** The platform facts the prebuilt lookup needs; injectable for tests. */
export interface NativePlatform {
  platform: string
  arch: string
  /** Only consulted on linux, like better-sqlite3's own rule. */
  isMusl: () => boolean
}

// better-sqlite3 13's own rule, lib/binding.js (getPrebuildPath, isLinuxMusl).
const PREBUILD_PLATFORMS = ['linux', 'darwin', 'win32']
const PREBUILD_ARCHS = ['x64', 'arm64']

/** The platforms better-sqlite3 13 ships prebuilt binaries for, as prose. */
export const SUPPORTED_PREBUILDS = 'darwin, linux, linuxmusl and win32, on x64 or arm64'

/**
 * Musl detection exactly as better-sqlite3 13 does it. Measured (SMI-7271):
 * `glibcVersionRuntime` is "2.36" in the node:22-slim dev container and absent
 * under Alpine's musl Node.
 */
function hostIsMusl(): boolean {
  const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } }
  return !report.header?.glibcVersionRuntime
}

const HOST: NativePlatform = {
  platform: process.platform,
  arch: process.arch,
  isMusl: hostIsMusl,
}

/** The `prebuilds/` basename better-sqlite3 13 would load on this platform. */
export function prebuildTarget(p: NativePlatform): string {
  const os = p.platform === 'linux' && p.isMusl() ? 'linuxmusl' : p.platform
  return `${os}-${p.arch}`
}

interface PackageManifest {
  gypfile?: unknown
  scripts?: Record<string, unknown>
}

/**
 * Advice for the better-sqlite3 that `resolve` finds.
 *
 * @param resolve - resolves a module request to a file path, throwing when it
 *   does not resolve (`require.resolve`).
 */
export function adviseFor(
  resolve: (request: string) => string,
  platform: NativePlatform = HOST
): NativeDriverAdvice {
  let manifestPath: string
  let manifest: PackageManifest
  try {
    manifestPath = resolve('better-sqlite3/package.json')
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest
  } catch {
    // Not resolvable, or a manifest that cannot be read: either way the
    // install is missing or broken, and reinstalling is the fix.
    return { kind: 'not-installed' }
  }
  const root = dirname(manifestPath)
  const scripts = manifest.scripts ?? {}
  // npm runs an install/preinstall script, and runs node-gyp itself for a
  // package with a binding.gyp unless `gypfile: false`.
  const canBuild =
    typeof scripts.install === 'string' ||
    typeof scripts.preinstall === 'string' ||
    (manifest.gypfile !== false && existsSync(join(root, 'binding.gyp')))
  if (canBuild) return { kind: 'rebuild' }

  const target = prebuildTarget(platform)
  const supported =
    PREBUILD_PLATFORMS.includes(platform.platform) && PREBUILD_ARCHS.includes(platform.arch)
  return supported && existsSync(join(root, 'prebuilds', `${target}.node`))
    ? { kind: 'prebuilt-failed', target }
    : { kind: 'no-prebuilt', target }
}

/** Advice for the better-sqlite3 this process would load. */
export function nativeDriverAdvice(): NativeDriverAdvice {
  return adviseFor((request) => require.resolve(request))
}
