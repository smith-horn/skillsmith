/**
 * @fileoverview The published CLI must ship the native SQLite driver (SMI-7260).
 * @module @skillsmith/cli/tests/native-driver-packaging
 *
 * The CLI bundles `@skillsmith/core` into `dist/cli.js` with esbuild and keeps
 * `better-sqlite3` external, so the bundle loads it at runtime with `require`.
 * An external module is only present at runtime if the CLI's OWN manifest
 * declares it: core's declaration does not travel with a bundled copy of core.
 * Before SMI-7260 the CLI declared nothing, so every global install fell back
 * to the sql.js (WASM) driver — the driver that, sharing a database with the
 * MCP server's native one, replaced the file under it and lost its writes.
 *
 * These checks read the manifests and, when one has been built, the bundle.
 * Nothing here publishes or installs.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

interface Manifest {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

function manifest(root: string): Manifest {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Manifest
}

/** The version a manifest installs `name` at, from either runtime section. */
function runtimeVersion(pkg: Manifest, name: string): string | undefined {
  return pkg.dependencies?.[name] ?? pkg.optionalDependencies?.[name]
}

/** An exact `MAJOR.MINOR.PATCH` version: no range operator, wildcard or tag. */
function isExactVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version)
}

/** The major version of an exact version string. */
function majorOf(version: string): number {
  return Number(version.split('.')[0])
}

/**
 * The first major that bundles prebuilt binaries and has no install script and
 * no `prebuild-install` dependency (deprecated; SMI-5427 removed it from the
 * CLI's install tree). Core stays on 12.x; the CLI pins 13.x on purpose.
 */
const MIN_NATIVE_DRIVER_MAJOR = 13

/**
 * The owner-approved pin (SMI-7260, 2026-11-23): 13.0.3 passed core's database
 * suites through a resolver redirect, and 13.1.0 is marked "NOT A VIABLE
 * RELEASE" upstream. Moving the pin is a decision, so it must change this
 * constant too, not just the manifest.
 */
const APPROVED_PIN = '13.0.3'

/** The lockfile entry npm installs for the CLI's better-sqlite3, if any. */
function lockedDriver(): { version?: string; hasInstallScript?: boolean } | undefined {
  const lock = JSON.parse(readFileSync(join(cliRoot, '..', '..', 'package-lock.json'), 'utf8')) as {
    packages?: Record<string, { version?: string; hasInstallScript?: boolean }>
  }
  return lock.packages?.['packages/cli/node_modules/better-sqlite3']
}

describe('CLI ships the native SQLite driver (SMI-7260)', () => {
  const cli = manifest(cliRoot)

  it(`pins exactly the approved better-sqlite3 ${APPROVED_PIN}, and the lockfile installs that version with no install script`, () => {
    expect(cli.optionalDependencies?.['better-sqlite3']).toBe(APPROVED_PIN)
    const locked = lockedDriver()
    expect(locked, 'package-lock.json entry packages/cli/node_modules/better-sqlite3').toBeDefined()
    expect(locked?.version).toBe(APPROVED_PIN)
    expect(locked?.hasInstallScript, 'the locked release must not run an install script').not.toBe(
      true
    )
  })

  it('declares better-sqlite3 as a runtime dependency of its own', () => {
    expect(runtimeVersion(cli, 'better-sqlite3')).toBeDefined()
  })

  it('pins better-sqlite3 in optionalDependencies at an exact version', () => {
    const pinned = cli.optionalDependencies?.['better-sqlite3']
    expect(pinned, 'optionalDependencies["better-sqlite3"]').toBeDefined()
    expect(isExactVersion(pinned ?? ''), `exact version, got "${pinned}"`).toBe(true)
  })

  it(`pins a better-sqlite3 major of at least ${MIN_NATIVE_DRIVER_MAJOR} (prebuilt, no install script)`, () => {
    const pinned = cli.optionalDependencies?.['better-sqlite3'] ?? ''
    expect(majorOf(pinned), `major of "${pinned}"`).toBeGreaterThanOrEqual(MIN_NATIVE_DRIVER_MAJOR)
  })

  // The two predicates above, against known-good and known-bad values, so a
  // predicate that accepts everything cannot pass the real-manifest tests.
  it.each([
    ['13.0.3', true],
    ['^13.0.3', false],
    ['~13.0.3', false],
    ['>=13.0.3', false],
    ['13.x', false],
    ['13.0.3 || 14.0.0', false],
    ['13.0.3-beta.1', false],
    ['latest', false],
  ])('isExactVersion(%s) is %s', (version, exact) => {
    expect(isExactVersion(version)).toBe(exact)
  })

  it.each([
    ['13.0.3', true],
    ['14.1.0', true],
    ['12.10.0', false],
    ['11.10.0', false],
  ])('a pin of %s meets the major floor: %s', (version, meets) => {
    expect(majorOf(version) >= MIN_NATIVE_DRIVER_MAJOR).toBe(meets)
  })

  // Today core loads the driver through `createRequire`, which esbuild never
  // bundles, so this flag is what keeps a future static `import` external.
  it('keeps better-sqlite3 external to the bundle, so the native binding can load', () => {
    const build = cli.scripts?.['build'] ?? ''
    expect(build.split(/\s+/)).toContain('--external:better-sqlite3')
  })

  // Only when a bundle exists: CI builds before testing, a worktree may not.
  const bundlePath = join(cliRoot, 'dist', 'cli.js')
  it.skipIf(!existsSync(bundlePath))(
    'the built bundle requires better-sqlite3 rather than inlining it',
    () => {
      const bundle = readFileSync(bundlePath, 'utf8')
      // Booleans, not the bundle string: a 2.6 MB diff buries the failure.
      // esbuild renames core's `createRequire` result (`require2`, ...).
      expect(
        /\brequire\d*\("better-sqlite3"\)/.test(bundle),
        'bundle requires better-sqlite3'
      ).toBe(true)
      // better-sqlite3's own loader (lib/database.js) names its addon file, so
      // the string appears only if the package was inlined. Measured with
      // esbuild on a static `import Database from 'better-sqlite3'` entry: 1
      // occurrence without `--external:better-sqlite3`, 0 with it.
      expect(bundle.includes('better_sqlite3.node'), 'bundle inlines better-sqlite3').toBe(false)
    }
  )
})
