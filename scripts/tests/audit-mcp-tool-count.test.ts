import { describe, it, expect } from 'vitest'
import {
  countToolDefinitions,
  findImportSpecifier,
  extractBuilderBody,
} from '../audit-mcp-tool-count-helpers.mjs'

/**
 * SMI-5216: Check 25 (MCP Tool Count parity) must resolve the `...newAuditToolDefinitions()`
 * spread to the MAXIMUM tool set instead of line-counting it as a single entry.
 * The failure-mode cases below are the load-bearing safety net — any resolution
 * failure must degrade to count-as-1 + a named entry in `unresolvedSpreads`.
 */

// A faithful miniature of mcp-server/src/index.ts: a few plain entries (one of which
// is NOT *ToolSchema), then a spread builder import + use.
const INDEX_WITH_SPREAD = `
import { searchToolSchema } from './tools/search.js'
import { newAuditToolDefinitions } from './audit-tool-dispatch.js'

const installTool = makeInstallTool()

const toolDefinitions = [
  searchToolSchema,
  installTool,
  // a comment line that must be ignored
  ...newAuditToolDefinitions(),
]
`

// The real builder shape: 2 always + 1 conditional push = 3 max.
const DISPATCH_SOURCE = `
import { skillInventoryAuditToolSchema } from './tools/skill-inventory-audit.js'
import { applyNamespaceRenameToolSchema } from './tools/apply-namespace-rename.js'
import { applyRecommendedEditToolSchema } from './tools/apply-recommended-edit.js'

export function newAuditToolDefinitions() {
  const defs = [skillInventoryAuditToolSchema, applyNamespaceRenameToolSchema]
  if (APPLY_TEMPLATE_REGISTRY.size > 0) {
    defs.push(applyRecommendedEditToolSchema)
  }
  return defs
}
`

const resolveTo = (source: string) => () => source
const resolveNull = () => null

describe('countToolDefinitions — counting semantics', () => {
  it('resolves a spread builder to its max *ToolSchema set (2 literals + 1 spread→3 = 3 total here)', () => {
    const { count, unresolvedSpreads } = countToolDefinitions({
      indexContent: INDEX_WITH_SPREAD,
      resolveModuleSource: resolveTo(DISPATCH_SOURCE),
    })
    // 2 plain entries (searchToolSchema, installTool) + 3 from the builder = 5
    expect(count).toBe(5)
    expect(unresolvedSpreads).toEqual([])
  })

  it('counts a non-*ToolSchema literal entry (installTool) as one tool', () => {
    const idx = `
const toolDefinitions = [
  searchToolSchema,
  installTool,
  uninstallTool,
]
`
    const { count, unresolvedSpreads } = countToolDefinitions({
      indexContent: idx,
      resolveModuleSource: resolveNull,
    })
    expect(count).toBe(3)
    expect(unresolvedSpreads).toEqual([])
  })

  it('counts a builder with only array entries (no conditional push)', () => {
    const idx = `
import { b } from './b.js'
const toolDefinitions = [
  aToolSchema,
  ...b(),
]
`
    const builder = `export function b() { return [xToolSchema, yToolSchema] }`
    const { count } = countToolDefinitions({
      indexContent: idx,
      resolveModuleSource: resolveTo(builder),
    })
    expect(count).toBe(3) // aToolSchema + (xToolSchema, yToolSchema)
  })

  it('counts a schema pushed under an `if` (max set, conditional included)', () => {
    const idx = `
import { b } from './b.js'
const toolDefinitions = [
  ...b(),
]
`
    const builder = `export function b() {
      const defs = [oneToolSchema]
      if (flag) defs.push(twoToolSchema)
      return defs
    }`
    const { count } = countToolDefinitions({
      indexContent: idx,
      resolveModuleSource: resolveTo(builder),
    })
    expect(count).toBe(2)
  })

  it('resolves an arrow-function builder via the widened anchor', () => {
    const idx = `
import { b } from './b.js'
const toolDefinitions = [
  ...b(),
]
`
    const builder = `export const b = () => { return [oneToolSchema, twoToolSchema, threeToolSchema] }`
    const { count, unresolvedSpreads } = countToolDefinitions({
      indexContent: idx,
      resolveModuleSource: resolveTo(builder),
    })
    expect(count).toBe(3)
    expect(unresolvedSpreads).toEqual([])
  })

  it('equals the literal count when there is no spread (back-compat)', () => {
    const idx = `const toolDefinitions = [
  aToolSchema,
  bToolSchema,
  cToolSchema,
]`
    const { count, unresolvedSpreads } = countToolDefinitions({
      indexContent: idx,
      resolveModuleSource: resolveNull,
    })
    expect(count).toBe(3)
    expect(unresolvedSpreads).toEqual([])
  })

  it('returns 0 when toolDefinitions is absent', () => {
    const { count } = countToolDefinitions({
      indexContent: 'const other = []',
      resolveModuleSource: resolveNull,
    })
    expect(count).toBe(0)
  })
})

