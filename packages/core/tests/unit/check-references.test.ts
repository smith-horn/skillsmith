import { describe, it, expect } from 'vitest'
import { SkillParser } from '../../src/indexer/SkillParser.js'

describe('SkillParser.checkReferences', () => {
  describe('default patterns', () => {
    it('detects Docker container names (e.g., myproject-dev-1)', () => {
      const content = 'Run: docker exec myproject-dev-1 npm test'
      const result = SkillParser.checkReferences(content)

      expect(result.matches).toHaveLength(1)
      expect(result.matches[0]).toMatchObject({
        line: 1,
        text: 'myproject-dev-1',
        pattern: 'Docker container name',
      })
    })

    it('detects npm package scopes (e.g., @my-org/)', () => {
      const content = 'import { foo } from "@my-org/utils"'
      const result = SkillParser.checkReferences(content)

      expect(result.matches).toHaveLength(1)
      expect(result.matches[0]).toMatchObject({
        text: '@my-org/',
        pattern: 'npm package scope',
      })
    })

    it('detects project URLs (e.g., https://myapp.app/)', () => {
      const content = 'Visit https://myapp.app/ for more info'
      const result = SkillParser.checkReferences(content)

      expect(result.matches).toHaveLength(1)
      expect(result.matches[0]).toMatchObject({
        text: 'https://myapp.app/',
        pattern: 'Project URL',
      })
    })

    it('detects GitHub repo references (e.g., github.com/org/repo)', () => {
      const content = 'Source: github.com/smith-horn/skillsmith'
      const result = SkillParser.checkReferences(content)

      expect(result.matches).toHaveLength(1)
      expect(result.matches[0]).toMatchObject({
        text: 'github.com/smith-horn/skillsmith',
        pattern: 'GitHub repo reference',
      })
    })

    it('detects specific line counts (e.g., 1212 lines)', () => {
      const content = 'This file has 1212 lines of code'
      const result = SkillParser.checkReferences(content)

      expect(result.matches).toHaveLength(1)
      expect(result.matches[0]).toMatchObject({
        text: '1212 lines',
        pattern: 'Specific line count',
      })
    })
  })

  describe('custom patterns', () => {
    it('merges custom patterns with defaults', () => {
      const content = 'Use ACME_SECRET_KEY for auth\ndocker exec acme-dev-1 test'
      const custom = [/ACME_[A-Z_]+/g]
      const result = SkillParser.checkReferences(content, custom)

      const patterns = result.matches.map((m) => m.pattern)
      expect(patterns).toContain('Custom pattern')
      expect(patterns).toContain('Docker container name')
    })

    it('labels custom pattern matches as "Custom pattern"', () => {
      const content = 'token: xoxb-abc-123'
      const custom = [/xoxb-[a-z]+-\d+/g]
      const result = SkillParser.checkReferences(content, custom)

      expect(result.matches).toHaveLength(1)
      expect(result.matches[0]!.pattern).toBe('Custom pattern')
    })
  })

  describe('edge cases', () => {
    it('returns empty results for content with no matches', () => {
      const content = 'A simple skill that formats code.'
      const result = SkillParser.checkReferences(content)

      expect(result.warnings).toHaveLength(0)
      expect(result.matches).toHaveLength(0)
    })

    it('handles empty string content', () => {
      const result = SkillParser.checkReferences('')

      expect(result.warnings).toHaveLength(0)
      expect(result.matches).toHaveLength(0)
    })

    it('truncates matched text to 80 characters', () => {
      // GitHub repo pattern matches [a-zA-Z-]+ for org and repo segments
      const longRepo = 'github.com/' + 'a-'.repeat(50) + 'a/' + 'b-'.repeat(50) + 'b'
      const result = SkillParser.checkReferences(longRepo)

      const ghMatch = result.matches.find((m) => m.pattern === 'GitHub repo reference')
      expect(ghMatch).toBeDefined()
      expect(ghMatch!.text).toHaveLength(83) // 80 + '...'
      expect(ghMatch!.text).toMatch(/\.\.\.$/u)
    })

    it('reports correct line numbers (1-based)', () => {
      const content = 'line one\nline two\ngithub.com/org/repo on line three'
      const result = SkillParser.checkReferences(content)

      expect(result.matches).toHaveLength(1)
      expect(result.matches[0]!.line).toBe(3)
    })

    it('handles multiple matches on the same line', () => {
      const content = 'See github.com/org/repo and github.com/other/lib'
      const result = SkillParser.checkReferences(content)

      const ghMatches = result.matches.filter((m) => m.pattern === 'GitHub repo reference')
      expect(ghMatches).toHaveLength(2)
      expect(ghMatches[0]!.line).toBe(1)
      expect(ghMatches[1]!.line).toBe(1)
    })
  })

  describe('false positive awareness', () => {
    it('matches legitimate npm scopes (documents false positive risk)', () => {
      // The pattern /@[a-z]+-[a-z]+\// matches any hyphenated scope,
      // including legitimate ones like @babel-core/ or @my-lib/.
      // This is by design: the method flags for review, not rejection.
      const content = 'import { x } from "@some-lib/core"'
      const result = SkillParser.checkReferences(content)

      expect(result.matches).toHaveLength(1)
      expect(result.matches[0]!.pattern).toBe('npm package scope')
      expect(result.warnings[0]).toContain('project-specific reference')
    })
  })
})
