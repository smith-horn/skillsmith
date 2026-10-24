/**
 * SMI-7168: source scans that keep the zod 3 error contract from eroding.
 *
 * SCOPE: non-test `.ts` files under packages/mcp-server/src, excluding validation.legacy.ts.
 * Nothing outside that tree is scanned.
 *
 * 1. Every zod parse must go through `validation.legacy.ts` (`legacySafeParse`, `legacyParse`, or
 *    `safeParseOrError`, which wraps them). A bare `schema.parse(` or `schema.safeParse(` would
 *    surface zod 4's wording and codes to clients while every existing test stayed green.
 *    The scan is receiver-agnostic on purpose: it flags EVERY `.parse` / `.safeParse` /
 *    `.parseAsync` / `.safeParseAsync` access (dotted, optional-chained, bracketed, split across
 *    lines, on any expression) except the static `JSON.parse`, `Date.parse` and `URL.parse`, which
 *    are the only ones in the tree today. Being receiver-agnostic is what catches a schema that
 *    was imported under a name with no "schema" in it, or built inline. A new legitimate non-zod
 *    parser needs a reviewed entry in NON_ZOD_RECEIVERS below.
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

/** `from 'zod'`, `from "zod"`, `from 'zod/v4'`, `from 'zod/v4-mini'`, `from 'zod/v3'`. */
const IMPORTS_ZOD = /from\s+['"]zod(?:\/[\w-]+)?['"]/

/**
 * Receivers whose `.parse` is not a zod parse. Static built-ins only; each is used in src today.
 * Adding to this list means a reviewer has confirmed the receiver is not a zod schema.
 */
const NON_ZOD_RECEIVERS = ['JSON', 'Date', 'URL']

const PARSE_ACCESS = /(?:\?\.|\.)\s*(?:safeParse|parse)(?:Async)?\b/g
const BRACKET_PARSE = /\[\s*['"`](?:safeParse|parse)(?:Async)?['"`]\s*\]/g
const DESTRUCTURED_PARSE = /\{[^{}]*\b(?:safeParse|parse)(?:Async)?\b[^{}]*\}\s*=[^=>]/g

/** Block comments and whole-line `//` comments blanked; line numbers preserved. */
function withoutComments(text: string): string {
  const noBlocks = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  return noBlocks
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n')
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length
}

/** `file:line: snippet` for each bare zod parse in `text`. */
function bareParseHits(text: string): string[] {
  const code = withoutComments(text)
  const hits: string[] = []
  const note = (index: number) =>
    `${lineOf(code, index)}: ${code.split('\n')[lineOf(code, index) - 1].trim()}`
  for (const m of code.matchAll(PARSE_ACCESS)) {
    const before = code.slice(0, m.index).replace(/\s+$/, '')
    const receiver = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)$/.exec(before)?.[1]
    // a plain `JSON.parse` / `Date.parse` / `URL.parse`; `JSON?.parse` is not the static built-in
    if (receiver && NON_ZOD_RECEIVERS.includes(receiver) && m[0].startsWith('.')) continue
    hits.push(note(m.index))
  }
  for (const re of [BRACKET_PARSE, DESTRUCTURED_PARSE]) {
    for (const m of code.matchAll(re)) hits.push(note(m.index))
  }
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
  const code = withoutComments(text)
  return UNMAPPED_BUILDERS.filter(([, re]) => IMPORTS_ZOD.test(code) && re.test(code)).map(
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

  it('finds no bare zod parse anywhere under packages/mcp-server/src', () => {
    const offenders = files.flatMap((f) =>
      bareParseHits(readFileSync(f, 'utf8')).map((h) => `${f.slice(SRC.length)}:${h}`)
    )
    expect(
      offenders,
      'Use legacySafeParse / legacyParse (src/validation.legacy.ts) so clients keep zod 3 codes and messages'
    ).toEqual([])
  })

  describe('control: every bypass shape is flagged', () => {
    const shapes: Array<[string, string]> = [
      ['plain identifier receiver', 'const v = analyzeInputSchema.parse(input)\n'],
      ['safeParse', 'const r = fooSchema.safeParse(x)\n'],
      ['inline z.object(...) receiver', 'const v = z.object({ a: z.string() }).parse(x)\n'],
      ['call-expression receiver', 'const v = getS().parse(x)\n'],
      ['optional chaining', 'const v = s?.parse(x)\n'],
      ['parseAsync', 'const v = await s.parseAsync(x)\n'],
      ['safeParseAsync', 'const v = await s.safeParseAsync(x)\n'],
      [
        'renamed import with no "schema" in the name, file does not import zod',
        "import { thing } from './tools/thing.js'\nconst v = thing.parse(x)\n",
      ],
      ['chain split across lines', 'const v = s\n  .parse(x)\n'],
      ['bracket access', "const v = s['parse'](x)\n"],
      ['bracket access safeParse, double quotes', 'const v = s["safeParse"](x)\n'],
      ['zod/v4 importer', "import { z } from 'zod/v4'\nconst v = s.parse(x)\n"],
      ['`//` inside a string before the call', "const u = 'http://x'; const v = s.parse(x)\n"],
      ['destructured out of a schema', 'const { safeParse } = schema\n'],
      ['bound reference without a call', 'const p = s.safeParse\n'],
    ]
    it.each(shapes)('%s', (_label, source) => {
      expect(bareParseHits(source)).toHaveLength(1)
    })
  })

  describe('control: look-alikes are not flagged', () => {
    const ok: Array<[string, string]> = [
      ['JSON.parse', 'const j = JSON.parse(text)\n'],
      ['Date.parse', 'const t = Date.parse(iso)\n'],
      ['URL.parse', 'const u = URL.parse(raw)\n'],
      ['JSON.parse split across lines', 'const j = JSON\n  .parse(text)\n'],
      ['JSON.parse in a zod file', "import { z } from 'zod'\nconst j = JSON.parse(t)\n"],
      ['whole-line comment', '// analyzeInputSchema.parse(input) is forbidden\n'],
      ['block comment', '/*\n * s.parse(x) and s.safeParse(x)\n */\nconst a = 1\n'],
      ['an unrelated method', 'const n = parseInt(x)\nconst m = obj.parsed\n'],
    ]
    it.each(ok)('%s', (_label, source) => {
      expect(bareParseHits(source)).toEqual([])
    })

    it('JSON?.parse is still flagged (optional chaining is not the static built-in)', () => {
      expect(bareParseHits('const j = JSON?.parse(t)\n')).toHaveLength(1)
    })
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
    // a zod/v4 importer is scanned too
    expect(
      unmappedBuilderHits("import { z } from 'zod/v4'\nconst a = z.literal('x')\n")
    ).toHaveLength(1)
    // look-alikes: array/string methods on ordinary values, even beside a schema.
    expect(unmappedBuilderHits(z + "const a = z.string()\nconst b = ['x'].includes(y)\n")).toEqual(
      []
    )
    expect(unmappedBuilderHits(z + ".refine((v) => v.includes('x'))\n")).toEqual([])
    expect(unmappedBuilderHits("const b = ['x'].includes(y)\nz.literal('x')\n")).toEqual([])
    expect(unmappedBuilderHits(z + "// z.literal('x') is not allowed\n")).toEqual([])
  })
})
