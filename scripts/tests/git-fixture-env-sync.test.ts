/**
 * SMI-5126 — enforce that the copies of the git-fixture-env helper stay in
 * sync. What is compared, and nothing more:
 *   - the VALUES of `GIT_DISCOVERY_VARS` and `GIT_CONFIG_INJECTION_VARS` (at
 *     runtime, and the discovery list's entries in each file's source text);
 *   - the BEHAVIOUR of `makeFixtureEnv` (each copy, given the same seeded
 *     `process.env` and the same `extra`, returns a deep-equal env) and of
 *     `makeFixtureTempDir` (each copy makes an existing, empty directory
 *     directly under the realpath of `tmpdir()`, which the test points at a
 *     symlink so a copy that skips the realpath is caught).
 * Source text is not compared, so comments, formatting and imports may
 * differ between copies.
 *
 * There are three physical copies of this helper:
 *   - canonical: `scripts/tests/_lib/git-fixture-env.ts`
 *   - per-package mirror: `packages/doc-retrieval-mcp/src/_lib/git-fixture-env.ts`
 *   - per-package mirror: `packages/core/tests/_lib/git-fixture-env.ts` (SMI-6531:
 *     core's `composite` + `rootDir` blocks the same import from its tests)
 *
 * Each mirror exists because `composite: true` + `rootDir: "."` in its
 * package blocks importing the canonical file from its tests. The "keep the
 * copies in sync" rule (SMI-4693) was previously only a code comment. This
 * test makes it a hard gate: if a list's values or either helper's behaviour
 * drifts between the copies, CI fails.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, it, expect } from 'vitest'

import {
  GIT_CONFIG_INJECTION_VARS as CANONICAL_INJECTION,
  GIT_DISCOVERY_VARS as CANONICAL,
  makeFixtureEnv as canonicalEnv,
  makeFixtureTempDir as canonicalTempDir,
} from './_lib/git-fixture-env.js'
import {
  GIT_CONFIG_INJECTION_VARS as PER_PACKAGE_INJECTION,
  GIT_DISCOVERY_VARS as PER_PACKAGE,
  makeFixtureEnv as perPackageEnv,
  makeFixtureTempDir as perPackageTempDir,
} from '../../packages/doc-retrieval-mcp/src/_lib/git-fixture-env.js'
import {
  GIT_CONFIG_INJECTION_VARS as CORE_INJECTION,
  GIT_DISCOVERY_VARS as CORE,
  makeFixtureEnv as coreEnv,
  makeFixtureTempDir as coreTempDir,
} from '../../packages/core/tests/_lib/git-fixture-env.js'

const MIRRORS = [
  ['doc-retrieval-mcp', perPackageEnv, perPackageTempDir],
  ['core', coreEnv, coreTempDir],
] as const

const here = dirname(fileURLToPath(import.meta.url))
const canonicalSrc = join(here, '_lib', 'git-fixture-env.ts')
const perPackageSrc = join(
  here,
  '..',
  '..',
  'packages',
  'doc-retrieval-mcp',
  'src',
  '_lib',
  'git-fixture-env.ts'
)
const coreSrc = join(here, '..', '..', 'packages', 'core', 'tests', '_lib', 'git-fixture-env.ts')

/**
 * Extract just the string entries of the `GIT_DISCOVERY_VARS` array from the
 * source text, ignoring the prose comments (which legitimately differ between
 * the copies). Each array entry is on its own line as `  'GIT_X',`, so we
 * match only lines whose sole content is a quoted UPPER_SNAKE identifier —
 * comment lines (which may contain apostrophes) are skipped.
 */
function extractVarNames(srcPath: string): string[] {
  const text = readFileSync(srcPath, 'utf8')
  const start = text.indexOf('export const GIT_DISCOVERY_VARS = [')
  expect(start, `GIT_DISCOVERY_VARS array not found in ${srcPath}`).toBeGreaterThanOrEqual(0)
  const end = text.indexOf('] as const', start)
  expect(end, `GIT_DISCOVERY_VARS terminator not found in ${srcPath}`).toBeGreaterThan(start)
  const block = text.slice(start, end)
  const names: string[] = []
  for (const line of block.split('\n')) {
    const m = line.match(/^\s*'([A-Z][A-Z0-9_]*)',\s*$/)
    if (m) names.push(m[1])
  }
  return names
}

