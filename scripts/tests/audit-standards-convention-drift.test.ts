/**
 * Tests for Check 48 helpers in audit-standards-helpers.mjs (SMI-5026 M5).
 *
 * Check 48 encodes the "Convention check before novelty" greps from the
 * `skill-invoke-telemetry.md` plan as static invariants that re-run on every
 * PR. This test file covers the four pure helpers it composes:
 *
 *   - parseStringUnionType    (48a)
 *   - parseTsLiteralArray     (48b)
 *   - findFunctionDefinitions (48c)
 *   - findTmpSkillsmithRefs   (48d)
 *
 * Plus the composer `findConventionDrift` end-to-end.
 *
 * Convention follows `audit-standards-parse-bash-array.test.ts` (Check 47):
 * dynamic ESM import, in-memory fixtures, no I/O.
 */
import { describe, expect, it } from 'vitest'

type DriftResult = {
  eventTypeUnionMissing: string[]
  allowedEventsMissing: string[]
  eventTypeUnionParseFailed: boolean
  allowedEventsParseFailed: boolean
  parallelWithTelemetryDefs: { file: string; line: number; snippet: string }[]
  tmpSkillsmithRefs: { file: string; line: number; snippet: string }[]
}

const helpers = (await import('../audit-standards-helpers.mjs')) as {
  parseStringUnionType: (src: string, typeName: string) => Set<string> | null
  parseTsLiteralArray: (src: string, arrayName: string) => Set<string> | null
  findFunctionDefinitions: (
    srcByPath: Record<string, string>,
    symbol: string
  ) => { file: string; line: number; snippet: string }[]
  findTmpSkillsmithRefs: (
    srcByPath: Record<string, string>
  ) => { file: string; line: number; snippet: string }[]
  findConventionDrift: (input: {
    posthogSrc: string
    eventsSrc: string
    surveySrcByPath: Record<string, string>
    expectedNewEvents: string[]
    canonicalWithTelemetryPath: string
  }) => DriftResult
}

const {
  parseStringUnionType,
  parseTsLiteralArray,
  findFunctionDefinitions,
  findTmpSkillsmithRefs,
  findConventionDrift,
} = helpers

// ---------------------------------------------------------------------------
// parseStringUnionType
// ---------------------------------------------------------------------------

describe('parseStringUnionType', () => {
  it('parses a canonical leading-pipe union (the SMI-5026 shape)', () => {
    const src = `export type SkillsmithEventType =
  | 'skill_search'
  | 'skill_view'
  | 'skill_invoke'
  | 'skill_invoke_unparsed'

export interface Foo {}`
    const result = parseStringUnionType(src, 'SkillsmithEventType')
    expect(result).not.toBeNull()
    expect([...result!].sort()).toEqual([
      'skill_invoke',
      'skill_invoke_unparsed',
      'skill_search',
      'skill_view',
    ])
  })

  it('returns null when the type is not declared', () => {
    const src = `export interface Foo {}\nexport const bar = 1\n`
    expect(parseStringUnionType(src, 'SkillsmithEventType')).toBeNull()
  })

  it('handles non-exported type declarations', () => {
    const src = `type Inner = 'a' | 'b'\n\nexport function f() {}`
    const result = parseStringUnionType(src, 'Inner')
    expect([...result!].sort()).toEqual(['a', 'b'])
  })

  it('does not over-extend past the next top-level keyword', () => {
    const src = `type EventA = 'a' | 'b'\ntype EventB = 'x' | 'y'`
    const result = parseStringUnionType(src, 'EventA')
    expect([...result!].sort()).toEqual(['a', 'b'])
    // Crucially, must NOT include x/y from EventB
    expect(result!.has('x')).toBe(false)
  })

  it('ignores non-literal content between members', () => {
    const src = `export type Mix =\n  | 'a'\n  // comment\n  | 'b'\n\nfunction foo() {}`
    const result = parseStringUnionType(src, 'Mix')
    expect([...result!].sort()).toEqual(['a', 'b'])
  })
})

// ---------------------------------------------------------------------------
// parseTsLiteralArray
// ---------------------------------------------------------------------------

describe('parseTsLiteralArray', () => {
  it('parses a canonical `as const` literal array', () => {
    const src = `const ALLOWED_EVENTS = [
  'skill_view',
  'skill_install',
  'skill_invoke',
] as const`
    const result = parseTsLiteralArray(src, 'ALLOWED_EVENTS')
    expect([...result!].sort()).toEqual(['skill_install', 'skill_invoke', 'skill_view'])
  })

  it('returns null when the array is not declared', () => {
    expect(parseTsLiteralArray('const FOO = 1', 'ALLOWED_EVENTS')).toBeNull()
  })

  it('strips line comments so commented-out entries are not counted', () => {
    const src = `const X = [
  'real',
  // 'legacy',  ← removed in SMI-1234
] as const`
    const result = parseTsLiteralArray(src, 'X')
    expect([...result!]).toEqual(['real'])
    expect(result!.has('legacy')).toBe(false)
  })

  it('handles arrays with trailing inline comments', () => {
    const src = `const X = [\n  'a', // canonical\n  'b',\n] as const`
    const result = parseTsLiteralArray(src, 'X')
    expect([...result!].sort()).toEqual(['a', 'b'])
  })
})

