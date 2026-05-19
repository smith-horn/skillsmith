/**
 * Parity test (Issue #13)
 * @module scripts/tests/indexer/parity
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

import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
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

/**
 * SMI-4843 Phase 5: Extract the body of an array literal `export const NAME ... = [ ... ]`
 * declaration. Returns the substring between the matching `[` and `]` brackets.
 * Skips bracket characters inside string literals so commented-out brackets or
 * brackets-in-strings don't confuse depth tracking.
 *
 * SMI-4941: The array literal's opening `[` is located by first finding the
 * declaration's `=`, then searching for `[` AFTER it. This is required because
 * a type annotation such as `: HighTrustAuthor[]` places a `[` before the `=`;
 * a naive `indexOf('[', declIdx)` matches that annotation bracket, walks the
 * immediately-following `]`, and returns the empty string — a silent always-pass.
 * Assumption enforced here: the `=` precedes the array literal's `[`. The
 * `openIdx < eqIdx` guard hardens against future generic-default declarations
 * like `export const X: Record<K, V[]> = [...]` where a bracket also follows
 * the `=` in name only — if no real array `[` follows the `=`, we throw rather
 * than mis-extract.
 */
function extractArrayBody(filePath: string, constName: string): string {
  const source = readFileSync(filePath, 'utf-8')
  const declIdx = source.indexOf(`export const ${constName}`)
  if (declIdx < 0) throw new Error(`const ${constName} not found in ${filePath}`)

  const eqIdx = source.indexOf('=', declIdx)
  if (eqIdx < 0) throw new Error(`'=' for ${constName} not found in ${filePath}`)
  const openIdx = source.indexOf('[', eqIdx)
  if (openIdx < 0 || openIdx < eqIdx)
    throw new Error(`array literal '[' for ${constName} not found after '=' in ${filePath}`)

  let depth = 1
  let i = openIdx + 1
  let inString: string | null = null
  let inLineComment = false
  let inBlockComment = false
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]
    if (inLineComment) {
      if (c === '\n') inLineComment = false
    } else if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false
        i++
      }
    } else if (inString) {
      if (c === '\\') {
        i++ // skip escaped char
      } else if (c === inString) {
        inString = null
      }
    } else {
      if (c === '/' && next === '/') {
        inLineComment = true
        i++
      } else if (c === '/' && next === '*') {
        inBlockComment = true
        i++
      } else if (c === "'" || c === '"' || c === '`') {
        inString = c
      } else if (c === '[') {
        depth++
      } else if (c === ']') {
        depth--
        if (depth === 0) return source.slice(openIdx + 1, i)
      }
    }
    i++
  }
  throw new Error(`array body for ${constName} not closed in ${filePath}`)
}

/**
 * SMI-4879: Extract the body of an `export interface NAME { ... }` declaration.
 * Returns the substring between the matching `{` and `}` braces (the member
 * list). Analogous to `extractBody`/`extractArrayBody` but for interfaces —
 * the AuditLogMeta envelope is a bare `interface`, not a `function` or `const`,
 * so neither existing extractor covers it. Brace depth is tracked so nested
 * object-type members (none today, but future-proof) don't confuse the close.
 */
