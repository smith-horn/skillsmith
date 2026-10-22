/**
 * SMI-5126 — enforce that the copies of the git-fixture-env helper stay in
 * sync: the same `GIT_DISCOVERY_VARS` and `GIT_CONFIG_INJECTION_VARS`, and the
 * same `makeFixtureEnv` / `makeFixtureTempDir` code (and the `realpath`
 * helper the latter uses), compared with comments and whitespace stripped.
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
 * test makes it a hard gate: if a variable list or the code of either
 * function drifts between the copies, CI fails.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { describe, it, expect } from 'vitest'

import {
  GIT_CONFIG_INJECTION_VARS as CANONICAL_INJECTION,
  GIT_DISCOVERY_VARS as CANONICAL,
} from './_lib/git-fixture-env.js'
import {
  GIT_CONFIG_INJECTION_VARS as PER_PACKAGE_INJECTION,
  GIT_DISCOVERY_VARS as PER_PACKAGE,
} from '../../packages/doc-retrieval-mcp/src/_lib/git-fixture-env.js'
import {
  GIT_CONFIG_INJECTION_VARS as CORE_INJECTION,
  GIT_DISCOVERY_VARS as CORE,
} from '../../packages/core/tests/_lib/git-fixture-env.js'

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
 * the two copies). Each array entry is on its own line as `  'GIT_X',`, so we
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
  it('runtime arrays are byte-identical across every copy', () => {
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

  // SMI-6531: the lists alone let the functions drift. Each mirror's
  // `makeFixtureEnv`, `makeFixtureTempDir` and `realpath` helper must be the
  // canonical code, ignoring comments and whitespace.
  for (const [name, mirrorSrc] of [
    ['doc-retrieval-mcp', perPackageSrc],
    ['core', coreSrc],
  ] as const) {
    it(`the ${name} copy's makeFixtureEnv, makeFixtureTempDir and realpath match the canonical code`, () => {
      const canonicalText = readFileSync(canonicalSrc, 'utf8')
      const mirrorText = readFileSync(mirrorSrc, 'utf8')
      for (const fn of ['makeFixtureEnv', 'makeFixtureTempDir']) {
        expect(functionCode(mirrorText, fn), `${name}: ${fn}`).toBe(functionCode(canonicalText, fn))
      }
      expect(realpathCode(mirrorText), `${name}: realpath`).toBe(realpathCode(canonicalText))
    })
  }
})

/** Comments and all whitespace removed, so only code is compared. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, '')
}

/** `export function <name>(…) { … }`, up to its closing brace at column 0. */
function functionCode(text: string, name: string): string {
  const start = text.indexOf(`export function ${name}(`)
  expect(start, `${name} not found`).toBeGreaterThanOrEqual(0)
  const end = text.indexOf('\n}\n', start)
  expect(end, `${name} has no closing brace at column 0`).toBeGreaterThan(start)
  return codeOnly(text.slice(start, end + 2))
}

/** The `const realpath …` helper `makeFixtureTempDir` calls, up to its blank line. */
function realpathCode(text: string): string {
  const start = text.indexOf('const realpath')
  expect(start, 'realpath helper not found').toBeGreaterThanOrEqual(0)
  const end = text.indexOf('\n\n', start)
  expect(end).toBeGreaterThan(start)
  return codeOnly(text.slice(start, end))
}
