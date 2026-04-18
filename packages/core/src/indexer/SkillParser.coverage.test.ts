/**
 * SMI-4285: SkillParser coverage gaps — type-validation branches + unicode.
 *
 * Lives in a sidecar (not SkillParser.test.ts) to stay under the 500-line gate.
 * Split rationale: these tests exercise boundary behaviors — YAML-parser bypass
 * (direct validate() calls with typed-wrong objects) and non-ASCII inputs —
 * that are orthogonal to the main suite's functional coverage.
 */

import { describe, it, expect } from 'vitest'

import SkillParser from './SkillParser.js'
import type { SkillFrontmatter } from './SkillParser.js'

function makeSkillMd(frontmatter: string, body = '# My Skill\n\nDoes things.'): string {
  return `---\n${frontmatter}\n---\n\n${body}`
}

// ---------------------------------------------------------------------------
// Unicode coverage — description and tags (name is covered in SkillParser.test.ts)
// ---------------------------------------------------------------------------

describe('SkillParser.extractFrontmatter — unicode', () => {
  const parser = new SkillParser()

  it('preserves unicode characters in description values', () => {
    const result = parser.extractFrontmatter(makeSkillMd('name: x\ndescription: "これはスキル"'))
    expect(result?.description).toBe('これはスキル')
  })

  it('preserves unicode characters in tag values', () => {
    const result = parser.extractFrontmatter(
      makeSkillMd('name: x\ntags:\n  - 日本語\n  - 中文\n  - ไทย')
    )
    expect(result?.tags).toEqual(['日本語', '中文', 'ไทย'])
  })
})

// ---------------------------------------------------------------------------
// validate() type-validation branches
//
// These cannot be reached via extractFrontmatter — the YAML parser coerces
// scalars (e.g. `name: 123` becomes the string "123" via the String(parsed.name)
// call at SkillParser.ts:264-266). Call validate() directly with a typed-wrong
// object to exercise the `typeof !== 'string'` branches at SkillParser.ts:291-309.
// ---------------------------------------------------------------------------

describe('SkillParser.validate — type-validation branches', () => {
  const parser = new SkillParser()

  it('errors when name is not a string', () => {
    const result = parser.validate({ name: 123 } as unknown as SkillFrontmatter)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Field "name" must be a string')
  })

  it('errors when description is not a string', () => {
    const result = parser.validate({
      name: 'x',
      description: 123,
    } as unknown as SkillFrontmatter)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Field "description" must be a string')
  })

  it('errors when author is not a string', () => {
    const result = parser.validate({
      name: 'x',
      author: true,
    } as unknown as SkillFrontmatter)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Field "author" must be a string')
  })

  it('errors when version is not a string', () => {
    const result = parser.validate({
      name: 'x',
      version: ['1', '0', '0'],
    } as unknown as SkillFrontmatter)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Field "version" must be a string')
  })

  it('errors when tags is not an array', () => {
    const result = parser.validate({
      name: 'x',
      tags: 'typescript,testing',
    } as unknown as SkillFrontmatter)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Field "tags" must be an array')
  })
})
