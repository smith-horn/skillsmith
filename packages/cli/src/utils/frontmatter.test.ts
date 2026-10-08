/**
 * @fileoverview Tests for the in-repo frontmatter parser (SMI-7018)
 *
 * Expected values in `REFERENCE` were MEASURED by running gray-matter 4.0.3
 * on each input (node, repo-root node_modules) before gray-matter was removed.
 * `DELIBERATE` lists the inputs where this parser intentionally differs.
 */
import { describe, it, expect, vi } from 'vitest'
import { YAMLParseError } from 'yaml'
import { MAX_FRONTMATTER_BYTES, parseFrontmatter } from './frontmatter.js'

interface Case {
  name: string
  input: string
  data: Record<string, unknown>
  content: string
}

const REFERENCE: Case[] = [
  { name: 'no frontmatter', input: '# Title\nbody\n', data: {}, content: '# Title\nbody\n' },
  { name: 'empty input', input: '', data: {}, content: '' },
  {
    name: 'frontmatter + body',
    input: '---\nname: a\n---\nbody\n',
    data: { name: 'a' },
    content: 'body\n',
  },
  {
    name: 'closing delimiter at EOF, no newline',
    input: '---\nname: a\n---',
    data: { name: 'a' },
    content: '',
  },
  {
    name: 'BOM before frontmatter',
    input: '﻿---\nname: a\n---\nbody\n',
    data: { name: 'a' },
    content: 'body\n',
  },
  { name: 'BOM, no frontmatter (BOM stripped)', input: '﻿hello', data: {}, content: 'hello' },
  {
    name: 'CRLF line endings (body keeps CRLF)',
    input: '---\r\nname: a\r\n---\r\nbody\r\nmore\r\n',
    data: { name: 'a' },
    content: 'body\r\nmore\r\n',
  },
  {
    name: 'CRLF, closing at EOF',
    input: '---\r\nname: a\r\n---',
    data: { name: 'a' },
    content: '',
  },
  { name: 'empty frontmatter', input: '---\n---\nbody\n', data: {}, content: 'body\n' },
  { name: 'blank-only frontmatter', input: '---\n\n---\nbody\n', data: {}, content: 'body\n' },
  { name: 'comment-only frontmatter', input: '---\n# c\n---\nbody\n', data: {}, content: 'body\n' },
  {
    name: '--- block later in body is not frontmatter',
    input: 'intro\n---\nname: a\n---\nbody',
    data: {},
    content: 'intro\n---\nname: a\n---\nbody',
  },
  {
    name: '--- inside body after frontmatter is not a delimiter',
    input: '---\nname: a\n---\nbody\n---\nmore\n',
    data: { name: 'a' },
    content: 'body\n---\nmore\n',
  },
  {
    name: 'second block after body stays in content',
    input: '---\nname: a\n---\nx\n---\ny: 1\n---\nz\n',
    data: { name: 'a' },
    content: 'x\n---\ny: 1\n---\nz\n',
  },
  {
    name: 'body starts with one blank line',
    input: '---\nname: a\n---\n\nbody\n',
    data: { name: 'a' },
    content: '\nbody\n',
  },
  {
    name: 'body starts with two blank lines',
    input: '---\nname: a\n---\n\n\nbody\n',
    data: { name: 'a' },
    content: '\n\nbody\n',
  },
  {
    name: 'unterminated but valid YAML',
    input: '---\nname: a\n',
    data: { name: 'a' },
    content: '',
  },
  {
    name: 'opening delimiter trailing space',
    input: '--- \nname: a\n---\nbody\n',
    data: { name: 'a' },
    content: 'body\n',
  },
  { name: 'only an opening delimiter', input: '---', data: {}, content: '' },
  { name: 'opening delimiter + newline only', input: '---\n', data: {}, content: '' },
  {
    name: '---- is not an opening delimiter',
    input: '----\nname: a\n---\nbody\n',
    data: {},
    content: '----\nname: a\n---\nbody\n',
  },
  {
    name: 'leading space defeats opening delimiter',
    input: ' ---\nname: a\n---\nbody',
    data: {},
    content: ' ---\nname: a\n---\nbody',
  },
  {
    name: 'leading newline defeats opening delimiter',
    input: '\n---\nname: a\n---\nbody',
    data: {},
    content: '\n---\nname: a\n---\nbody',
  },
  { name: 'null document', input: '---\n~\n---\nbody\n', data: {}, content: 'body\n' },
  {
    name: 'yes/on/off/no stay strings (js-yaml 3 agrees)',
    input: '---\nname: yes\ndescription: on\ntriggers: [yes, no]\ntags: off\n---\n',
    data: { name: 'yes', description: 'on', triggers: ['yes', 'no'], tags: 'off' },
    content: '',
  },
  // Language tags on the opening line (gray-matter 4.0.3, measured 2026-10-07).
  {
    name: '---yaml opener',
    input: '---yaml\nname: a\n---\nbody\n',
    data: { name: 'a' },
    content: 'body\n',
  },
  {
    name: '---yml opener',
    input: '---yml\nname: a\n---\nbody\n',
    data: { name: 'a' },
    content: 'body\n',
  },
  {
    name: '---YAML opener (any case)',
    input: '---YAML\nname: a\n---\nbody\n',
    data: { name: 'a' },
    content: 'body\n',
  },
  {
    name: '--- yaml opener (space before tag)',
    input: '--- yaml\nname: a\n---\nbody\n',
    data: { name: 'a' },
    content: 'body\n',
  },
  {
    name: '---yaml opener with CRLF',
    input: '---yaml\r\nname: a\r\n---\r\nbody\r\n',
    data: { name: 'a' },
    content: 'body\r\n',
  },
  {
    name: '---json opener',
    input: '---json\n{"name": "a"}\n---\nbody\n',
    data: { name: 'a' },
    content: 'body\n',
  },
]