function extractInterface(filePath: string, ifaceName: string): string {
  const source = readFileSync(filePath, 'utf-8')
  const declIdx = source.indexOf(`export interface ${ifaceName}`)
  if (declIdx < 0) throw new Error(`interface ${ifaceName} not found in ${filePath}`)

  const openIdx = source.indexOf('{', declIdx)
  if (openIdx < 0) throw new Error(`opening { for ${ifaceName} not found in ${filePath}`)

  let depth = 1
  let i = openIdx + 1
  while (i < source.length) {
    const c = source[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return source.slice(openIdx + 1, i)
    }
    i++
  }
  throw new Error(`interface body for ${ifaceName} not closed in ${filePath}`)
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// scripts/tests/indexer/parity.test.ts → repo root is 3 levels up.
const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const DENO_HELPERS = resolve(REPO_ROOT, 'supabase/functions/indexer/skill-processor.helpers.ts')
const NODE_HELPERS = resolve(REPO_ROOT, 'scripts/indexer/skill-processor.helpers.ts')
// SMI-4941: after the SMI-4843 Phase 5b split, `high-trust-authors.ts` is just
// `[...CORE_HIGH_TRUST_AUTHORS, ...LEADERBOARD_HIGH_TRUST_AUTHORS]` — spread
// references, not data. The real author tables live in the `.core.ts` /
// `.leaderboard.ts` twins, so the parity assertions target those directly.
const DENO_AUTHORS_CORE = resolve(
  REPO_ROOT,
  'supabase/functions/indexer/high-trust-authors.core.ts'
)
const NODE_AUTHORS_CORE = resolve(REPO_ROOT, 'scripts/indexer/high-trust-authors.core.ts')
const DENO_AUTHORS_LEADERBOARD = resolve(
  REPO_ROOT,
  'supabase/functions/indexer/high-trust-authors.leaderboard.ts'
)
const NODE_AUTHORS_LEADERBOARD = resolve(
  REPO_ROOT,
  'scripts/indexer/high-trust-authors.leaderboard.ts'
)
const DENO_META_LIST = resolve(REPO_ROOT, 'supabase/functions/indexer/meta-list-filter.ts')
const NODE_META_LIST = resolve(REPO_ROOT, 'scripts/indexer/meta-list-filter.ts')
const DENO_AUDIT_LOG = resolve(REPO_ROOT, 'supabase/functions/indexer/indexer-audit-log.ts')
const NODE_AUDIT_LOG = resolve(REPO_ROOT, 'scripts/indexer/indexer-audit-log.ts')

/**
 * SMI-4852: Skip the parity assertions when the Deno helpers are git-crypt-
 * encrypted (e.g. post-merge-verify.yml runs without unlocking the key).
 * The encrypted file begins with the literal magic `\x00GITCRYPT\x00`. When
 * we observe that, the test exits clean — the parity invariant is enforced
 * in unlocked contexts (PR matrix, local Docker) where every diff lands.
 */
function isGitCryptEncrypted(filePath: string): boolean {
  try {
    const head = readFileSync(filePath).subarray(0, 10)
    return head[0] === 0 && head.toString('utf-8', 1, 9) === 'GITCRYPT\x00'.slice(0, 8)
  } catch {
    return false
  }
}

describe('Deno <-> Node helper parity', () => {
  const denoEncrypted = isGitCryptEncrypted(DENO_HELPERS)

  it.skipIf(denoEncrypted)(
    'repoUpdatedAtKey body is byte-identical (normalized whitespace)',
    () => {
      const deno = normalizeWs(extractBody(DENO_HELPERS, 'repoUpdatedAtKey'))
      const node = normalizeWs(extractBody(NODE_HELPERS, 'repoUpdatedAtKey'))
      expect(node).toBe(deno)
    }
  )

  it.skipIf(denoEncrypted)(
    'minimalSkillPayload body is byte-identical (normalized whitespace)',
    () => {
      const deno = normalizeWs(extractBody(DENO_HELPERS, 'minimalSkillPayload'))
      const node = normalizeWs(extractBody(NODE_HELPERS, 'minimalSkillPayload'))
      expect(node).toBe(deno)
    }
  )

  // SMI-2402: banded quality-score helpers. `getTierBands` is exposed as a
  // function (not a bare `const`) precisely so `extractBody` — which covers
  // `export function`s only — can assert byte-parity of the band table.
  it.skipIf(denoEncrypted)('getTierBands body is byte-identical (normalized whitespace)', () => {
    const deno = normalizeWs(extractBody(DENO_HELPERS, 'getTierBands'))
    const node = normalizeWs(extractBody(NODE_HELPERS, 'getTierBands'))
    expect(node).toBe(deno)
  })

  it.skipIf(denoEncrypted)(
    'computeStructureQuality body is byte-identical (normalized whitespace)',
    () => {
      const deno = normalizeWs(extractBody(DENO_HELPERS, 'computeStructureQuality'))
      const node = normalizeWs(extractBody(NODE_HELPERS, 'computeStructureQuality'))
      expect(node).toBe(deno)
    }
  )

  it.skipIf(denoEncrypted)(
    'computeIntrinsicQuality body is byte-identical (normalized whitespace)',
    () => {
      const deno = normalizeWs(extractBody(DENO_HELPERS, 'computeIntrinsicQuality'))
      const node = normalizeWs(extractBody(NODE_HELPERS, 'computeIntrinsicQuality'))
      expect(node).toBe(deno)
    }
  )

  it.skipIf(denoEncrypted)(
    'computeQualityScore body is byte-identical (normalized whitespace)',
    () => {
      const deno = normalizeWs(extractBody(DENO_HELPERS, 'computeQualityScore'))
      const node = normalizeWs(extractBody(NODE_HELPERS, 'computeQualityScore'))
      expect(node).toBe(deno)
    }
  )

  it.skipIf(denoEncrypted)('selectTrustTier body is byte-identical (normalized whitespace)', () => {
    const deno = normalizeWs(extractBody(DENO_HELPERS, 'selectTrustTier'))
    const node = normalizeWs(extractBody(NODE_HELPERS, 'selectTrustTier'))
    expect(node).toBe(deno)
  })
})

describe('Deno <-> Node HIGH_TRUST_AUTHORS parity (SMI-4843 Phase 5 / SMI-4941)', () => {
  // SMI-4941: each assertion computes its own git-crypt skip-guard against its
  // own Deno path — post-merge-verify.yml runs without the git-crypt key, so a
  // single shared guard would not correctly skip both twins independently.
  const coreEncrypted = isGitCryptEncrypted(DENO_AUTHORS_CORE)
  const leaderboardEncrypted = isGitCryptEncrypted(DENO_AUTHORS_LEADERBOARD)

  it.skipIf(coreEncrypted)(
    'CORE_HIGH_TRUST_AUTHORS array body is byte-identical (normalized whitespace)',
    () => {
      const deno = normalizeWs(extractArrayBody(DENO_AUTHORS_CORE, 'CORE_HIGH_TRUST_AUTHORS'))
      const node = normalizeWs(extractArrayBody(NODE_AUTHORS_CORE, 'CORE_HIGH_TRUST_AUTHORS'))
      expect(
        node,
        'CORE_HIGH_TRUST_AUTHORS drift between scripts/indexer/ and supabase/functions/indexer/ twins'
      ).toBe(deno)
    }
  )

  it.skipIf(leaderboardEncrypted)(
    'LEADERBOARD_HIGH_TRUST_AUTHORS array body is byte-identical (normalized whitespace)',
    () => {
      const deno = normalizeWs(
        extractArrayBody(DENO_AUTHORS_LEADERBOARD, 'LEADERBOARD_HIGH_TRUST_AUTHORS')
      )
      const node = normalizeWs(
        extractArrayBody(NODE_AUTHORS_LEADERBOARD, 'LEADERBOARD_HIGH_TRUST_AUTHORS')
      )
      expect(
        node,
        'LEADERBOARD_HIGH_TRUST_AUTHORS drift between scripts/indexer/ and supabase/functions/indexer/ twins'
      ).toBe(deno)
    }
  )
})

describe('Deno <-> Node meta-list-filter parity (SMI-4842)', () => {
  const denoEncrypted = isGitCryptEncrypted(DENO_META_LIST)

  it.skipIf(denoEncrypted)('readmeLinkRatio body is byte-identical (normalized whitespace)', () => {
    const deno = normalizeWs(extractBody(DENO_META_LIST, 'readmeLinkRatio'))
    const node = normalizeWs(extractBody(NODE_META_LIST, 'readmeLinkRatio'))
    expect(node).toBe(deno)
  })

  it.skipIf(denoEncrypted)('isMetaListRepo body is byte-identical (normalized whitespace)', () => {
    const deno = normalizeWs(extractBody(DENO_META_LIST, 'isMetaListRepo'))
    const node = normalizeWs(extractBody(NODE_META_LIST, 'isMetaListRepo'))
    expect(node).toBe(deno)
  })
})

describe('Deno <-> Node AuditLogMeta interface parity (SMI-4879)', () => {
  const denoEncrypted = isGitCryptEncrypted(DENO_AUDIT_LOG)

  // The `meta` envelope (rate-limit telemetry, kill-switch, tree-hash counters)
  // is persisted to `audit_logs.metadata.meta` by both indexer trees. A field
  // present on one side but not the other is a silent shape regression — the
  // Edge Function indexer would write a row the Node monitors can't read (or
  // vice versa). Pin field-for-field byte-identity until SMI-4855 decommissions
  // the Edge Function indexer.
  it.skipIf(denoEncrypted)(
    'AuditLogMeta interface body is byte-identical (normalized whitespace)',
    () => {
      const deno = normalizeWs(extractInterface(DENO_AUDIT_LOG, 'AuditLogMeta'))
      const node = normalizeWs(extractInterface(NODE_AUDIT_LOG, 'AuditLogMeta'))
      expect(node).toBe(deno)
    }
  )
})

/**
 * SMI-4941: Negative regression test for `extractArrayBody`. The original
 * defect was a SILENT always-pass — `extractArrayBody` matched the `[` inside a
 * `: SomeType[]` type annotation, walked the immediately-following `]`, and
 * returned `''`, so the parity assertion degenerated to `'' === ''`. A positive
 * parity test cannot catch that (identical twins also produce `'' === ''`), so
 * the fix can only be pinned by a test that proves divergent fixtures yield
 * DIFFERENT non-empty bodies and that an annotation-bearing declaration yields
 * the real array content rather than `''`.
 */
describe('extractArrayBody divergence regression (SMI-4941)', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'smi-4941-parity-'))

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true })
  })

  it('returns the real array body for an annotated declaration (not the empty string)', () => {
    // The `: AuthorEntry[]` annotation places a `[` before the `=`. Bug 1 made
    // the extractor match THAT bracket; the fix searches after `=` instead.
    const annotated = join(fixtureDir, 'annotated.ts')
    writeFileSync(
      annotated,
      "export const SAMPLE_AUTHORS: AuthorEntry[] = [\n  { name: 'alpha' },\n  { name: 'beta' },\n]\n"
    )
    const body = extractArrayBody(annotated, 'SAMPLE_AUTHORS')
    expect(body).not.toBe('')
    expect(normalizeWs(body)).toContain("name: 'alpha'")
    expect(normalizeWs(body)).toContain("name: 'beta'")
  })

  it('reports DIFFERENT bodies for divergent fixtures (proves drift is caught)', () => {
    const aPath = join(fixtureDir, 'twin-a.ts')
    const bPath = join(fixtureDir, 'twin-b.ts')
    // twin-a carries a `: AuthorEntry[]` annotation; twin-b does not — both must
    // still extract the real array content, and the two must differ.
    writeFileSync(
      aPath,
      "export const TWIN: AuthorEntry[] = [\n  { name: 'alpha' },\n  { name: 'beta' },\n]\n"
    )
    writeFileSync(bPath, "export const TWIN = [\n  { name: 'alpha' },\n  { name: 'gamma' },\n]\n")
    const a = normalizeWs(extractArrayBody(aPath, 'TWIN'))
    const b = normalizeWs(extractArrayBody(bPath, 'TWIN'))
    expect(a).not.toBe('')
    expect(b).not.toBe('')
    expect(a).not.toBe(b)
  })
})
