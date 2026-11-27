/**
 * SMI-7271: `nativeDriverAdvice()` describes the better-sqlite3 that its OWN
 * module would load, not whatever `process.cwd()` resolves to. In the CLI's
 * bundle those differ (the bundle carries its own copy), and a cwd-based
 * lookup would describe some other package entirely.
 *
 * The advice kind alone cannot tell the two apart here: both packages this
 * monorepo resolves build from source, so both say `rebuild`. So this pins
 * the identity of the manifest the advice read.
 *
 * **The test sets cwd itself.** CI runs `npm test --workspace=packages/core`,
 * whose cwd is `packages/core`, and from there cwd and the module reach the
 * same nested copy, so a cwd-based lookup would be invisible. This pins
 * `process.cwd()` to the repo root, where the root copy differs, and a control
 * proves the two bases really do reach different packages.
 *
 * **The test also owns the module load.** The module builds its `require` at
 * import time, so a static import would evaluate it before the cwd stub exists,
 * under the real (CI) cwd, and a module-scope regression to a cwd-based
 * `require` would stay green. So the stub goes in first, then
 * `vi.resetModules()` and a dynamic import evaluate the module fresh under it.
 * That catches a cwd lookup at call time and at module scope alike.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODULE_URL = new URL('../../src/db/drivers/native-driver-advice.ts', import.meta.url)
/** packages/core/tests/db -> the repo root, from this file's own location. */
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SMI-7271: nativeDriverAdvice resolves from its own module', () => {
  it('REPO_ROOT is the workspace root', () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      workspaces?: unknown
    }
    expect(manifest.workspaces).toBeDefined()
    expect(existsSync(join(REPO_ROOT, 'packages', 'core', 'package.json'))).toBe(true)
  })

  it('reads the manifest its module resolves, not the one cwd resolves', async () => {
    // The stub first, then a fresh module evaluated under it (see the header).
    vi.spyOn(process, 'cwd').mockReturnValue(REPO_ROOT)
    vi.resetModules()
    const { nativeDriverAdvice } = await import('../../src/db/drivers/native-driver-advice.js')
    const expected = createRequire(MODULE_URL).resolve('better-sqlite3/package.json')
    const cwdResolved = createRequire(join(REPO_ROOT, 'noop.js')).resolve(
      'better-sqlite3/package.json'
    )
    // Control: if both bases reach the same package, this test cannot tell a
    // cwd-based lookup from the right one, so it must fail rather than pass.
    expect(
      cwdResolved,
      'the control needs two distinct lockfile entries, `node_modules/better-sqlite3` (root) ' +
        'and `packages/core/node_modules/better-sqlite3` (core-nested). If a dedupe merged ' +
        'them, re-point this test at two bases that still resolve different copies.'
    ).not.toBe(expected)

    const advice = nativeDriverAdvice()
    expect(advice.kind).not.toBe('not-installed')
    expect('manifest' in advice ? advice.manifest : undefined).toBe(expected)
  })
})