// Measured gray-matter output differs here on purpose; see the module header.
const DELIBERATE: Case[] = [
  // gray-matter: data 'hello' (raw scalar)
  { name: 'scalar document -> {}', input: '---\nhello\n---\nbody\n', data: {}, content: 'body\n' },
  // gray-matter: data ['a','b'] (raw array)
  { name: 'list document -> {}', input: '---\n- a\n- b\n---\nbody\n', data: {}, content: 'body\n' },
  // gray-matter: closes at "--- " and leaves " " at the head of content
  {
    name: 'closing delimiter with trailing space',
    input: '---\nname: a\n--- \nbody\n',
    data: { name: 'a' },
    content: 'body\n',
  },
]

describe('parseFrontmatter: gray-matter reference table', () => {
  it.each(REFERENCE)('$name', ({ input, data, content }) => {
    expect(parseFrontmatter(input)).toEqual({ data, content })
  })
})

describe('parseFrontmatter: deliberate differences', () => {
  it.each(DELIBERATE)('$name', ({ input, data, content }) => {
    expect(parseFrontmatter(input)).toEqual({ data, content })
  })

  it('---- inside the block is not a closing delimiter (gray-matter closed there)', () => {
    // Block is unterminated, so everything after the opening line is YAML and
    // "----" makes it invalid. The body must NOT be split off silently.
    expect(() => parseFrontmatter('---\nname: a\n----\nbody\n')).toThrow()
  })

  it('an unknown language tag on the opening line throws (gray-matter threw too)', () => {
    expect(() => parseFrontmatter('---foo\nname: a\n---\nbody\n')).toThrow(
      /language "foo" is not supported/
    )
  })

  it.each(['js', 'javascript', 'JavaScript'])(
    '---%s frontmatter throws and never runs (gray-matter executed it)',
    (lang) => {
      // If this frontmatter were evaluated as code, it would set the global.
      const g = globalThis as { __smi7018Executed?: boolean }
      const payload = '(globalThis.__smi7018Executed = true, { name: "a" })'
      // Control: the payload really does set the global when evaluated, so the
      // absence check below can detect execution.
      delete g.__smi7018Executed
      new Function(`return ${payload}`)()
      expect(g.__smi7018Executed).toBe(true)

      delete g.__smi7018Executed
      const input = `---${lang}\n${payload}\n---\nbody\n`
      expect(() => parseFrontmatter(input)).toThrow(/executable code/)
      expect(g.__smi7018Executed).toBeUndefined()
    }
  )

  it('---- on the opening line is not frontmatter (gray-matter agreed)', () => {
    const input = '----\nname: a\n---\nbody\n'
    expect(parseFrontmatter(input)).toEqual({ data: {}, content: input })
  })

  it('tabs after the opening and closing --- are allowed', () => {
    expect(parseFrontmatter('---\t\nname: a\n---\t\nbody\n')).toEqual({
      data: { name: 'a' },
      content: 'body\n',
    })
  })

  it('a closing line of --- then \\r then spaces is not a delimiter (gray-matter closed there)', () => {
    expect(() => parseFrontmatter('---\nname: a\n---\r  \nbody\n')).toThrow(
      /closing line must be exactly `---`/
    )
  })

  it.each([
    ['--- # note', '---\nname: a\n--- # note\nbody\n'],
    ['...', '---\nname: a\n...\nbody\n'],
  ])(
    'a near-miss closing line (%s) gets an error naming the file problem, not a yaml API',
    (_label, input) => {
      expect(() => parseFrontmatter(input)).toThrow(/closing line must be exactly `---`/)
      expect(() => parseFrontmatter(input)).not.toThrow(/parseAllDocuments/)
    }
  )

  it('a closed block that contains a document marker says so, not "not closed"', () => {
    // The final bare `---` closes the block, but `--- # second` inside it starts a
    // second YAML document.
    const input = '---\nname: first\n--- # second YAML document\nname: second\n---\nbody\n'
    expect(() => parseFrontmatter(input)).toThrow(/contains more than one YAML document/)
    expect(() => parseFrontmatter(input)).not.toThrow(/not closed/)
  })

  it.each([
    ['duplicate keys', '---\nname: a\nname: b\n---\n', 'DUPLICATE_KEY'],
    ['malformed flow sequence', '---\nname: [unclosed\n---\nbody\n', 'BAD_INDENT'],
  ])(
    'other YAML errors are rethrown unchanged: %s keeps its YAMLParseError class and code',
    (_label, input, code) => {
      let caught: unknown
      try {
        parseFrontmatter(input)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(YAMLParseError)
      expect((caught as YAMLParseError).code).toBe(code)
    }
  )

  it("other YAML errors keep yaml's own message (only the multiple-documents case is reworded)", () => {
    expect(() => parseFrontmatter('---\nname: a\nname: b\n---\n')).toThrow(
      /Map keys must be unique/
    )
    expect(() => parseFrontmatter('---\nname: [unclosed\n---\nbody\n')).not.toThrow(
      /closing line must be exactly/
    )
  })

  it('a custom tag resolves to its plain value and emits no warning (gray-matter threw)', () => {
    const spy = vi.spyOn(process, 'emitWarning')
    try {
      expect(parseFrontmatter('---\nname: !foo bar\n---\n').data).toEqual({ name: 'bar' })
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('parseFrontmatter: limits on untrusted input', () => {
  // One key per line, so the cost the cap exists to bound (yaml's quadratic
  // duplicate-key scan) grows with the input.
  const manyKeys = (bytes: number): string => {
    const lines: string[] = []
    let size = 0
    for (let i = 0; size < bytes; i++) {
      const line = `k${i}: v\n`
      lines.push(line)
      size += line.length
    }
    return lines.join('')
  }

  it('rejects a YAML block over MAX_FRONTMATTER_BYTES before parsing it', () => {
    const yaml = manyKeys(MAX_FRONTMATTER_BYTES + 1)
    expect(yaml.length).toBeGreaterThan(MAX_FRONTMATTER_BYTES)
    // Valid YAML, so the only reason to throw is the size check.
    expect(() => parseFrontmatter(`---\n${yaml}---\nbody\n`)).toThrow(/over the \d+-byte limit/)
  })

  it('parses a YAML block just under MAX_FRONTMATTER_BYTES', () => {
    let yaml = manyKeys(MAX_FRONTMATTER_BYTES - 64)
    while (yaml.length > MAX_FRONTMATTER_BYTES) yaml = yaml.slice(0, yaml.lastIndexOf('k'))
    const { data } = parseFrontmatter(`---\n${yaml}---\nbody\n`)
    expect(Object.keys(data).length).toBeGreaterThan(1000)
  })

  it('applies the limit to an unterminated block too', () => {
    const yaml = manyKeys(MAX_FRONTMATTER_BYTES + 1)
    expect(() => parseFrontmatter(`---\n${yaml}`)).toThrow(/over the \d+-byte limit/)
  })

  it('rejects alias-expansion bombs (yaml caps alias nodes; js-yaml 3 did not)', () => {
    const levels = ['a: &a [x, x, x, x, x, x, x, x, x, x]']
    for (let i = 1; i < 8; i++) {
      const prev = String.fromCharCode(96 + i)
      const cur = String.fromCharCode(97 + i)
      levels.push(`${cur}: &${cur} [${Array(10).fill(`*${prev}`).join(', ')}]`)
    }
    const bomb = `---\n${levels.join('\n')}\n---\n`
    expect(bomb.length).toBeLessThan(MAX_FRONTMATTER_BYTES)
    expect(() => parseFrontmatter(bomb)).toThrow(/alias/i)
  })

  it('checks the size before parsing: oversized invalid YAML reports the size, not a YAML error', () => {
    // A YAML error would arrive first if the check ran after yaml.parse.
    const yaml = 'x: [' + ','.repeat(MAX_FRONTMATTER_BYTES) + ']\n'
    expect(() => parseFrontmatter(`---\n${yaml}---\n`)).toThrow(/over the \d+-byte limit/)
  })

  it('measures the YAML block only, not the body', () => {
    const body = 'x'.repeat(MAX_FRONTMATTER_BYTES * 2)
    expect(parseFrontmatter(`---\nname: a\n---\n${body}\n`).data).toEqual({ name: 'a' })
  })

  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    const yaml = `a: ${'é'.repeat(MAX_FRONTMATTER_BYTES / 2)}\n`
    expect(yaml.length).toBeLessThan(MAX_FRONTMATTER_BYTES)
    expect(() => parseFrontmatter(`---\n${yaml}---\n`)).toThrow(/over the \d+-byte limit/)
  })

  it('accepts a block of exactly MAX_FRONTMATTER_BYTES and rejects one byte more', () => {
    const at = `a: ${'x'.repeat(MAX_FRONTMATTER_BYTES - 4)}\n`
    expect(Buffer.byteLength(at)).toBe(MAX_FRONTMATTER_BYTES)
    expect(parseFrontmatter(`---\n${at}---\n`).data).toEqual({
      a: 'x'.repeat(MAX_FRONTMATTER_BYTES - 4),
    })
    const over = `a: ${'x'.repeat(MAX_FRONTMATTER_BYTES - 3)}\n`
    expect(() => parseFrontmatter(`---\n${over}---\n`)).toThrow(/over the \d+-byte limit/)
  })
})

describe('parseFrontmatter: errors', () => {
  it('throws on malformed YAML in a terminated block', () => {
    expect(() => parseFrontmatter('---\nname: [unclosed\n---\nbody\n')).toThrow(/flow|bracket|\]/i)
  })

  it('throws on an unterminated block whose remainder is not YAML', () => {
    expect(() => parseFrontmatter('---\nname: a\nbody never closes\n')).toThrow()
  })

  it('throws on duplicate mapping keys (gray-matter/js-yaml 3 threw too)', () => {
    expect(() => parseFrontmatter('---\nname: a\nname: b\n---\nbody\n')).toThrow(/key/i)
  })

  it('does not swallow the error when malformed YAML precedes valid-looking body', () => {
    expect(() => parseFrontmatter('---\n: : :\n  - [\n---\n# ok\n')).toThrow()
  })
})

describe('parseFrontmatter: YAML schema differences vs js-yaml 3 (measured)', () => {
  it('keeps timestamps as strings (js-yaml 3 produced Date)', () => {
    expect(parseFrontmatter('---\nname: 2024-01-01\n---\n').data).toEqual({ name: '2024-01-01' })
  })

  it('keeps sexagesimal-looking values as strings (js-yaml 3 produced 90)', () => {
    expect(parseFrontmatter('---\nname: 1:30\n---\n').data).toEqual({ name: '1:30' })
  })

  it('honours merge keys like js-yaml 3', () => {
    const { data } = parseFrontmatter('---\nb: &x {a: 1}\nc:\n  <<: *x\n---\n')
    expect(data).toEqual({ b: { a: 1 }, c: { a: 1 } })
  })
})
