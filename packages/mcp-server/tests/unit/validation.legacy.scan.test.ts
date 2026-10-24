/**
 * SMI-7168: source scans that keep the zod 3 error contract from eroding.
 *
 * 1. Every zod parse must go through `validation.legacy.ts` (`legacySafeParse`, `legacyParse`, or
 *    `safeParseOrError`, which wraps them). A bare `schema.parse(` or `schema.safeParse(` would
 *    surface zod 4's wording and codes to clients while every existing test stayed green.
 * 2. `validation.legacy.ts` only reproduces zod 3's wording for the issue kinds this repo uses.
 *    Other schema builders fall back silently to zod 4's own text, so introducing one must be a
 *    deliberate act: add a message and code for it there, and parity cases for it, then remove it
 *    from the list below.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const SRC = fileURLToPath(new URL('../../src', import.meta.url))

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name !== 'node_modules' && name !== 'dist') out.push(...sourceFiles(full))
    } else if (name.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(name)) {
      out.push(full)
    }
  }
  return out
}

const IMPORTS_ZOD = /from\s+['"]zod['"]/
const SCHEMA_NAMED_PARSE = /\b\w*[Ss]chema\w*\s*\.\s*(?:safeParse|parse)\s*\(/
const ANY_PARSE_IN_ZOD_FILE = /(?<![\w$])(?!JSON\b)[A-Za-z_$][\w$]*\s*\.\s*(?:safeParse|parse)\s*\(/

/** Lines of `text` holding a bare zod parse. Exported shape is tested below with controls. */
function bareParseHits(text: string): string[] {
  const hits: string[] = []
  const zodFile = IMPORTS_ZOD.test(text)
  text.split('\n').forEach((line, i) => {
    if (/^\s*(\*|\/\*|\/\/)/.test(line)) return // comment line
    const code = line.replace(/\/\/.*$/, '')
    if (SCHEMA_NAMED_PARSE.test(code) || (zodFile && ANY_PARSE_IN_ZOD_FILE.test(code))) {
      hits.push(`${i + 1}: ${line.trim()}`)
    }
  })
  return hits
}

const UNMAPPED_BUILDERS: Array<[string, RegExp]> = [
  ['z.literal(', /\bz\s*\.\s*literal\s*\(/],
  ['.multipleOf(', /\.\s*multipleOf\s*\(/],
  ['.step(', /\.\s*step\s*\(/],
  [
    '.startsWith( / .endsWith( / .includes( on z.string()',
    // z.string() then a chain of .method(...) calls (parens balanced to depth 3) ending in the builder
    /\bz\s*\.\s*string\s*\(\)(?:\s*\.\s*\w+\s*\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))*?\s*\.\s*(?:startsWith|endsWith|includes)\s*\(/,
  ],
]

function unmappedBuilderHits(text: string): string[] {
  return UNMAPPED_BUILDERS.filter(([, re]) => IMPORTS_ZOD.test(text) && re.test(text)).map(
    ([label]) => label
  )
}

const files = sourceFiles(SRC).filter((f) => !f.endsWith('validation.legacy.ts'))

describe('every zod parse goes through validation.legacy.ts', () => {
  it('scans a meaningful set of files (not vacuous)', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(files.filter((f) => IMPORTS_ZOD.test(readFileSync(f, 'utf8'))).length).toBeGreaterThan(
      30
    )
  })

  it('finds no bare .parse( or .safeParse( of a zod schema under packages/mcp-server/src', () => {
    const offenders = files.flatMap((f) =>
      bareParseHits(readFileSync(f, 'utf8')).map((h) => `${f.slice(SRC.length)}:${h}`)
    )
    expect(
      offenders,
      'Use legacySafeParse / legacyParse (src/validation.legacy.ts) so clients keep zod 3 codes and messages'
    ).toEqual([])
  })

  it('control: the scan flags the shapes it exists to catch and ignores look-alikes', () => {
    expect(bareParseHits('const v = analyzeInputSchema.parse(input)\n')).toHaveLength(1)
    expect(bareParseHits('const r = fooSchema.safeParse(x)\n')).toHaveLength(1)
    expect(bareParseHits("import { z } from 'zod'\nconst r = s.safeParse(x)\n")).toHaveLength(1)
    expect(bareParseHits("import { z } from 'zod'\nconst j = JSON.parse(text)\n")).toEqual([])
    expect(bareParseHits('const p = path.parse(file)\nconst j = JSON.parse(t)\n')).toEqual([])
    expect(bareParseHits('// analyzeInputSchema.parse(input) is forbidden\n')).toEqual([])
  })
})

describe('schema builders validation.legacy.ts does not map', () => {
  it('uses none of them anywhere under packages/mcp-server/src', () => {
    const offenders = files.flatMap((f) =>
      unmappedBuilderHits(readFileSync(f, 'utf8')).map((h) => `${f.slice(SRC.length)}: ${h}`)
    )
    expect(
      offenders,
      'validation.legacy.ts has no zod 3 wording for this builder; add it there plus parity cases, then update this list'
    ).toEqual([])
  })

  it('control: the scan flags each builder and ignores look-alikes', () => {
    const z = "import { z } from 'zod'\n"
    expect(unmappedBuilderHits(z + "const a = z.literal('x')\n")).toHaveLength(1)
    expect(unmappedBuilderHits(z + 'const a = z.number().multipleOf(5)\n')).toHaveLength(1)
    expect(unmappedBuilderHits(z + 'const a = z.number().step(5)\n')).toHaveLength(1)
    expect(unmappedBuilderHits(z + "const a = z.string().startsWith('x')\n")).toHaveLength(1)
    expect(unmappedBuilderHits(z + "const a = z.string().min(1).includes('x')\n")).toHaveLength(1)
    // look-alikes: array/string methods on ordinary values, even beside a schema.
    expect(unmappedBuilderHits(z + "const a = z.string()\nconst b = ['x'].includes(y)\n")).toEqual(
      []
    )
    expect(unmappedBuilderHits(z + ".refine((v) => v.includes('x'))\n")).toEqual([])
    expect(unmappedBuilderHits("const b = ['x'].includes(y)\nz.literal('x')\n")).toEqual([])
  })
})
