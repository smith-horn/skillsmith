/**
 * Regression test for SMI-6146 (audit:standards Check 63, export-surface
 * coherence).
 *
 * Reproduces the exact SMI-6143 shape: a consumer imports a symbol ('bar')
 * from a workspace sibling that the sibling's SOURCE does NOT actually
 * export — the sibling's `src/index.ts` exports `foo` only — while every
 * version-range STRING involved stays internally consistent: the
 * consumer's own package.json version is bumped (as it legitimately would
 * be in a real release PR), and the sibling's package.json version is left
 * UNCHANGED (per AC3's literal wording: "consumer's package.json version
 * bumped, sibling's package.json version NOT yet bumped"). The fixture's
 * whole point is that the sibling's source deliberately does NOT export
 * 'bar' — that missing export, invisible to any version-string comparison,
 * is exactly what Check 63 must catch by actually reading source.
 *
 * The fixture proves two things:
 *   1. `evaluateInternalVersionCoherence` (Check 58,
 *      scripts/audit-internal-version-coherence-helpers.mjs) reports `ok`
 *      on this exact fixture — the version-arithmetic gap SMI-6146 exists
 *      to close is real, not hypothetical. Check 58 never opens a source
 *      file, so it structurally cannot see that the consumer imports a
 *      name ('bar') the sibling doesn't export.
 *   2. The new Check 63 logic (resolveExportSetForSubpath +
 *      groupConsumerWorkspaceImports + evaluateExportSurfaceCoherence)
 *      reports a violation naming 'bar' on the identical fixture — proving
 *      the new check catches exactly what the old one structurally can't.
 *
 * Matches the pure-function-testing style of
 * scripts/tests/audit-standards-internal-version-coherence.test.ts: no fs
 * I/O, everything injected (in-memory "filesystem" map + readFile/
 * resolveModule callbacks), so this test never touches real files.
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error - .mjs helper has no typings
import { evaluateInternalVersionCoherence } from '../audit-internal-version-coherence-helpers.mjs'
// @ts-expect-error - .mjs helper has no typings
import {
  resolveExportSetForSubpath,
  getPackageExportEntries,
  getPackageOutDir,
  mapDistPathToSourcePath,
} from '../audit-export-surface-resolver-helpers.mjs'
// @ts-expect-error - .mjs helper has no typings
import {
  groupConsumerWorkspaceImports,
  evaluateExportSurfaceCoherence,
  extractWorkspaceImportsFromSource,
  evaluateExportSurfaceShadowGate,
} from '../audit-export-surface-consumer-helpers.mjs'

const SCOPE_PREFIXES = ['@skillsmith/', '@smith-horn/']

describe('SMI-6146 Check 63 regression: export-surface coherence catches what Check 58 cannot', () => {
  // --- Fixture ---------------------------------------------------------
  // sibling: exports `foo` only. package.json version UNCHANGED.
  const SIBLING_PKG_DIR_ABS = '/fake/repo/packages/sibling'
  const siblingPkgJson = {
    name: '@skillsmith/sibling',
    version: '1.0.0',
    exports: {
      '.': {
        types: './dist/src/index.d.ts',
        import: './dist/src/index.js',
        default: './dist/src/index.js',
      },
    },
  }
  const siblingTsconfigJson = { compilerOptions: { outDir: 'dist', rootDir: '.' } }
  const siblingEntrySourcePath = join(SIBLING_PKG_DIR_ABS, 'src/index.ts')

  // consumer: imports { foo, bar } from sibling. package.json version BUMPED.
  const consumerPkgJson = {
    name: '@skillsmith/consumer',
    version: '2.0.0', // bumped from a hypothetical 1.0.0, per AC3's literal wording
    dependencies: { '@skillsmith/sibling': '^1.0.0' },
  }
  const CONSUMER_SOURCE_PATH = 'packages/consumer/src/x.ts'
  const consumerSourceText = "import { foo, bar } from '@skillsmith/sibling'\n"

  // In-memory "filesystem" — only the sibling's entry file exists.
  const fakeFs: Record<string, string> = {
    [siblingEntrySourcePath]: 'export const foo = 1\n',
  }
  const readFile = (absPath: string): string | null => fakeFs[absPath] ?? null
  // No `export * from` chains in this fixture — never actually invoked.
  const resolveModule = (): string | null => null

  it('Check 58 (evaluateInternalVersionCoherence) reports ok — the version-range gap is real, not hypothetical', () => {
    const packagesByDir = {
      sibling: siblingPkgJson,
      consumer: consumerPkgJson,
    }

    const results = evaluateInternalVersionCoherence(packagesByDir)

    expect(results).toEqual([
      {
        dir: 'consumer',
        section: 'dependencies',
        depName: '@skillsmith/sibling',
        range: '^1.0.0',
        actualVersion: '1.0.0',
        status: 'ok',
      },
    ])
  })

  it('Check 63 (export-surface coherence) reports a violation naming "bar" on the identical fixture', () => {
    const { groups } = groupConsumerWorkspaceImports(
      { [CONSUMER_SOURCE_PATH]: consumerSourceText },
      ['@skillsmith/', '@smith-horn/']
    )

    const cache = new Map<string, Set<string>>()
    const resolveExportSet = (packageName: string, subpath: string) => {
      expect(packageName).toBe('@skillsmith/sibling')
      return resolveExportSetForSubpath({
        pkgDirAbs: SIBLING_PKG_DIR_ABS,
        pkgJson: siblingPkgJson,
        tsconfigJson: siblingTsconfigJson,
        subpath,
        readFile,
        resolveModule,
        cache,
      })
    }

    const { missingExportViolations, subpathViolations, unresolvableSurfaceWarnings } =
      evaluateExportSurfaceCoherence(groups, resolveExportSet)

    expect(subpathViolations).toEqual([])
    expect(unresolvableSurfaceWarnings).toEqual([])
    expect(missingExportViolations).toEqual([
      {
        file: CONSUMER_SOURCE_PATH,
        line: 1,
        name: 'bar',
        packageName: '@skillsmith/sibling',
        subpath: '.',
        specifier: '@skillsmith/sibling',
        exportCount: 1,
        entrySourcePath: siblingEntrySourcePath,
      },
    ])
    // 'foo' — the name the sibling DOES export — must not be flagged.
    expect(missingExportViolations.some((v: { name: string }) => v.name === 'foo')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getPackageOutDir + mapDistPathToSourcePath — generic dist->src mapping
// ---------------------------------------------------------------------------

describe('getPackageOutDir + mapDistPathToSourcePath: generic dist->src mapping (Finding 1)', () => {
  it('reads and normalizes compilerOptions.outDir, stripping leading "./" and trailing "/"', () => {
    expect(getPackageOutDir({ compilerOptions: { outDir: './dist/' } })).toBe('dist')
    expect(getPackageOutDir({ compilerOptions: { outDir: 'dist' } })).toBe('dist')
  })

  it('returns null when outDir is absent/unparseable — callers must not assume a "dist" default', () => {
    expect(getPackageOutDir({})).toBeNull()
    expect(getPackageOutDir(null)).toBeNull()
    expect(getPackageOutDir({ compilerOptions: {} })).toBeNull()
    expect(getPackageOutDir({ compilerOptions: { outDir: '' } })).toBeNull()
  })

  it.each([
    // standard src/ shape
    ['./dist/src/index.js', 'dist', 'src/index.ts'],
    ['./dist/src/index.d.ts', 'dist', 'src/index.ts'],
    ['./dist/src/foo/bar.mjs', 'dist', 'src/foo/bar.ts'],
    ['./dist/src/foo/bar.cjs', 'dist', 'src/foo/bar.ts'],
    // core's actual ./testkit exception: the dist path sits under a
    // DIFFERENT top-level dir than src/ (tests/, not src/) — the generic
    // strip-outDir-prefix rule must handle this identically to the src/
    // case, not the narrower "dist/src/X.js -> src/X.ts" rule the original
    // draft used (which crashed/misresolved on exactly this entry).
    ['./dist/tests/testkit.js', 'dist', 'tests/testkit.ts'],
    ['./dist/tests/testkit.d.ts', 'dist', 'tests/testkit.ts'],
  ])('%s (outDir=%s) -> %s', (distRelPath, outDir, expected) => {
    expect(mapDistPathToSourcePath(distRelPath, outDir)).toBe(expected)
  })

  it('returns null (fails loud) when the dist path does not start with the outDir prefix', () => {
    expect(mapDistPathToSourcePath('./build/src/index.js', 'dist')).toBeNull()
  })

  it('returns null (fails loud) for an unrecognized extension', () => {
    expect(mapDistPathToSourcePath('./dist/src/index.json', 'dist')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// getPackageExportEntries — Node `exports` field shape normalization
// ---------------------------------------------------------------------------

describe('getPackageExportEntries: Node exports-field shape normalization (Finding 1)', () => {
  it('bare string form ("exports": "./dist/index.js") -> single "." entry, no subpath keys at all', () => {
    const { hasExportsSurface, entries, wildcardEntries } = getPackageExportEntries({
      exports: './dist/index.js',
    })
    expect(hasExportsSurface).toBe(true)
    expect(entries.get('.')).toBe('./dist/index.js')
    expect(wildcardEntries).toEqual([])
  })

  it('root conditional object ("exports": { import, types, default }) describes "." only — NOT literal "import"/"types" subpaths', () => {
    const { entries } = getPackageExportEntries({
      exports: {
        import: './dist/index.js',
        types: './dist/index.d.ts',
        default: './dist/index.js',
      },
    })
    expect(entries.get('.')).toBe('./dist/index.js')
    expect(entries.has('import')).toBe(false)
    expect(entries.has('types')).toBe(false)
  })

  it('nested/nonstandard conditions recurse to a string target instead of reaching string ops on an object', () => {
    const { entries } = getPackageExportEntries({
      exports: {
        '.': { node: { import: './dist/index.js' }, default: './dist/index.js' },
      },
    })
    expect(entries.get('.')).toBe('./dist/index.js')
  })

  it('an array-of-fallback-targets condition value recurses to the first string found', () => {
    const { entries } = getPackageExportEntries({
      exports: { '.': ['./dist/index.js', './dist/index.cjs'] },
    })
    expect(entries.get('.')).toBe('./dist/index.js')
  })

  it('a wildcard subpath key ("./*") is kept separate from exact-match entries, not stored as a literal "./*" key', () => {
    const { entries, wildcardEntries } = getPackageExportEntries({
      exports: { '.': './dist/index.js', './*': './dist/src/*.js' },
    })
    expect(entries.has('./*')).toBe(false)
    expect(wildcardEntries).toEqual([{ pattern: './*', targetTemplate: './dist/src/*.js' }])
  })

  it('a sibling with none of exports/main/types resolves to hasExportsSurface: false, not a crash', () => {
    expect(getPackageExportEntries({}).hasExportsSurface).toBe(false)
    expect(getPackageExportEntries({ name: '@skillsmith/cli' }).hasExportsSurface).toBe(false)
  })

  it('falls back to "main" then "types" when exports is absent', () => {
    expect(getPackageExportEntries({ main: './dist/index.js' }).entries.get('.')).toBe(
      './dist/index.js'
    )
    expect(getPackageExportEntries({ types: './dist/index.d.ts' }).entries.get('.')).toBe(
      './dist/index.d.ts'
    )
  })
})

// ---------------------------------------------------------------------------
// resolveExportSetForSubpath — export * recursion, subpath resolution,
// wildcard resolution, and every non-'ok' status
// ---------------------------------------------------------------------------

describe('resolveExportSetForSubpath: export * recursion, subpath resolution, and failure-mode statuses', () => {
  const PKG_DIR_ABS = '/fake/repo/packages/multi-entry-sibling'
  const outDirTsconfig = { compilerOptions: { outDir: 'dist', rootDir: '.' } }

  it('recurses through export * chains, unioning all names (delegates to collectTsEntryExports)', () => {
    const pkgJson = {
      name: '@skillsmith/multi-entry-sibling',
      exports: { '.': { types: './dist/src/index.d.ts', import: './dist/src/index.js' } },
    }
    const files: Record<string, string> = {
      [join(PKG_DIR_ABS, 'src/index.ts')]: `export * from './barrel.js'\nexport { Direct }`,
      [join(PKG_DIR_ABS, 'src/barrel.ts')]: `export { Nested }`,
    }
    const readFile = (p: string) => files[p] ?? null
    const resolveModule = (from: string, spec: string) =>
      from === join(PKG_DIR_ABS, 'src/index.ts') && spec === './barrel.js'
        ? join(PKG_DIR_ABS, 'src/barrel.ts')
        : null

    const result = resolveExportSetForSubpath({
      pkgDirAbs: PKG_DIR_ABS,
      pkgJson,
      tsconfigJson: outDirTsconfig,
      subpath: '.',
      readFile,
      resolveModule,
    })

    expect(result.status).toBe('ok')
    expect([...result.names].sort()).toEqual(['Direct', 'Nested'])
  })

  it('guards against a CIRCULAR export * chain — proves the cycle guard actually prevents infinite recursion through THIS resolver, not just in the underlying helper tested in isolation', () => {
    const pkgJson = { name: '@skillsmith/circular-sibling', exports: { '.': './dist/src/a.js' } }
    const files: Record<string, string> = {
      [join(PKG_DIR_ABS, 'src/a.ts')]: `export * from './b.js'\nexport { FromA }`,
      [join(PKG_DIR_ABS, 'src/b.ts')]: `export * from './a.js'\nexport { FromB }`,
    }
    const readFile = (p: string) => files[p] ?? null
    const resolveModule = (_from: string, spec: string) => {
      if (spec === './a.js') return join(PKG_DIR_ABS, 'src/a.ts')
      if (spec === './b.js') return join(PKG_DIR_ABS, 'src/b.ts')
      return null
    }

    const run = () =>
      resolveExportSetForSubpath({
        pkgDirAbs: PKG_DIR_ABS,
        pkgJson,
        tsconfigJson: outDirTsconfig,
        subpath: '.',
        readFile,
        resolveModule,
      })

    expect(run).not.toThrow()
    const result = run()
    expect(result.status).toBe('ok')
    expect([...result.names].sort()).toEqual(['FromA', 'FromB'])
  })

  it('resolves a DECLARED subpath successfully, and reports an UNDECLARED subpath as a distinct violation status', () => {
    const pkgJson = {
      name: '@skillsmith/multi-entry-sibling',
      exports: {
        '.': { types: './dist/src/index.d.ts', import: './dist/src/index.js' },
        './telemetry': { types: './dist/src/telemetry.d.ts', import: './dist/src/telemetry.js' },
      },
    }
    const files: Record<string, string> = {
      [join(PKG_DIR_ABS, 'src/telemetry.ts')]: `export { trackEvent }`,
    }
    const readFile = (p: string) => files[p] ?? null
    const resolveModule = () => null

    const declared = resolveExportSetForSubpath({
      pkgDirAbs: PKG_DIR_ABS,
      pkgJson,
      tsconfigJson: outDirTsconfig,
      subpath: './telemetry',
      readFile,
      resolveModule,
    })
    expect(declared.status).toBe('ok')
    expect([...declared.names]).toEqual(['trackEvent'])

    const undeclared = resolveExportSetForSubpath({
      pkgDirAbs: PKG_DIR_ABS,
      pkgJson,
      tsconfigJson: outDirTsconfig,
      subpath: './nope',
      readFile,
      resolveModule,
    })
    expect(undeclared.status).toBe('subpath-not-declared')
  })

  it('resolves a wildcard subpath ("./*": "./dist/src/*.js") against the actual requested subpath, not as a literal never-matching key', () => {
    const pkgJson = { name: '@skillsmith/wildcard-sibling', exports: { './*': './dist/src/*.js' } }
    const files: Record<string, string> = {
      [join(PKG_DIR_ABS, 'src/foo.ts')]: `export { X }`,
    }
    const result = resolveExportSetForSubpath({
      pkgDirAbs: PKG_DIR_ABS,
      pkgJson,
      tsconfigJson: outDirTsconfig,
      subpath: './foo',
      readFile: (p: string) => files[p] ?? null,
      resolveModule: () => null,
    })
    expect(result.status).toBe('ok')
    expect([...result.names]).toEqual(['X'])
  })

  it('substitutes every "*" occurrence in a wildcard target template, not just the first (CodeQL js/incomplete-string-escaping)', () => {
    const pkgJson = {
      name: '@skillsmith/wildcard-multi-star',
      exports: { './*': './dist/*/index-*.js' },
    }
    const files: Record<string, string> = {
      [join(PKG_DIR_ABS, 'foo/index-foo.ts')]: `export { X }`,
    }
    const result = resolveExportSetForSubpath({
      pkgDirAbs: PKG_DIR_ABS,
      pkgJson,
      tsconfigJson: outDirTsconfig,
      subpath: './foo',
      readFile: (p: string) => files[p] ?? null,
      resolveModule: () => null,
    })
    expect(result.status).toBe('ok')
    // A single-'*'-replace bug would resolve to '.../foo/index-*.js' (second '*'
    // left literal), missing this file entirely and falling through to a
    // different status or an empty export set instead of reading it.
    expect(result.entrySourcePath).not.toContain('*')
    expect([...result.names]).toEqual(['X'])
  })

  it('an unmatched wildcard subpath is still "subpath-not-declared", not silently accepted', () => {
    const pkgJson = {
      name: '@skillsmith/wildcard-sibling',
      exports: { './features/*': './dist/src/features/*.js' },
    }
    const result = resolveExportSetForSubpath({
      pkgDirAbs: PKG_DIR_ABS,
      pkgJson,
      tsconfigJson: outDirTsconfig,
      subpath: './other/thing',
      readFile: () => null,
      resolveModule: () => null,
    })
    expect(result.status).toBe('subpath-not-declared')
  })

  it('reports "no-exports-surface" (not a crash) for a sibling with none of exports/main/types — the packages/cli shape', () => {
    const result = resolveExportSetForSubpath({
      pkgDirAbs: PKG_DIR_ABS,
      pkgJson: { name: '@skillsmith/cli-like' },
      tsconfigJson: outDirTsconfig,
      subpath: '.',
      readFile: () => null,
      resolveModule: () => null,
    })
    expect(result.status).toBe('no-exports-surface')
  })

  it('reports "unmappable-dist-path" (not a crash) when the entry target does not match the sibling\'s own outDir', () => {
    const result = resolveExportSetForSubpath({
      pkgDirAbs: PKG_DIR_ABS,
      pkgJson: { name: '@skillsmith/weird-build', exports: { '.': './build/index.js' } },
      tsconfigJson: outDirTsconfig, // outDir 'dist', but the entry targets 'build/'
      subpath: '.',
      readFile: () => null,
      resolveModule: () => null,
    })
    expect(result.status).toBe('unmappable-dist-path')
  })

  it('returns an empty (not thrown) export set when the resolved entry FILE itself is missing', () => {
    const result = resolveExportSetForSubpath({
      pkgDirAbs: PKG_DIR_ABS,
      pkgJson: { name: '@skillsmith/missing-entry', exports: { '.': './dist/src/index.js' } },
      tsconfigJson: outDirTsconfig,
      subpath: '.',
      readFile: () => null, // entry file does not exist
      resolveModule: () => null,
    })
    expect(result.status).toBe('ok')
    expect(result.names.size).toBe(0)
  })

  it('end-to-end: an import from an undeclared subpath produces a subpathViolations entry via evaluateExportSurfaceCoherence', () => {
    const pkgJson = {
      name: '@skillsmith/multi-entry-sibling',
      exports: { '.': './dist/src/index.js' },
    }
    const { groups } = groupConsumerWorkspaceImports(
      {
        'packages/consumer/src/x.ts':
          "import { Foo } from '@skillsmith/multi-entry-sibling/nope'\n",
      },
      SCOPE_PREFIXES
    )
    const resolveExportSet = () =>
      resolveExportSetForSubpath({
        pkgDirAbs: PKG_DIR_ABS,
        pkgJson,
        tsconfigJson: outDirTsconfig,
        subpath: './nope',
        readFile: () => null,
        resolveModule: () => null,
      })
    const { subpathViolations, missingExportViolations } = evaluateExportSurfaceCoherence(
      groups,
      resolveExportSet
    )
    expect(missingExportViolations).toEqual([])
    expect(subpathViolations).toEqual([
      {
        packageName: '@skillsmith/multi-entry-sibling',
        subpath: './nope',
        specifier: '@skillsmith/multi-entry-sibling/nope',
        occurrences: [{ file: 'packages/consumer/src/x.ts', line: 1, name: 'Foo' }],
      },
    ])
  })
})

