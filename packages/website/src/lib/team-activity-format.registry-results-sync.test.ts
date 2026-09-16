/**
 * SMI-6680 (PR #2860 gate, round 3): `REGISTRY_RESULTS` in `team-activity-format.ts` is a
 * website-local `as const` tuple that nothing in `packages/website` imports it into or out of, so
 * TypeScript has no way to relate it to the two real registry-result writer unions. This test is
 * the real mechanism that keeps them in sync. It reads three files' *source text* at runtime (not
 * their compiled types, and not by importing them) and asserts the union of the two real writer
 * result-literal sets equals `REGISTRY_RESULTS`'s own set, exactly:
 *   - `RegistryReadAuditEvent['result']` + `RegistryMutationAuditEvent['result']` in
 *     `packages/mcp-server/src/tools/registry-tools.live.audit.ts`
 *   - `AuditResult` in `supabase/functions/private-registry-get/access.ts`
 *
 * Why source text, not a typecheck assertion: the root `tsconfig.json` references only
 * `core`/`mcp-server`/`cli`/`enterprise` (SMI-6300) — `packages/website` isn't in it, so a
 * type-level constraint here is invisible to `npm run typecheck` and only surfaces under
 * `astro check`, a different (and less commonly run) gate.
 *
 * Why source text, not an import: `access.ts` is a Deno edge function and `packages/mcp-server`
 * is a separate workspace package — neither imports cleanly into a Vitest/Node run of
 * `packages/website`. Reading the literal source text works across both the runtime boundary
 * (Deno vs Node) and the package boundary.
 *
 * Round 1 asserted the sync constraint in prose. Round 2 replaced prose with a type that turned
 * out to be a tautology checking itself (`ATTEMPT_OUTCOMES` against `REGISTRY_RESULTS`'s own
 * type, never against the two real writers). Round 3 replaced prose-adjacent regexes
 * (`/result:\s*([^\n]+)/`) with the TypeScript compiler API's syntactic AST — the regexes read
 * only the first physical line after `result:`, so a union split across lines defeated them, and
 * a same-line comment containing a quoted literal was read as a real union member. Parsing with
 * `typescript` (already a `packages/website` devDependency — confirmed via `npm ls typescript
 * --workspace=packages/website`, resolving from the website package itself rather than assumed
 * hoisting) makes both holes structurally impossible: a union node's members are its members
 * regardless of line breaks, and comment text is trivia the parser never turns into a
 * `LiteralTypeNode`. The `describe('mutation fixtures ...')` block below exercises exactly these
 * two holes, plus the two silent-empty-set failure modes (a reshaped-to-alias union, a
 * renamed/moved declaration), against synthetic source snippets shaped like the real files.
 *
 * `supabase/functions/**` is git-crypt encrypted; a fork PR without `secrets.GIT_CRYPT_KEY` sees
 * ciphertext for `access.ts` — this test detects the `\x00GITCRYPT` header (same sentinel pattern
 * as `vitest.config.ts`'s `gitCryptLocked()`) and skips the access.ts half via Vitest's runtime
 * `ctx.skip()`, which reports the test as SKIPPED rather than a silent PASS. The readable half
 * (the two MCP writer unions against `REGISTRY_RESULTS`) is asserted *before* that skip check, so
 * a fork checkout with a widened MCP union still fails this test instead of reporting a PASS that
 * performed no comparison at all.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
// Default import, not `* as ts`: astro check emits ts(80003) for the namespace
// form and the website enforces a 0 errors / 0 warnings / 0 hints baseline.
import ts from 'typescript'
import { REGISTRY_RESULTS } from './team-activity-format'

const here = dirname(fileURLToPath(import.meta.url))
// packages/website/src/lib -> repo root
const repoRoot = resolve(here, '../../../..')

const MCP_WRITER_PATH = resolve(
  repoRoot,
  'packages/mcp-server/src/tools/registry-tools.live.audit.ts'
)
const ACCESS_PATH = resolve(repoRoot, 'supabase/functions/private-registry-get/access.ts')

/** Sorted, de-duplicated array — for order/duplicate-insensitive set comparison. */
function sortedSet(values: string[]): string[] {
  return [...new Set(values)].sort()
}

function isGitCryptLocked(path: string): boolean {
  if (!existsSync(path)) return false
  try {
    const head = readFileSync(path).subarray(0, 9).toString('binary')
    return head.startsWith('\x00GITCRYPT')
  } catch {
    return false
  }
}