describe('countToolDefinitions — resolution-failure modes (count-as-1 + named warn)', () => {
  const idxWithSpread = `
import { b } from './b.js'
const toolDefinitions = [
  aToolSchema,
  ...b(),
]
`

  it('(a) builder import specifier absent from index → count-as-1, name in unresolvedSpreads', () => {
    const idxNoImport = `const toolDefinitions = [
  aToolSchema,
  ...b(),
]`
    const { count, unresolvedSpreads } = countToolDefinitions({
      indexContent: idxNoImport,
      resolveModuleSource: resolveTo('whatever'),
    })
    expect(count).toBe(2) // aToolSchema + spread-as-1
    expect(unresolvedSpreads).toEqual(['b'])
  })

  it('(b) resolveModuleSource returns null → count-as-1, name in unresolvedSpreads', () => {
    const { count, unresolvedSpreads } = countToolDefinitions({
      indexContent: idxWithSpread,
      resolveModuleSource: resolveNull,
    })
    expect(count).toBe(2)
    expect(unresolvedSpreads).toEqual(['b'])
  })

  it('(b′) resolveModuleSource throws → count-as-1, name in unresolvedSpreads', () => {
    const { count, unresolvedSpreads } = countToolDefinitions({
      indexContent: idxWithSpread,
      resolveModuleSource: () => {
        throw new Error('read failed')
      },
    })
    expect(count).toBe(2)
    expect(unresolvedSpreads).toEqual(['b'])
  })

  it('(c) builder body braces cannot balance → count-as-1, name in unresolvedSpreads', () => {
    const truncated = `export function b() { const defs = [oneToolSchema]` // no closing brace
    const { count, unresolvedSpreads } = countToolDefinitions({
      indexContent: idxWithSpread,
      resolveModuleSource: resolveTo(truncated),
    })
    expect(count).toBe(2)
    expect(unresolvedSpreads).toEqual(['b'])
  })

  it('(d) builder body resolves but has 0 *ToolSchema → count-as-1, name in unresolvedSpreads', () => {
    const empty = `export function b() { return [] }`
    const { count, unresolvedSpreads } = countToolDefinitions({
      indexContent: idxWithSpread,
      resolveModuleSource: resolveTo(empty),
    })
    expect(count).toBe(2)
    expect(unresolvedSpreads).toEqual(['b'])
  })
})

describe('findImportSpecifier', () => {
  it('finds a single-line import', () => {
    expect(findImportSpecifier('foo', `import { foo } from './bar.js'`)).toBe('./bar.js')
  })
  it('finds a name in a multi-line / multi-name import', () => {
    const src = `import {\n  a,\n  foo,\n  b,\n} from './multi.js'`
    expect(findImportSpecifier('foo', src)).toBe('./multi.js')
  })
  it('does not match a substring (bar vs barBaz)', () => {
    expect(findImportSpecifier('bar', `import { barBaz } from './x.js'`)).toBeNull()
  })
  it('returns null when the name is not imported', () => {
    expect(findImportSpecifier('foo', `import { other } from './x.js'`)).toBeNull()
  })
})

describe('extractBuilderBody', () => {
  it('extracts a function-declaration body', () => {
    const body = extractBuilderBody('b', `export function b(): T[] { return [xToolSchema] }`)
    expect(body).toContain('xToolSchema')
  })
  it('skips parameter-destructuring braces', () => {
    const body = extractBuilderBody('b', `const b = ({ a } = {}) => { return [yToolSchema] }`)
    expect(body).toContain('yToolSchema')
    expect(body).not.toContain('= {}')
  })
  it('returns null on unbalanced braces', () => {
    expect(extractBuilderBody('b', `function b() { return [`)).toBeNull()
  })
  it('returns null when the builder is not found', () => {
    expect(extractBuilderBody('missing', `function other() {}`)).toBeNull()
  })
})
