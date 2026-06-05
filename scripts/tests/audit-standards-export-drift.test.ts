/**
 * SMI-4193: smoke-test export-drift helpers (Check 29).
 *
 * Covers parseTsExports / collectTsEntryExports / extractSmokeTestRequiredArrays
 * — the pure helpers that detect when a smoke-test `required` array references a
 * symbol the (mock) core barrel no longer exports.
 *
 * Split out of audit-standards.test.ts (SMI-5141) to keep that file under the
 * 500-line CI gate. The pure helpers are imported via dynamic ESM import from a
 * companion .mjs, matching the convention used across the audit-standards-*
 * test siblings.
 */
import { describe, expect, it } from 'vitest'

const helpers = (await import('../audit-standards-helpers.mjs')) as {
  parseTsExports: (content: string) => { names: Set<string>; starFrom: string[] }
  collectTsEntryExports: (
    entryPath: string,
    readFile: (p: string) => string | null,
    resolveModule: (fromFile: string, spec: string) => string | null
  ) => Set<string>
  extractSmokeTestRequiredArrays: (content: string) => { name: string; arrayIndex: number }[]
}

const { parseTsExports, collectTsEntryExports, extractSmokeTestRequiredArrays } = helpers

describe('parseTsExports', () => {
  it('extracts named exports from export { ... }', () => {
    const src = `export { Foo, Bar as Baz, type Qux } from './x.js'\nexport { Alone }`
    const { names, starFrom } = parseTsExports(src)
    expect([...names].sort()).toEqual(['Alone', 'Baz', 'Foo', 'Qux'])
    expect(starFrom).toEqual([])
  })

  it('extracts function/const/class/enum/interface/type declarations', () => {
    const src = `
      export function foo() {}
      export async function asyncFoo() {}
      export const bar = 1
      export class Baz {}
      export enum MyEnum {}
      export interface MyIface {}
      export type MyType = string
    `
    const { names } = parseTsExports(src)
    expect([...names].sort()).toEqual(
      ['MyEnum', 'MyIface', 'MyType', 'asyncFoo', 'bar', 'Baz', 'foo'].sort()
    )
  })

  it('records export * from chains in starFrom, not names', () => {
    const src = `export * from './exports/services.js'\nexport * from './exports/repositories.js'`
    const { names, starFrom } = parseTsExports(src)
    expect(names.size).toBe(0)
    expect(starFrom).toEqual(['./exports/services.js', './exports/repositories.js'])
  })

  it('ignores exports inside block comments (SMI-4189 pattern)', () => {
    const src = `/* export { Removed } from './old.js' */\nexport { Kept }`
    const { names } = parseTsExports(src)
    expect([...names]).toEqual(['Kept'])
  })
})

describe('collectTsEntryExports', () => {
  it('walks export * chains and unions all names', () => {
    const files: Record<string, string> = {
      '/src/index.ts': `export * from './barrel.js'\nexport { Direct }`,
      '/src/barrel.ts': `export { Nested1, Nested2 }`,
    }
    const readFile = (p: string) => files[p] ?? null
    const resolveModule = (from: string, spec: string) => {
      if (from === '/src/index.ts' && spec === './barrel.js') return '/src/barrel.ts'
      return null
    }
    const result = collectTsEntryExports('/src/index.ts', readFile, resolveModule)
    expect([...result].sort()).toEqual(['Direct', 'Nested1', 'Nested2'])
  })

  it('tolerates unresolvable barrels without throwing', () => {
    const files: Record<string, string> = {
      '/src/index.ts': `export * from './missing.js'\nexport { Kept }`,
    }
    const readFile = (p: string) => files[p] ?? null
    const resolveModule = () => null
    const result = collectTsEntryExports('/src/index.ts', readFile, resolveModule)
    expect([...result]).toEqual(['Kept'])
  })

  it('guards against circular export * chains', () => {
    const files: Record<string, string> = {
      '/a.ts': `export * from './b.js'\nexport { FromA }`,
      '/b.ts': `export * from './a.js'\nexport { FromB }`,
    }
    const readFile = (p: string) => files[p] ?? null
    const resolveModule = (_from: string, spec: string) =>
      spec === './a.js' ? '/a.ts' : spec === './b.js' ? '/b.ts' : null
    const result = collectTsEntryExports('/a.ts', readFile, resolveModule)
    expect([...result].sort()).toEqual(['FromA', 'FromB'])
  })
})

describe('extractSmokeTestRequiredArrays', () => {
  it('captures names from every required array with stable arrayIndex', () => {
    const src = `
      const required = ['A', 'B', 'C']
      // later
      const required = [
        'D',
        'E'
      ]
    `
    const out = extractSmokeTestRequiredArrays(src)
    expect(out).toEqual([
      { name: 'A', arrayIndex: 0 },
      { name: 'B', arrayIndex: 0 },
      { name: 'C', arrayIndex: 0 },
      { name: 'D', arrayIndex: 1 },
      { name: 'E', arrayIndex: 1 },
    ])
  })

  it('ignores required arrays that appear only inside comments', () => {
    const src = `// const required = ['Commented']\nconst required = ['Real']`
    const out = extractSmokeTestRequiredArrays(src)
    expect(out).toEqual([{ name: 'Real', arrayIndex: 0 }])
  })

  it('returns empty array when no required declarations exist', () => {
    const src = `const something = ['NotRequired']`
    expect(extractSmokeTestRequiredArrays(src)).toEqual([])
  })

  it('detects SMI-4189 regression: CategoryRepository drift against a mock core', () => {
    // Simulates the exact pattern that shipped in smoke-test@0.4.4 and caused
    // the failed republish. The `required` array references `CategoryRepository`,
    // but the mock core only exports `SkillRepository`.
    const smokeSrc = `const required = ['SkillRepository', 'CategoryRepository', 'createDatabaseSync']`
    const files: Record<string, string> = {
      '/core/index.ts': `export { SkillRepository, createDatabaseSync }`,
    }
    const coreExports = collectTsEntryExports(
      '/core/index.ts',
      (p) => files[p] ?? null,
      () => null
    )
    const entries = extractSmokeTestRequiredArrays(smokeSrc)
    const missing = entries.filter((e) => !coreExports.has(e.name))
    expect(missing.map((m) => m.name)).toEqual(['CategoryRepository'])
  })
})
