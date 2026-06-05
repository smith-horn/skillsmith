/**
 * SMI-5126 — enforce that `GIT_DISCOVERY_VARS` stays byte-identical across
 * the two copies of the git-fixture-env helper.
 *
 * There are two physical copies of this helper:
 *   - canonical: `scripts/tests/_lib/git-fixture-env.ts`
 *   - per-package mirror: `packages/doc-retrieval-mcp/src/_lib/git-fixture-env.ts`
 *
 * The mirror exists because `composite: true` + `rootDir: "."` in
 * `doc-retrieval-mcp` blocks cross-package imports from its `src/` tests.
 * The "keep the two copies in sync" rule (SMI-4693) was previously only a
 * code comment. This test makes it a hard gate: if the discovery-var list
 * drifts between the copies, CI fails.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { describe, it, expect } from 'vitest'

import { GIT_DISCOVERY_VARS as CANONICAL } from './_lib/git-fixture-env.js'
import { GIT_DISCOVERY_VARS as PER_PACKAGE } from '../../packages/doc-retrieval-mcp/src/_lib/git-fixture-env.js'

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
  it('runtime arrays are byte-identical across both copies', () => {
    expect([...PER_PACKAGE]).toEqual([...CANONICAL])
  })

  it('source-text var lists are identical across both copies', () => {
    const canonicalVars = extractVarNames(canonicalSrc)
    const perPackageVars = extractVarNames(perPackageSrc)
    expect(perPackageVars).toEqual(canonicalVars)
  })

  it('runtime array matches the canonical source text', () => {
    expect([...CANONICAL]).toEqual(extractVarNames(canonicalSrc))
  })
})