describe('git-fixture-env GIT_DISCOVERY_VARS sync (SMI-5126)', () => {
  it('runtime arrays hold the same values in every copy', () => {
    expect([...PER_PACKAGE]).toEqual([...CANONICAL])
    expect([...CORE]).toEqual([...CANONICAL])
  })

  it('source-text var lists are identical across every copy', () => {
    const canonicalVars = extractVarNames(canonicalSrc)
    expect(extractVarNames(perPackageSrc)).toEqual(canonicalVars)
    expect(extractVarNames(coreSrc)).toEqual(canonicalVars)
  })

  it('runtime array matches the canonical source text', () => {
    expect([...CANONICAL]).toEqual(extractVarNames(canonicalSrc))
  })

  // SMI-6919: the config-injection list is a second array, kept apart from
  // the discovery list because the per-package production scrub iterates
  // only the latter; every copy must still agree on it.
  it('GIT_CONFIG_INJECTION_VARS is identical across every copy and disjoint from discovery', () => {
    expect([...PER_PACKAGE_INJECTION]).toEqual([...CANONICAL_INJECTION])
    expect([...CORE_INJECTION]).toEqual([...CANONICAL_INJECTION])
    for (const v of CANONICAL_INJECTION) expect(CANONICAL).not.toContain(v)
  })

  // SMI-6531: the lists alone let the helpers drift, so their behaviour is
  // compared too.
  describe('helper behaviour', () => {
    let saved: NodeJS.ProcessEnv = {}
    const made: string[] = []

    beforeEach(() => {
      saved = { ...process.env }
    })

    afterEach(() => {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
      for (const [k, v] of Object.entries(saved)) process.env[k] = v
      for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
    })

    /**
     * `process.env` replaced by ONLY seeded values: every listed variable, plus
     * identity, HOME and unrelated ones. Nothing inherited stays, so a failing
     * comparison prints no real environment (no tokens in a CI log).
     */
    function seedEnv(): void {
      for (const k of Object.keys(process.env)) delete process.env[k]
      for (const v of [...CANONICAL, ...CANONICAL_INJECTION]) process.env[v] = `seeded-${v}`
      Object.assign(process.env, {
        HOME: '/seeded/home',
        GIT_AUTHOR_NAME: 'Seeded Author',
        GIT_COMMITTER_EMAIL: 'seeded@example.invalid',
        GIT_CONFIG_GLOBAL: '/seeded/gitconfig',
        GIT_TERMINAL_PROMPT: '1',
        PATH: '/seeded/bin',
        SWAP4A_UNRELATED: 'kept',
        LANG: 'C.UTF-8',
      })
    }

    for (const [name, env] of MIRRORS) {
      it(`the ${name} copy's makeFixtureEnv returns what the canonical one does`, () => {
        seedEnv()
        const seeded = { ...process.env }
        const base = canonicalEnv()
        // The seed took effect: a listed variable is stripped, an unrelated one
        // kept, and the identity pinned. Without this, two copies that changed
        // alike, or a seed that failed to isolate, would still compare equal.
        expect(base.GIT_DIR).toBeUndefined()
        expect(base.SWAP4A_UNRELATED).toBe('kept')
        expect(base.GIT_AUTHOR_NAME).toBe('Test')
        expect(env()).toStrictEqual(base)
        const extra = { GIT_AUTHOR_NAME: 'Extra', SWAP4A_EXTRA: 'x' }
        expect(env(extra)).toStrictEqual(canonicalEnv(extra))
        // Neither copy may change the environment it reads.
        expect({ ...process.env }).toStrictEqual(seeded)
      })
    }

    for (const [name, , tempDir] of MIRRORS) {
      it(`the ${name} copy's makeFixtureTempDir makes the same shape of directory`, () => {
        // tmpdir() reads TMPDIR at call time: point it at a symlink, so a copy
        // that skips the realpath returns a parent other than the canonical one.
        const base = realpathSync(mkdtempSync(join(tmpdir(), 'fixture-env-sync-')))
        made.push(base)
        const real = join(base, 'real')
        mkdirSync(real)
        symlinkSync(real, join(base, 'link'))
        process.env.TMPDIR = join(base, 'link')
        const ours = canonicalTempDir('sync')
        const theirs = tempDir('sync')
        const again = tempDir('sync')
        expect(dirname(ours)).toBe(real)
        expect(dirname(theirs), name).toBe(dirname(ours))
        for (const d of [ours, theirs, again]) {
          expect(statSync(d).isDirectory()).toBe(true)
          expect(readdirSync(d)).toEqual([])
          expect(basename(d)).toMatch(/^sync-[A-Za-z0-9]{6}$/)
        }
        expect(new Set([ours, theirs, again]).size).toBe(3)
      })
    }
  })
})
