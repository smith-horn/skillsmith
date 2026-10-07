/**
 * @fileoverview Tests for the in-repo frontmatter parser (SMI-7018)
 *
 * Expected values in `REFERENCE` were MEASURED by running gray-matter 4.0.3
 * on each input (node, repo-root node_modules) before gray-matter was removed.
 * `DELIBERATE` lists the inputs where this parser intentionally differs.
 */
import { describe, it, expect } from 'vitest'
import { parseFrontmatter } from './frontmatter.js'

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

  it('---foo on the opening line is not frontmatter (gray-matter threw: unknown engine)', () => {
    const input = '---foo\nname: a\n---\nbody\n'
    expect(parseFrontmatter(input)).toEqual({ data: {}, content: input })
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
