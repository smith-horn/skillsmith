import { describe, it, expect } from 'vitest'

import SkillParser from './SkillParser.js'
import type { SkillFrontmatter, ParsedSkillMetadata } from './SkillParser.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSkillMd(frontmatter: string, body = '# My Skill\n\nDoes things.'): string {
  return `---\n${frontmatter}\n---\n\n${body}`
}

const MINIMAL_VALID = makeSkillMd('name: my-skill')

const FULL_VALID = makeSkillMd(
  [
    'name: full-skill',
    'description: A thorough skill with all recommended fields present.',
    'author: acme',
    'version: 1.2.3',
    'license: MIT',
    'tags:',
    '  - typescript',
    '  - testing',
    '  - vitest',
    'category: testing',
    'repository: https://github.com/acme/full-skill',
  ].join('\n')
)

// ---------------------------------------------------------------------------
// extractFrontmatter
// ---------------------------------------------------------------------------

describe('SkillParser.extractFrontmatter', () => {
  const parser = new SkillParser()

  it('returns null when content does not start with ---', () => {
    expect(parser.extractFrontmatter('name: foo\n---')).toBeNull()
  })

  it('returns null when there is no closing --- delimiter', () => {
    expect(parser.extractFrontmatter('---\nname: foo\n')).toBeNull()
  })

  it('returns null for an empty string', () => {
    expect(parser.extractFrontmatter('')).toBeNull()
  })

  it('parses a simple key-value pair', () => {
    const result = parser.extractFrontmatter(makeSkillMd('name: my-skill'))
    expect(result?.name).toBe('my-skill')
  })

  it('parses double-quoted string values', () => {
    const result = parser.extractFrontmatter(makeSkillMd('name: "quoted skill"'))
    expect(result?.name).toBe('quoted skill')
  })

  it('parses single-quoted string values', () => {
    const result = parser.extractFrontmatter(makeSkillMd("name: 'single quoted'"))
    expect(result?.name).toBe('single quoted')
  })

  it('parses boolean true', () => {
    const result = parser.extractFrontmatter(makeSkillMd('name: x\ndeprecated: true'))
    expect(result?.deprecated).toBe(true)
  })

  it('parses boolean false', () => {
    const result = parser.extractFrontmatter(makeSkillMd('name: x\ndeprecated: false'))
    expect(result?.deprecated).toBe(false)
  })

  it('parses a numeric value', () => {
    const result = parser.extractFrontmatter(makeSkillMd('name: x\nsome_count: 42'))
    expect(result?.some_count).toBe(42)
  })

  it('parses a block-style array', () => {
    const result = parser.extractFrontmatter(
      makeSkillMd('name: x\ntags:\n  - alpha\n  - beta\n  - gamma')
    )
    expect(result?.tags).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('parses an inline array', () => {
    const result = parser.extractFrontmatter(makeSkillMd('name: x\ntags: [alpha, beta, gamma]'))
    expect(result?.tags).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('ignores YAML comments', () => {
    const result = parser.extractFrontmatter(
      makeSkillMd('# this is a comment\nname: commented-skill')
    )
    expect(result?.name).toBe('commented-skill')
  })

  it('preserves unicode characters in string values', () => {
    const result = parser.extractFrontmatter(makeSkillMd('name: "日本語スキル"'))
    expect(result?.name).toBe('日本語スキル')
  })

  it('preserves unknown extra keys', () => {
    const result = parser.extractFrontmatter(makeSkillMd('name: x\ncustom_field: hello'))
    expect(result?.custom_field).toBe('hello')
  })

  it('coerces a numeric name to a string', () => {
    const result = parser.extractFrontmatter(makeSkillMd('name: 123'))
    expect(typeof result?.name).toBe('string')
    expect(result?.name).toBe('123')
  })
})

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

describe('SkillParser.validate', () => {
  it('is valid for a frontmatter object with a name', () => {
    const parser = new SkillParser()
    const result = parser.validate({ name: 'my-skill' } as SkillFrontmatter)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('returns an error when name is missing and requireName is true (default)', () => {
    const parser = new SkillParser()
    const result = parser.validate({} as SkillFrontmatter)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Missing required field: name')
  })

  it('does not error on missing name when requireName is false', () => {
    const parser = new SkillParser({ requireName: false })
    const result = parser.validate({} as SkillFrontmatter)
    expect(result.valid).toBe(true)
  })

  it('returns an error when description is required but missing', () => {
    const parser = new SkillParser({ requireDescription: true })
    const result = parser.validate({ name: 'x' } as SkillFrontmatter)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Missing required field: description')
  })

  it('does not error when description is provided and required', () => {
    const parser = new SkillParser({ requireDescription: true })
    const result = parser.validate({ name: 'x', description: 'A skill.' } as SkillFrontmatter)
    expect(result.valid).toBe(true)
  })

  it('emits a warning when description is absent', () => {
    const parser = new SkillParser()
    const result = parser.validate({ name: 'x' } as SkillFrontmatter)
    expect(result.warnings.some((w) => w.includes('description'))).toBe(true)
  })

  it('emits a warning when version is absent', () => {
    const parser = new SkillParser()
    const result = parser.validate({ name: 'x' } as SkillFrontmatter)
    expect(result.warnings.some((w) => w.includes('version'))).toBe(true)
  })

  it('emits a warning when tags are absent', () => {
    const parser = new SkillParser()
    const result = parser.validate({ name: 'x' } as SkillFrontmatter)
    expect(result.warnings.some((w) => w.includes('tags'))).toBe(true)
  })

  it('emits a deprecation warning when composes is present', () => {
    const parser = new SkillParser()
    const result = parser.validate({
      name: 'x',
      composes: ['other-skill'],
    } as SkillFrontmatter)
    expect(result.warnings.some((w) => w.includes('composes'))).toBe(true)
  })

  it('merges errors and warnings from a custom validator', () => {
    const parser = new SkillParser({
      customValidator: () => ({
        valid: false,
        errors: ['custom error'],
        warnings: ['custom warning'],
      }),
    })
    const result = parser.validate({ name: 'x' } as SkillFrontmatter)
    expect(result.errors).toContain('custom error')
    expect(result.warnings).toContain('custom warning')
    expect(result.valid).toBe(false)
  })

  it('is valid when custom validator passes', () => {
    const parser = new SkillParser({
      customValidator: () => ({ valid: true, errors: [], warnings: [] }),
    })
    const result = parser.validate({ name: 'x' } as SkillFrontmatter)
    expect(result.valid).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

describe('SkillParser.parse', () => {
  const parser = new SkillParser()

  it('returns null for content without a frontmatter block', () => {
    expect(parser.parse('# Just a heading\n\nNo frontmatter here.')).toBeNull()
  })

  it('returns null when required name field is absent', () => {
    expect(parser.parse(makeSkillMd('description: no name here'))).toBeNull()
  })

  it('returns ParsedSkillMetadata for valid minimal content', () => {
    const result = parser.parse(MINIMAL_VALID)
    expect(result).not.toBeNull()
    expect(result?.name).toBe('my-skill')
  })

  it('maps all optional fields correctly', () => {
    const result = parser.parse(FULL_VALID) as ParsedSkillMetadata
    expect(result.name).toBe('full-skill')
    expect(result.description).toBe('A thorough skill with all recommended fields present.')
    expect(result.author).toBe('acme')
    expect(result.version).toBe('1.2.3')
    expect(result.license).toBe('MIT')
    expect(result.tags).toEqual(['typescript', 'testing', 'vitest'])
    expect(result.category).toBe('testing')
    expect(result.repository).toBe('https://github.com/acme/full-skill')
  })

  it('sets absent optional fields to null', () => {
    const result = parser.parse(MINIMAL_VALID) as ParsedSkillMetadata
    expect(result.description).toBeNull()
    expect(result.author).toBeNull()
    expect(result.version).toBeNull()
    expect(result.license).toBeNull()
    expect(result.category).toBeNull()
    expect(result.repository).toBeNull()
  })

  it('sets tags to an empty array when absent', () => {
    const result = parser.parse(MINIMAL_VALID) as ParsedSkillMetadata
    expect(result.tags).toEqual([])
  })

  it('preserves rawContent in the result', () => {
    const result = parser.parse(MINIMAL_VALID) as ParsedSkillMetadata
    expect(result.rawContent).toBe(MINIMAL_VALID)
  })

  it('includes the original frontmatter object in the result', () => {
    const result = parser.parse(MINIMAL_VALID) as ParsedSkillMetadata
    expect(result.frontmatter.name).toBe('my-skill')
  })
})

// ---------------------------------------------------------------------------
// parseWithValidation
// ---------------------------------------------------------------------------

describe('SkillParser.parseWithValidation', () => {
  const parser = new SkillParser()

  it('returns failed validation when frontmatter is missing', () => {
    const { metadata, validation, frontmatter } = parser.parseWithValidation('No frontmatter here.')
    expect(metadata).toBeNull()
    expect(frontmatter).toBeNull()
    expect(validation.valid).toBe(false)
    expect(validation.errors.length).toBeGreaterThan(0)
  })

  it('returns null metadata and errors when validation fails', () => {
    const { metadata, validation } = parser.parseWithValidation(
      makeSkillMd('description: missing name')
    )
    expect(metadata).toBeNull()
    expect(validation.valid).toBe(false)
  })

  it('returns non-null metadata and the frontmatter when valid', () => {
    const { metadata, validation, frontmatter } = parser.parseWithValidation(MINIMAL_VALID)
    expect(metadata).not.toBeNull()
    expect(validation.valid).toBe(true)
    expect(frontmatter?.name).toBe('my-skill')
  })

  it('includes warnings alongside a successful parse', () => {
    const { validation } = parser.parseWithValidation(MINIMAL_VALID)
    expect(validation.warnings.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// extractBody
// ---------------------------------------------------------------------------

describe('SkillParser.extractBody', () => {
  const parser = new SkillParser()

  it('returns content after the closing --- delimiter', () => {
    const content = '---\nname: x\n---\n\n# Body\n\nSome content.'
    expect(parser.extractBody(content)).toBe('# Body\n\nSome content.')
  })

  it('returns the full content when no frontmatter delimiter is present', () => {
    const content = '# Just a body\n\nNo frontmatter.'
    expect(parser.extractBody(content)).toBe(content)
  })

  it('returns an empty string when there is no body after the frontmatter', () => {
    const content = '---\nname: x\n---'
    expect(parser.extractBody(content)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// inferTrustTier
// ---------------------------------------------------------------------------

describe('SkillParser.inferTrustTier', () => {
  const parser = new SkillParser()

  function makeMetadata(overrides: Partial<ParsedSkillMetadata>): ParsedSkillMetadata {
    return {
      name: 'test-skill',
      description: null,
      author: null,
      version: null,
      tags: [],
      category: null,
      license: null,
      repository: null,
      rawContent: '',
      frontmatter: { name: 'test-skill' },
      ...overrides,
    }
  }

  it('returns verified for an anthropic author', () => {
    expect(parser.inferTrustTier(makeMetadata({ author: 'anthropic' }))).toBe('verified')
  })

  it('returns verified for a skillsmith author', () => {
    expect(parser.inferTrustTier(makeMetadata({ author: 'skillsmith' }))).toBe('verified')
  })

  it('is case-insensitive for verified author matching', () => {
    expect(parser.inferTrustTier(makeMetadata({ author: 'Anthropic' }))).toBe('verified')
  })

  it('returns community when metadata score is 3 or more', () => {
    const metadata = makeMetadata({
      author: 'acme',
      // description > 50 chars, 3+ tags, version, license = score 4
      description: 'A well-documented skill that exceeds the fifty character threshold.',
      tags: ['a', 'b', 'c'],
      version: '1.0.0',
      license: 'MIT',
    })
    expect(parser.inferTrustTier(metadata)).toBe('community')
  })

  it('returns experimental when metadata score is exactly 1', () => {
    const metadata = makeMetadata({
      author: 'acme',
      version: '1.0.0',
      // description null, no tags, no license = score 1
    })
    expect(parser.inferTrustTier(metadata)).toBe('experimental')
  })

  it('returns unknown when there is no meaningful metadata', () => {
    expect(parser.inferTrustTier(makeMetadata({ author: 'acme' }))).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// SkillParser.parseDependencyBlock (static)
// ---------------------------------------------------------------------------

describe('SkillParser.parseDependencyBlock', () => {
  it('returns undefined when there is no dependencies key', () => {
    expect(SkillParser.parseDependencyBlock('name: x\nversion: 1.0.0')).toBeUndefined()
  })

  it('returns undefined when dependencies is not an object', () => {
    expect(SkillParser.parseDependencyBlock('dependencies: some-string')).toBeUndefined()
  })

  it('returns a parsed array when dependencies has a flat array item', () => {
    // The built-in parser is best-effort; nested objects need js-yaml.
    // A flat array under dependencies is the simplest case it can handle.
    const yaml = 'dependencies:\n  - some-skill'
    const result = SkillParser.parseDependencyBlock(yaml)
    expect(result).toEqual(['some-skill'])
  })
})

// ---------------------------------------------------------------------------
// SkillParser.checkReferences (static)
// ---------------------------------------------------------------------------

describe('SkillParser.checkReferences', () => {
  it('returns empty warnings and matches for clean content', () => {
    const { warnings, matches } = SkillParser.checkReferences('# A clean skill\n\nNo refs here.')
    expect(warnings).toHaveLength(0)
    expect(matches).toHaveLength(0)
  })

  it('detects a Docker container name', () => {
    const { matches } = SkillParser.checkReferences('Run `docker exec myproject-dev-1 npm test`.')
    expect(matches.some((m) => m.pattern === 'Docker container name')).toBe(true)
  })

  it('detects an npm package scope', () => {
    const { matches } = SkillParser.checkReferences('Install `@skillsmith-tools/helper` first.')
    expect(matches.some((m) => m.pattern === 'npm package scope')).toBe(true)
  })

  it('detects a GitHub repo reference', () => {
    const { matches } = SkillParser.checkReferences('See github.com/acme-corp/my-repo for details.')
    expect(matches.some((m) => m.pattern === 'GitHub repo reference')).toBe(true)
  })

  it('detects a project URL', () => {
    const { matches } = SkillParser.checkReferences(
      'Documentation at https://myproject.app/docs/guide.'
    )
    expect(matches.some((m) => m.pattern === 'Project URL')).toBe(true)
  })

  it('includes the correct line number in match results', () => {
    const content = 'Line one.\nSee github.com/acme-corp/my-repo here.\nLine three.'
    const { matches } = SkillParser.checkReferences(content)
    const ghMatch = matches.find((m) => m.pattern === 'GitHub repo reference')
    expect(ghMatch?.line).toBe(2)
  })

  it('truncates matched text longer than 80 characters', () => {
    const longUrl = 'https://very-long-project.app/' + 'x'.repeat(100) + '/'
    const { matches } = SkillParser.checkReferences(`See ${longUrl} for info.`)
    const urlMatch = matches.find((m) => m.pattern === 'Project URL')
    expect(urlMatch).toBeDefined()
    expect(urlMatch!.text.length).toBeLessThanOrEqual(83) // 80 chars + '...'
  })

  it('applies custom patterns alongside the defaults', () => {
    const { matches } = SkillParser.checkReferences('The secret token is abc-123.', [/abc-\d+/g])
    expect(matches.some((m) => m.pattern === 'Custom pattern')).toBe(true)
  })

  it('includes a summary warning when matches are found', () => {
    const { warnings } = SkillParser.checkReferences(
      'See github.com/acme-corp/my-repo for details.'
    )
    expect(warnings.length).toBeGreaterThan(0)
  })
})