/**
 * Parse `source` with the TypeScript compiler API (syntactic AST only, no type-checker — no
 * `Program`, no cross-file resolution needed) and return the string-literal members of a union
 * type declared in it.
 *
 * - `propertyName` omitted: `typeName` must itself resolve to a union of string literals, e.g.
 *   `export type AuditResult = 'a' | 'b'`.
 * - `propertyName` given: `typeName` must resolve to an object type (a `TypeLiteral`, optionally
 *   intersected with other type references, e.g. `Fields & { result: ... }`) with a property
 *   signature named `propertyName` whose type is a union of string literals.
 *
 * Fails loudly (throws) instead of returning an empty array when:
 * - `typeName` cannot be found at all — renamed, moved, or the file failed to parse. An empty
 *   result here must never read as "nothing to compare," which would trivially match or trivially
 *   diverge from the website side depending on which direction the comparison runs.
 * - `propertyName` was requested but the object shape has no such property.
 * - any union member is not a plain string-literal type node. A reference to a type alias or a
 *   mapped type is a real shape change this check refuses to silently interpret as a literal set.
 */
function extractResultLiteralUnion(
  source: string,
  fileLabel: string,
  typeName: string,
  propertyName?: string
): string[] {
  const sourceFile = ts.createSourceFile(
    fileLabel,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )

  let aliasNode: ts.TypeAliasDeclaration | undefined
  const visit = (node: ts.Node): void => {
    if (aliasNode) return
    if (ts.isTypeAliasDeclaration(node) && node.name.text === typeName) {
      aliasNode = node
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  if (!aliasNode) {
    throw new Error(
      `${fileLabel}: type alias '${typeName}' not found — declaration moved, renamed, or failed to parse`
    )
  }

  let unionNode: ts.TypeNode
  if (propertyName === undefined) {
    unionNode = aliasNode.type
  } else {
    const members = collectObjectTypeMembers(aliasNode.type)
    const propertyType = findPropertyType(members, propertyName)
    if (!propertyType) {
      throw new Error(
        `${fileLabel}: '${typeName}' has no '${propertyName}' property — declaration reshaped or field renamed`
      )
    }
    unionNode = propertyType
  }

  return extractLiteralUnionMembers(
    unionNode,
    `${fileLabel}: ${typeName}${propertyName ? `.${propertyName}` : ''}`
  )
}

/** Members of a `TypeLiteral`, or of every `TypeLiteral` constituent of an `Intersection` (a bare
 *  `TypeReference` constituent, e.g. `Fields &`, is skipped — it names a shape declared
 *  elsewhere, not an inline member list). Anything else yields no members. */
function collectObjectTypeMembers(typeNode: ts.TypeNode): readonly ts.TypeElement[] {
  if (ts.isTypeLiteralNode(typeNode)) return typeNode.members
  if (ts.isIntersectionTypeNode(typeNode)) {
    return typeNode.types.flatMap((t) => (ts.isTypeLiteralNode(t) ? [...t.members] : []))
  }
  return []
}

function findPropertyType(
  members: readonly ts.TypeElement[],
  propertyName: string
): ts.TypeNode | undefined {
  for (const member of members) {
    if (!ts.isPropertySignature(member) || !member.type) continue
    const name = member.name
    const text = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined
    if (text === propertyName) return member.type
  }
  return undefined
}

function extractLiteralUnionMembers(typeNode: ts.TypeNode, label: string): string[] {
  const constituents = ts.isUnionTypeNode(typeNode) ? typeNode.types : [typeNode]
  const literals: string[] = []
  for (const constituent of constituents) {
    if (ts.isLiteralTypeNode(constituent) && ts.isStringLiteral(constituent.literal)) {
      literals.push(constituent.literal.text)
      continue
    }
    throw new Error(
      `${label}: union member of kind '${ts.SyntaxKind[constituent.kind]}' is not a string ` +
        `literal — refusing to interpret an alias or mapped type as a literal result set`
    )
  }
  if (literals.length === 0) {
    throw new Error(`${label}: resolved to zero literal members`)
  }
  return literals
}

describe('REGISTRY_RESULTS stays in sync with the real registry-result writers (SMI-6680)', () => {
  it('equals the union of RegistryReadAuditEvent/RegistryMutationAuditEvent result literals and AuditResult', (ctx) => {
    expect(existsSync(MCP_WRITER_PATH)).toBe(true)
    const mcpSource = readFileSync(MCP_WRITER_PATH, 'utf8')

    const readLiterals = extractResultLiteralUnion(
      mcpSource,
      MCP_WRITER_PATH,
      'RegistryReadAuditEvent',
      'result'
    )
    const mutationLiterals = extractResultLiteralUnion(
      mcpSource,
      MCP_WRITER_PATH,
      'RegistryMutationAuditEvent',
      'result'
    )

    const websiteSet = sortedSet([...REGISTRY_RESULTS])
    const readableUnion = sortedSet([...readLiterals, ...mutationLiterals])

    // Validate the readable half unconditionally, before the git-crypt gate below — gate finding
    // 2: a fork checkout that cannot read access.ts must still have this half of the comparison
    // actually run, not silently skipped along with the whole test.
    for (const literal of readableUnion) {
      expect(
        websiteSet,
        `REGISTRY_RESULTS is missing '${literal}', which RegistryReadAuditEvent/RegistryMutationAuditEvent can emit`
      ).toContain(literal)
    }

    if (isGitCryptLocked(ACCESS_PATH)) {
      // Fork PR without secrets.GIT_CRYPT_KEY — access.ts is unreadable ciphertext in this
      // environment. The readable half above already ran and was asserted; only the access.ts
      // half is skipped, and Vitest's ctx.skip() reports this truthfully as SKIPPED rather than
      // a silent PASS that performed no comparison at all. CI's own "Test (website)" job unlocks
      // git-crypt before this suite runs (ci.yml:1238-1246), so this only trips for
      // forks/local-locked checkouts, never the merge-gating run.
      ctx.skip(
        'access.ts is git-crypt ciphertext in this checkout — readable half already validated above'
      )
    }

    expect(existsSync(ACCESS_PATH)).toBe(true)
    const accessSource = readFileSync(ACCESS_PATH, 'utf8')
    const accessLiterals = extractResultLiteralUnion(accessSource, ACCESS_PATH, 'AuditResult')

    const writerUnion = sortedSet([...readLiterals, ...mutationLiterals, ...accessLiterals])
    expect(websiteSet).toEqual(writerUnion)
  })
})

describe('extractResultLiteralUnion mutation fixtures (PR #2860 gate finding 1)', () => {
  it('catches a union member split across lines — the exact shape the old same-line regex missed', () => {
    const source = `
export type RegistryReadAuditEvent = RegistryAuditEventFields & {
  operation: RegistryReadOperation
  result: 'success' | 'denied' | 'not_found' | 'error'
    | 'failure'
}
`
    console.log('[mutation fixture: multiline union] mutated source:' + source)
    const literals = extractResultLiteralUnion(
      source,
      'fixture:multiline-union.ts',
      'RegistryReadAuditEvent',
      'result'
    )
    expect(sortedSet(literals)).toEqual(
      sortedSet(['success', 'denied', 'not_found', 'error', 'failure'])
    )
    // The old regex extracted only 'success,denied,not_found,error' from this exact shape
    // (verified by the reviewer) — proving this extraction differs from REGISTRY_RESULTS is what
    // makes the sync check bite on a real widening, instead of passing on a stale first-line read.
    expect(sortedSet(literals)).not.toEqual(sortedSet([...REGISTRY_RESULTS]))
  })

  it('does not read a quoted literal inside a same-line comment as a real union member', () => {
    const source = `
export type RegistryMutationAuditEvent = RegistryAuditEventFields & {
  operation: RegistryMutationOperation
  result: 'denied' | 'not_found' // still possible: 'error'
}
`
    console.log('[mutation fixture: comment-forged member] mutated source:' + source)
    const literals = extractResultLiteralUnion(
      source,
      'fixture:comment-forged-member.ts',
      'RegistryMutationAuditEvent',
      'result'
    )
    // 'error' appears only inside the trailing comment, never as a real union member. A
    // comment-blind extractor (the old same-line regex) would read it anyway, forging a match
    // against REGISTRY_RESULTS even though the real union shrank by one member.
    expect(literals).not.toContain('error')
    expect(sortedSet(literals)).toEqual(sortedSet(['denied', 'not_found']))
  })

  it('refuses to silently interpret a union reshaped to reference a type alias', () => {
    const source = `
export type SomeOtherResultAlias = 'denied' | 'not_found' | 'error'
export type RegistryMutationAuditEvent = RegistryAuditEventFields & {
  operation: RegistryMutationOperation
  result: SomeOtherResultAlias
}
`
    console.log('[mutation fixture: alias-reshaped union] mutated source:' + source)
    expect(() =>
      extractResultLiteralUnion(
        source,
        'fixture:alias-reshaped-union.ts',
        'RegistryMutationAuditEvent',
        'result'
      )
    ).toThrow(/refusing to interpret/i)
  })

  it('fails loudly, not on a silently empty set, when the declaration is renamed or moved', () => {
    const source = `
export type RegistryReadAuditEventRenamed = RegistryAuditEventFields & {
  operation: RegistryReadOperation
  result: 'success' | 'denied' | 'not_found' | 'error'
}
`
    console.log('[mutation fixture: renamed declaration] mutated source:' + source)
    expect(() =>
      extractResultLiteralUnion(
        source,
        'fixture:renamed-declaration.ts',
        'RegistryReadAuditEvent',
        'result'
      )
    ).toThrow(/not found/i)
  })
})
