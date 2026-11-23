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
const coreRoot = join(cliRoot, '..', 'core')

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

describe('CLI ships the native SQLite driver (SMI-7260)', () => {
  const cli = manifest(cliRoot)
  const core = manifest(coreRoot)

  it('declares better-sqlite3 as a runtime dependency of its own', () => {
    expect(runtimeVersion(cli, 'better-sqlite3')).toBeDefined()
  })

  it('declares the same better-sqlite3 version the bundled core is built against', () => {
    expect(runtimeVersion(core, 'better-sqlite3')).toBeDefined()
    expect(runtimeVersion(cli, 'better-sqlite3')).toBe(runtimeVersion(core, 'better-sqlite3'))
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
