/**
 * Parity test (Issue #13)
 * @module scripts/indexer/tests/parity
 *
 * SMI-4852: Asserts byte-identity (after whitespace normalization) for the
 * shared helpers across the Deno tree (`supabase/functions/indexer/`) and
 * the Node tree (`scripts/indexer/`). Drift between the two trees is a
 * silent correctness regression — this test catches it on every PR until
 * SMI-4855 decommissions the Edge Function indexer.
 *
 * The Deno and Node sources are formatted by different toolchains (deno fmt
 * vs prettier), so the test normalizes whitespace inside the function body
 * before comparing. Semantic divergence (different statements, different
 * expressions, different identifier names) IS caught; cosmetic line-wrap
 * differences from formatter disagreement are not.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Extract just the function body (statements between the *body* opening
 * brace and its matching close), skipping any return-type annotation braces
 * in the signature. Strategy: find the function name, then walk forward
 * scanning for `{` characters at top level (depth=0 of parens). The first
 * `{` we hit AFTER we've seen the matching `)` of the parameter list is
 * either the return-type-annotation open OR the body open. To distinguish:
 * count brace depth; the body opens after we've exited the parameter parens
 * AND we're not inside an active type-annotation expression (no preceding
 * `:` that hasn't been balanced).
 *
 * Easier: skip the function up to and including the `): ReturnType` and
 * then the `{` that opens the body. We detect "body opens" as the `{`
 * preceded (after trimming whitespace) by `)` or `}` or an identifier — i.e.
 * not by `:` (which would indicate it's still part of the return type).
 */
function extractBody(filePath: string, fnName: string): string {
  const source = readFileSync(filePath, 'utf-8')
  const fnIdx = source.indexOf(`export function ${fnName}`)
  if (fnIdx < 0) throw new Error(`Function ${fnName} not found in ${filePath}`)

  // Walk parens to find the close of the parameter list.
  let i = source.indexOf('(', fnIdx)
  let parenDepth = 1
  i++
  while (i < source.length && parenDepth > 0) {
    if (source[i] === '(') parenDepth++
    else if (source[i] === ')') parenDepth--
    i++
  }
  // i is now just past the closing `)` of the parameter list.

  // Skip any return-type annotation. Walk forward through `:`, identifiers,
  // and balanced `{...}` (for object return types) until we find a `{` whose
  // preceding non-whitespace character is `)` (no annotation) or `}` (just
  // closed the return-type object) or an identifier letter (a named type).
  let braceDepth = 0
  while (i < source.length) {
    const c = source[i]
    if (c === '{') {
      if (braceDepth === 0) {
        // Check what preceded this `{`. If preceded by `:` (still in
        // annotation), enter the annotation; else this IS the body open.
        let j = i - 1
        while (j >= 0 && /\s/.test(source[j])) j--
        const prev = source[j]
        if (prev === ':') {
          // entering return-type object annotation
          braceDepth = 1
          i++
          continue
        }
        // body open
        const start = i
        let bd = 1
        i++
        while (i < source.length && bd > 0) {
          if (source[i] === '{') bd++
          else if (source[i] === '}') bd--
          i++
        }
        return source.slice(start, i)
      } else {
        braceDepth++
      }
    } else if (c === '}') {
      if (braceDepth > 0) braceDepth--
    }
    i++
  }
  throw new Error(`Function body for ${fnName} not found in ${filePath}`)
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const DENO_HELPERS = resolve(REPO_ROOT, 'supabase/functions/indexer/skill-processor.helpers.ts')
const NODE_HELPERS = resolve(REPO_ROOT, 'scripts/indexer/skill-processor.helpers.ts')

describe('Deno <-> Node helper parity', () => {
  it('repoUpdatedAtKey body is byte-identical (normalized whitespace)', () => {
    const deno = normalizeWs(extractBody(DENO_HELPERS, 'repoUpdatedAtKey'))
    const node = normalizeWs(extractBody(NODE_HELPERS, 'repoUpdatedAtKey'))
    expect(node).toBe(deno)
  })

  it('minimalSkillPayload body is byte-identical (normalized whitespace)', () => {
    const deno = normalizeWs(extractBody(DENO_HELPERS, 'minimalSkillPayload'))
    const node = normalizeWs(extractBody(NODE_HELPERS, 'minimalSkillPayload'))
    expect(node).toBe(deno)
  })
})