// ---------------------------------------------------------------------------
// findFunctionDefinitions
// ---------------------------------------------------------------------------

describe('findFunctionDefinitions', () => {
  it('finds an exported function declaration', () => {
    const result = findFunctionDefinitions(
      { 'a.ts': 'export function withTelemetry(fn: Fn) { return fn }' },
      'withTelemetry'
    )
    expect(result).toHaveLength(1)
    expect(result[0].file).toBe('a.ts')
  })

  it('finds a const-arrow definition', () => {
    const result = findFunctionDefinitions(
      { 'a.ts': 'export const withTelemetry = (fn) => fn' },
      'withTelemetry'
    )
    expect(result).toHaveLength(1)
  })

  it('does NOT flag call sites', () => {
    const result = findFunctionDefinitions(
      { 'a.ts': 'export const handler = withTelemetry(impl, { tool: "x" })' },
      'withTelemetry'
    )
    expect(result).toHaveLength(0)
  })

  it('finds parallel definitions across multiple files', () => {
    const result = findFunctionDefinitions(
      {
        'wrap.ts': 'export function withTelemetry<F>(fn: F): F { return fn }',
        'shim.ts': 'const withTelemetry = (fn: any) => fn',
      },
      'withTelemetry'
    )
    expect(result).toHaveLength(2)
    expect(result.map((d) => d.file).sort()).toEqual(['shim.ts', 'wrap.ts'])
  })

  it('rejects regex-metachar symbol names (defense-in-depth)', () => {
    expect(findFunctionDefinitions({ 'a.ts': 'function .* () {}' }, '.*')).toEqual([])
  })

  it('ignores object-method definitions (heuristic limitation)', () => {
    // Object methods like `{ withTelemetry() { ... } }` are not detected.
    // This is acceptable because the SMI-5016 canonical shape is a top-level
    // function export, not an object method.
    const result = findFunctionDefinitions(
      { 'a.ts': 'const obj = { withTelemetry() { return null } }' },
      'withTelemetry'
    )
    expect(result).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// findTmpSkillsmithRefs
// ---------------------------------------------------------------------------

describe('findTmpSkillsmithRefs', () => {
  it('flags a production source reference', () => {
    const result = findTmpSkillsmithRefs({
      'packages/cli/src/runtime.ts': "const r = '/tmp/skillsmith-' + sid",
    })
    expect(result).toHaveLength(1)
    expect(result[0].file).toBe('packages/cli/src/runtime.ts')
  })

  it('ignores test files', () => {
    const result = findTmpSkillsmithRefs({
      'packages/cli/src/foo.test.ts': "const r = '/tmp/skillsmith-test'",
      'packages/cli/src/foo.spec.ts': "const r = '/tmp/skillsmith-test'",
      'packages/cli/src/__tests__/x.ts': "const r = '/tmp/skillsmith-test'",
      'packages/cli/tests/x.ts': "const r = '/tmp/skillsmith-test'",
      'supabase/functions/foo/_tests_/x.ts': "const r = '/tmp/skillsmith-test'",
      'scripts/e2e/setup.ts': "const r = '/tmp/skillsmith-test'",
      'packages/cli/src/fixtures/x.ts': "const r = '/tmp/skillsmith-test'",
    })
    expect(result).toHaveLength(0)
  })

  it('honours the audit:check-48-ack opt-out marker', () => {
    const result = findTmpSkillsmithRefs({
      'packages/cli/src/x.ts': "const r = '/tmp/skillsmith-doc'  // audit:check-48-ack example",
    })
    expect(result).toHaveLength(0)
  })

  it('flags only the un-acked line when both present', () => {
    const src = `const a = '/tmp/skillsmith-1'  // audit:check-48-ack docs\nconst b = '/tmp/skillsmith-2'`
    const result = findTmpSkillsmithRefs({ 'p/x.ts': src })
    expect(result).toHaveLength(1)
    expect(result[0].line).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// findConventionDrift — end-to-end composer
// ---------------------------------------------------------------------------

describe('findConventionDrift', () => {
  const CANONICAL_POSTHOG = `export type SkillsmithEventType =
  | 'skill_search'
  | 'skill_invoke'
  | 'skill_context_load'
  | 'skill_invoke_unparsed'

export interface Foo {}`

  const CANONICAL_EVENTS = `const ALLOWED_EVENTS = [
  'skill_view',
  'skill_invoke',
  'skill_context_load',
  'skill_invoke_unparsed',
] as const`

  const EXPECTED = ['skill_invoke', 'skill_context_load', 'skill_invoke_unparsed']
  const CANONICAL_WRAP = 'packages/core/src/telemetry/wrap.ts'

  it('reports clean for canonical SMI-5026 state', () => {
    const r = findConventionDrift({
      posthogSrc: CANONICAL_POSTHOG,
      eventsSrc: CANONICAL_EVENTS,
      surveySrcByPath: {
        [CANONICAL_WRAP]: 'export function withTelemetry<F>(fn: F): F { return fn }',
      },
      expectedNewEvents: EXPECTED,
      canonicalWithTelemetryPath: CANONICAL_WRAP,
    })
    expect(r.eventTypeUnionMissing).toEqual([])
    expect(r.allowedEventsMissing).toEqual([])
    expect(r.parallelWithTelemetryDefs).toEqual([])
    expect(r.tmpSkillsmithRefs).toEqual([])
  })

  it('flags a missing union member (48a fail surface)', () => {
    const r = findConventionDrift({
      posthogSrc: `export type SkillsmithEventType = | 'skill_search'\n\nexport const x = 1`,
      eventsSrc: CANONICAL_EVENTS,
      surveySrcByPath: {},
      expectedNewEvents: EXPECTED,
      canonicalWithTelemetryPath: CANONICAL_WRAP,
    })
    expect(r.eventTypeUnionMissing).toEqual(EXPECTED)
  })

  it('flags a missing ALLOWED_EVENTS entry (48b fail surface)', () => {
    const r = findConventionDrift({
      posthogSrc: CANONICAL_POSTHOG,
      eventsSrc: `const ALLOWED_EVENTS = ['skill_view'] as const`,
      surveySrcByPath: {},
      expectedNewEvents: EXPECTED,
      canonicalWithTelemetryPath: CANONICAL_WRAP,
    })
    expect(r.allowedEventsMissing).toEqual(EXPECTED)
  })

  it('flags a parallel withTelemetry definition (48c warn surface)', () => {
    const r = findConventionDrift({
      posthogSrc: CANONICAL_POSTHOG,
      eventsSrc: CANONICAL_EVENTS,
      surveySrcByPath: {
        [CANONICAL_WRAP]: 'export function withTelemetry<F>(fn: F): F { return fn }',
        'packages/website/src/shim.ts': 'export const withTelemetry = (fn: any) => fn',
      },
      expectedNewEvents: EXPECTED,
      canonicalWithTelemetryPath: CANONICAL_WRAP,
    })
    expect(r.parallelWithTelemetryDefs).toHaveLength(1)
    expect(r.parallelWithTelemetryDefs[0].file).toBe('packages/website/src/shim.ts')
  })

  it('does not flag call sites (48c true-negative)', () => {
    const r = findConventionDrift({
      posthogSrc: CANONICAL_POSTHOG,
      eventsSrc: CANONICAL_EVENTS,
      surveySrcByPath: {
        [CANONICAL_WRAP]: 'export function withTelemetry<F>(fn: F): F { return fn }',
        'packages/mcp-server/src/tools/search.ts':
          'export const executeSearch = withTelemetry(executeSearchImpl, {})',
      },
      expectedNewEvents: EXPECTED,
      canonicalWithTelemetryPath: CANONICAL_WRAP,
    })
    expect(r.parallelWithTelemetryDefs).toEqual([])
  })

  it('flags /tmp/skillsmith- in prod but ignores tests (48d)', () => {
    const r = findConventionDrift({
      posthogSrc: CANONICAL_POSTHOG,
      eventsSrc: CANONICAL_EVENTS,
      surveySrcByPath: {
        'packages/cli/src/runtime.ts': "const r = '/tmp/skillsmith-foo'",
        'packages/cli/src/runtime.test.ts': "const r = '/tmp/skillsmith-test'",
      },
      expectedNewEvents: EXPECTED,
      canonicalWithTelemetryPath: CANONICAL_WRAP,
    })
    expect(r.tmpSkillsmithRefs).toHaveLength(1)
    expect(r.tmpSkillsmithRefs[0].file).toBe('packages/cli/src/runtime.ts')
  })

  it('sets parseFailed flags when source is unparseable', () => {
    const r = findConventionDrift({
      posthogSrc: 'const foo = 1\n',
      eventsSrc: 'export function noArray() {}\n',
      surveySrcByPath: {},
      expectedNewEvents: EXPECTED,
      canonicalWithTelemetryPath: CANONICAL_WRAP,
    })
    expect(r.eventTypeUnionParseFailed).toBe(true)
    expect(r.allowedEventsParseFailed).toBe(true)
    // When parse fails, the "missing" list is empty by contract (parseFailed
    // surfaces via warn; missing-list is the fail signal).
    expect(r.eventTypeUnionMissing).toEqual([])
    expect(r.allowedEventsMissing).toEqual([])
  })
})
