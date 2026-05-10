/**
 * Parity test (Issue #13)
 * @module scripts/indexer/tests/parity
 *
 * SMI-4852: Asserts byte-identity for the three shared helpers across the
 * Deno tree (`supabase/functions/indexer/`) and the Node tree
 * (`scripts/indexer/`). Drift between the two trees is a silent correctness
 * regression — this test catches it on every PR until SMI-4855 decommissions
 * the Edge Function indexer.
 *
 * The comparison strips the docblock, import lines, and Deno-vs-Node-only
 * type imports; everything between the implementation markers must be
 * byte-identical.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Extract the implementation body of `repoUpdatedAtKey` and
 * `minimalSkillPayload` from a TypeScript file. Strips imports, comments,
 * and leading export-function keywords; returns just the curly-brace body.
 */
function extractBody(filePath: string, fnName: string): string {
  const source = readFileSync(filePath, 'utf-8')
  const fnIdx = source.indexOf(`export function ${fnName}`)
  if (fnIdx < 0) throw new Error(`Function ${fnName} not found in ${filePath}`)

  // Walk braces from the first `{` after the function name.
  const start = source.indexOf('{', fnIdx)
  if (start < 0) throw new Error(`Opening brace not found for ${fnName} in ${filePath}`)
  let depth = 1
  let i = start + 1
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') depth--
    i++
  }
  return source.slice(start, i).trim()
}

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const DENO_HELPERS = resolve(REPO_ROOT, 'supabase/functions/indexer/skill-processor.helpers.ts')
const NODE_HELPERS = resolve(REPO_ROOT, 'scripts/indexer/skill-processor.helpers.ts')

describe('Deno <-> Node helper parity', () => {
  it('repoUpdatedAtKey is byte-identical', () => {
    const deno = extractBody(DENO_HELPERS, 'repoUpdatedAtKey')
    const node = extractBody(NODE_HELPERS, 'repoUpdatedAtKey')
    expect(node).toBe(deno)
  })

  it('minimalSkillPayload is byte-identical', () => {
    const deno = extractBody(DENO_HELPERS, 'minimalSkillPayload')
    const node = extractBody(NODE_HELPERS, 'minimalSkillPayload')
    expect(node).toBe(deno)
  })
})