// ---------------------------------------------------------------------------
// extractWorkspaceImportsFromSource — static ImportDeclaration + ImportTypeNode
// ---------------------------------------------------------------------------

describe('extractWorkspaceImportsFromSource: static ImportDeclaration + ImportTypeNode extraction', () => {
  it('symbol aliasing "X as Y" checks the PRE-alias name (X), not the local alias (Y)', () => {
    const src = "import { X as Y } from '@skillsmith/sibling'\nconsole.log(Y)\n"
    const { named } = extractWorkspaceImportsFromSource('f.ts', src, SCOPE_PREFIXES)
    expect(named).toEqual([
      {
        file: 'f.ts',
        line: 1,
        packageName: '@skillsmith/sibling',
        subpath: '.',
        specifier: '@skillsmith/sibling',
        name: 'X',
        kind: 'named',
      },
    ])
  })

  it('"import type { X }" and per-specifier "type X" are both still checked as named imports', () => {
    const src = [
      "import type { X } from '@skillsmith/sibling'",
      "import { type Y } from '@skillsmith/sibling'",
    ].join('\n')
    const { named } = extractWorkspaceImportsFromSource('f.ts', src, SCOPE_PREFIXES)
    expect(named.map((n: { name: string }) => n.name).sort()).toEqual(['X', 'Y'])
    expect(named.every((n: { kind: string }) => n.kind === 'named')).toBe(true)
  })

  it("ImportTypeNode inline type query import('pkg').Foo — the live get-skill.ts pattern", () => {
    const src = "type T = import('@skillsmith/core').TrustTier\n"
    const { named } = extractWorkspaceImportsFromSource('f.ts', src, SCOPE_PREFIXES)
    expect(named).toEqual([
      {
        file: 'f.ts',
        line: 1,
        packageName: '@skillsmith/core',
        subpath: '.',
        specifier: '@skillsmith/core',
        name: 'TrustTier',
        kind: 'type-query',
      },
    ])
  })

  it("a nested ImportTypeNode qualifier (import('pkg').Foo.Bar) checks only the BASE name (Foo)", () => {
    const src = "type T = import('@skillsmith/core').Foo.Bar\n"
    const { named } = extractWorkspaceImportsFromSource('f.ts', src, SCOPE_PREFIXES)
    expect(named.map((n: { name: string }) => n.name)).toEqual(['Foo'])
  })

  it("a qualifier-less ImportTypeNode (typeof import('pkg')) names no symbol — nothing to check, nothing to roll up", () => {
    const src = "type T = typeof import('@skillsmith/core')\n"
    const { named, unchecked } = extractWorkspaceImportsFromSource('f.ts', src, SCOPE_PREFIXES)
    expect(named).toEqual([])
    expect(unchecked).toEqual([])
  })

  it('default and namespace imports are counted into "unchecked" for the rollup tally, not silently dropped', () => {
    const src = [
      "import Foo from '@skillsmith/sibling'",
      "import * as Bar from '@smith-horn/other'",
    ].join('\n')
    const { named, unchecked } = extractWorkspaceImportsFromSource('f.ts', src, SCOPE_PREFIXES)
    expect(named).toEqual([])
    expect(unchecked.map((u: { kind: string }) => u.kind).sort()).toEqual(['default', 'namespace'])
  })

  it('a side-effect-only import (no clause) is neither checked nor counted', () => {
    const src = "import '@skillsmith/sibling'\n"
    const { named, unchecked } = extractWorkspaceImportsFromSource('f.ts', src, SCOPE_PREFIXES)
    expect(named).toEqual([])
    expect(unchecked).toEqual([])
  })

  it('a non-workspace specifier is ignored entirely', () => {
    const src = "import { readFile } from 'node:fs'\n"
    const { named, unchecked } = extractWorkspaceImportsFromSource('f.ts', src, SCOPE_PREFIXES)
    expect(named).toEqual([])
    expect(unchecked).toEqual([])
  })

  it('an empty source file is skipped cleanly — no throw, no findings', () => {
    expect(() => extractWorkspaceImportsFromSource('f.ts', '', SCOPE_PREFIXES)).not.toThrow()
    const { named, unchecked } = extractWorkspaceImportsFromSource('f.ts', '', SCOPE_PREFIXES)
    expect(named).toEqual([])
    expect(unchecked).toEqual([])
  })

  it("a malformed/unparseable source file is tolerated — TS's syntactic parser recovers rather than throwing", () => {
    const malformed = "import { X from '@skillsmith/sibling'\nfunction broken( {\n"
    expect(() => extractWorkspaceImportsFromSource('f.ts', malformed, SCOPE_PREFIXES)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// extractWorkspaceImportsFromSource — dynamic import(...) call expressions
// (Finding 2 / SMI-6146 gap: the same failure class as SMI-6143 via a
// different AST shape, CallExpression rather than ImportDeclaration)
// ---------------------------------------------------------------------------

describe('extractWorkspaceImportsFromSource: dynamic import(...) call expressions (Finding 2)', () => {
  it('destructured awaited dynamic import — const { X, Y: Z } = await import(pkg) checks pre-alias names', () => {
    const src = [
      'async function f() {',
      "  const { X, Y: Z } = await import('@skillsmith/sibling')",
      '  return X + Z',
      '}',
    ].join('\n')
    const { named, unchecked } = extractWorkspaceImportsFromSource('f.ts', src, SCOPE_PREFIXES)
    expect(
      named.map((n: { name: string; kind: string }) => ({ name: n.name, kind: n.kind }))
    ).toEqual([
      { name: 'X', kind: 'dynamic-named' },
      { name: 'Y', kind: 'dynamic-named' },
    ])
    expect(unchecked).toEqual([])
  })

  it('direct property access on the awaited namespace object — (await import(pkg)).X', () => {
    const src = [
      'async function f() {',
      "  return (await import('@skillsmith/sibling')).trackEvent",
      '}',
    ].join('\n')
    const { named } = extractWorkspaceImportsFromSource('f.ts', src, SCOPE_PREFIXES)
    expect(
      named.map((n: { name: string; kind: string }) => ({ name: n.name, kind: n.kind }))
    ).toEqual([{ name: 'trackEvent', kind: 'dynamic-property-access' }])
  })

  it('the whole-namespace-object-passed-around shape — live in packages/enterprise/src/audit/scheduled-scan.ts — is counted UNCHECKED, not silently dropped and not incorrectly resolved', () => {
    // Reproduces the actual loadRunInventoryAudit() shape in
    // scheduled-scan.ts: `const mod = (await import(...)) as {...}` then,
    // in a SEPARATE later statement, `return mod.runInventoryAudit`. This
    // function does not track identifier references across statements, so
    // this is genuinely unresolvable here and must be counted into the
    // rollup tally, not skipped uncounted.
    const src = [
      'async function loadRunInventoryAudit() {',
      "  const mod = (await import('@skillsmith/mcp-server/audit')) as {",
      '    runInventoryAudit: RunInventoryAuditFn',
      '  }',
      '  return mod.runInventoryAudit',
      '}',
    ].join('\n')
    const { named, unchecked } = extractWorkspaceImportsFromSource('f.ts', src, SCOPE_PREFIXES)
    expect(named).toEqual([])
    expect(unchecked).toEqual([
      {
        file: 'f.ts',
        line: 2,
        packageName: '@skillsmith/mcp-server',
        subpath: './audit',
        specifier: '@skillsmith/mcp-server/audit',
        kind: 'dynamic-unresolved',
      },
    ])
  })

  it('an un-awaited dynamic import (import(pkg).then(...)) is counted unchecked, not resolved', () => {
    const src = "import('@skillsmith/sibling').then((mod) => mod.trackEvent)\n"
    const { named, unchecked } = extractWorkspaceImportsFromSource('f.ts', src, SCOPE_PREFIXES)
    expect(named).toEqual([])
    expect(unchecked.map((u: { kind: string }) => u.kind)).toEqual(['dynamic-unresolved'])
  })

  it('destructuring the namespace object\'s "default" property is unchecked — module default export, not a named export to look up', () => {
    const src = [
      'async function f() {',
      "  const { default: Foo } = await import('@skillsmith/sibling')",
      '  return Foo',
      '}',
    ].join('\n')
    const { named, unchecked } = extractWorkspaceImportsFromSource('f.ts', src, SCOPE_PREFIXES)
    expect(named).toEqual([])
    expect(unchecked.map((u: { kind: string }) => u.kind)).toEqual(['dynamic-default'])
  })

  it('a rest-binding destructure (const { ...rest } = await import(pkg)) is unchecked — unknown breadth', () => {
    const src = [
      'async function f() {',
      "  const { ...rest } = await import('@skillsmith/sibling')",
      '  return rest',
      '}',
    ].join('\n')
    const { unchecked } = extractWorkspaceImportsFromSource('f.ts', src, SCOPE_PREFIXES)
    expect(unchecked.map((u: { kind: string }) => u.kind)).toEqual(['dynamic-unresolved'])
  })

  it('a non-workspace dynamic import specifier is ignored entirely', () => {
    const src = "async function f() { const { readFile } = await import('node:fs/promises') }\n"
    const { named, unchecked } = extractWorkspaceImportsFromSource('f.ts', src, SCOPE_PREFIXES)
    expect(named).toEqual([])
    expect(unchecked).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// evaluateExportSurfaceShadowGate — Check 63 driver's shadow-burn-in +
// opt-out-marker gate (Finding 3: driver-level coverage)
// ---------------------------------------------------------------------------

describe('evaluateExportSurfaceShadowGate: Check 63 driver shadow-burn-in + opt-out-marker gate', () => {
  const SKIP_MARKER = '[skip-export-surface-check]'

  it('in-shadow-warn: now before shadowEndDate -> inShadow true, report "warn", marker never checked even if present', () => {
    const result = evaluateExportSurfaceShadowGate({
      shadowEndDate: '2026-09-01',
      now: new Date('2026-08-15T00:00:00Z'),
      prBody: `some PR body with ${SKIP_MARKER} in it`,
      skipMarker: SKIP_MARKER,
    })
    expect(result.inShadow).toBe(true)
    expect(result.report).toBe('warn')
    expect(result.shadowSuffix).toContain('shadow mode through 2026-09-01')
    expect(result.skipAcknowledged).toBe(false)
  })

  it('post-shadow-fail: now on/after shadowEndDate, no marker -> inShadow false, report "fail", not acknowledged', () => {
    const result = evaluateExportSurfaceShadowGate({
      shadowEndDate: '2026-09-01',
      now: new Date('2026-09-02T00:00:00Z'),
      prBody: 'no marker here',
      skipMarker: SKIP_MARKER,
    })
    expect(result.inShadow).toBe(false)
    expect(result.report).toBe('fail')
    expect(result.shadowSuffix).toBe('')
    expect(result.skipAcknowledged).toBe(false)
  })

  it('marker-present-suppresses-failure: post-shadow + marker in PR body -> skipAcknowledged true (the driver downgrades to warn() when acknowledged)', () => {
    const result = evaluateExportSurfaceShadowGate({
      shadowEndDate: '2026-09-01',
      now: new Date('2026-09-02T00:00:00Z'),
      prBody: `Reason paragraph. ${SKIP_MARKER}`,
      skipMarker: SKIP_MARKER,
    })
    expect(result.inShadow).toBe(false)
    expect(result.report).toBe('fail')
    expect(result.skipAcknowledged).toBe(true)
  })

  it('a missing/undefined PR body does not throw and is treated as no marker present', () => {
    const params = {
      shadowEndDate: '2026-09-01',
      now: new Date('2026-09-02T00:00:00Z'),
      prBody: undefined,
      skipMarker: SKIP_MARKER,
    }
    expect(() => evaluateExportSurfaceShadowGate(params)).not.toThrow()
    expect(evaluateExportSurfaceShadowGate(params).skipAcknowledged).toBe(false)
  })
})
