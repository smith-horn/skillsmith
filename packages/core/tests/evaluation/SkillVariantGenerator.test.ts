import { describe, it, expect, vi } from 'vitest'
import { SkillVariantGenerator } from '../../src/evaluation/SkillVariantGenerator.js'
import type { RewriteClient } from '../../src/evaluation/SkillVariantGenerator.js'
import type { FailurePattern } from '../../src/evaluation/types.js'

const BASIC_SKILL = `# Test Skill

## Instructions

Do something useful.

## Examples

Example 1: hello world
`

function makeFailurePatterns(count = 3): FailurePattern[] {
  const categories = ['wrong_format', 'missing_context', 'reasoning_error'] as const
  return categories.slice(0, count).map((cat, i) => ({
    category: cat,
    frequency: 10 - i * 3,
    examples: [],
    suggestedFix: `Fix for ${cat}`,
  }))
}

function makeLargeSkill(lineCount: number): string {
  const lines = ['# Large Skill', '']
  for (let i = 0; i < 5; i++) {
    lines.push(`## Section ${i + 1}`, '')
    const sectionSize = Math.floor((lineCount - 12) / 5)
    for (let j = 0; j < sectionSize; j++) {
      lines.push(`Line ${j} of section ${i + 1}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

describe('SkillVariantGenerator', () => {
  const baseParams = {
    skillId: 'test-skill',
    content: BASIC_SKILL,
    parentId: null,
    iteration: 1,
    failurePatterns: makeFailurePatterns(),
  }

  describe('augment strategy', () => {
    it('appends failure fixes under ## Skill Improvement Notes', async () => {
      const gen = new SkillVariantGenerator({ strategies: ['augment'] })
      const variants = await gen.generate(baseParams)
      expect(variants).toHaveLength(1)
      expect(variants[0].generationMethod).toBe('augment')
      expect(variants[0].content).toContain('## Skill Improvement Notes')
      expect(variants[0].content).toContain('wrong_format')
      expect(variants[0].content).toContain('missing_context')
      expect(variants[0].content).toContain('reasoning_error')
    })

    it('replaces existing ## Skill Improvement Notes section', async () => {
      const existingContent = `${BASIC_SKILL}\n## Skill Improvement Notes\n\n- old fix\n`
      const gen = new SkillVariantGenerator({ strategies: ['augment'] })
      const variants = await gen.generate({
        ...baseParams,
        content: existingContent,
      })
      expect(variants).toHaveLength(1)
      // Should not have double sections
      const matches = variants[0].content.match(/## Skill Improvement Notes/g)
      expect(matches).toHaveLength(1)
      // Should have new fixes, not old
      expect(variants[0].content).not.toContain('old fix')
      expect(variants[0].content).toContain('wrong_format')
    })

    it('returns nothing when no failure patterns', async () => {
      const gen = new SkillVariantGenerator({ strategies: ['augment'] })
      const variants = await gen.generate({
        ...baseParams,
        failurePatterns: [],
      })
      expect(variants).toHaveLength(0)
    })
  })

  describe('decompose strategy', () => {
    it('is skipped for skills <=200 lines', async () => {
      const gen = new SkillVariantGenerator({ strategies: ['decompose'] })
      const variants = await gen.generate(baseParams) // BASIC_SKILL is ~10 lines
      expect(variants).toHaveLength(0)
    })

    it('produces a focused variant for skills >200 lines', async () => {
      const gen = new SkillVariantGenerator({ strategies: ['decompose'] })
      const largeContent = makeLargeSkill(250)
      const variants = await gen.generate({
        ...baseParams,
        content: largeContent,
      })
      expect(variants.length).toBeGreaterThanOrEqual(1)
      const variant = variants[0]
      expect(variant.generationMethod).toBe('decompose')
      expect(variant.content.split('\n').length).toBeLessThan(largeContent.split('\n').length)
    })
  })

  describe('specialize strategy', () => {
    it('returns null for general domain', async () => {
      const gen = new SkillVariantGenerator({
        strategies: ['specialize'],
        benchmarkDomain: 'general',
      })
      const variants = await gen.generate(baseParams)
      expect(variants).toHaveLength(0)
    })

    it('strips irrelevant sections for a specific domain', async () => {
      const content = [
        '# Multi-Domain Skill',
        '',
        '## Finance Section',
        '',
        'This section covers finance and accounting.',
        '',
        '## Cooking Section',
        '',
        'This section covers cooking recipes.',
        '',
        '## Finance Analysis',
        '',
        'More finance content here.',
      ].join('\n')

      const gen = new SkillVariantGenerator({
        strategies: ['specialize'],
        benchmarkDomain: 'finance',
      })
      const variants = await gen.generate({
        ...baseParams,
        content,
      })
      expect(variants).toHaveLength(1)
      expect(variants[0].content).toContain('Finance Section')
      expect(variants[0].content).toContain('Finance Analysis')
      expect(variants[0].content).not.toContain('Cooking Section')
    })
  })

  describe('llm_rewrite strategy', () => {
    it('returns null when no rewriteClient is provided', async () => {
      const gen = new SkillVariantGenerator({ strategies: ['llm_rewrite'] })
      const variants = await gen.generate(baseParams)
      expect(variants).toHaveLength(0)
    })

    it('produces a variant using the rewrite client', async () => {
      const mockClient: RewriteClient = {
        rewrite: vi.fn().mockResolvedValue('# Rewritten Skill\n\nImproved content here.'),
      }
      const gen = new SkillVariantGenerator({
        strategies: ['llm_rewrite'],
        rewriteClient: mockClient,
        benchmarkDomain: 'qa',
      })
      const variants = await gen.generate(baseParams)
      expect(variants).toHaveLength(1)
      expect(variants[0].generationMethod).toBe('llm_rewrite')
      expect(variants[0].content).toContain('Rewritten Skill')
      expect(mockClient.rewrite).toHaveBeenCalledWith({
        model: 'claude-sonnet-4-6',
        skillContent: BASIC_SKILL,
        failurePatterns: baseParams.failurePatterns,
        benchmarkDomain: 'qa',
      })
    })

    it('skips variant when rewrite returns identical content', async () => {
      const mockClient: RewriteClient = {
        rewrite: vi.fn().mockResolvedValue(BASIC_SKILL),
      }
      const gen = new SkillVariantGenerator({
        strategies: ['llm_rewrite'],
        rewriteClient: mockClient,
      })
      const variants = await gen.generate(baseParams)
      expect(variants).toHaveLength(0)
    })
  })

  describe('deduplication', () => {
    it('deduplicates identical content from different frontier members', async () => {
      const gen = new SkillVariantGenerator({ strategies: ['augment'] })

      const variants1 = await gen.generate(baseParams)
      expect(variants1).toHaveLength(1)

      // Same content + same patterns → same output → deduplicated
      const variants2 = await gen.generate({
        ...baseParams,
        parentId: 'different-parent',
      })
      expect(variants2).toHaveLength(0)
    })

    it('resets dedup between runs', async () => {
      const gen = new SkillVariantGenerator({ strategies: ['augment'] })

      const variants1 = await gen.generate(baseParams)
      expect(variants1).toHaveLength(1)

      gen.resetDedup()

      const variants2 = await gen.generate(baseParams)
      expect(variants2).toHaveLength(1)
    })
  })

  describe('variant metadata', () => {
    it('sets contentLines and costTokens', async () => {
      const gen = new SkillVariantGenerator({ strategies: ['augment'] })
      const variants = await gen.generate(baseParams)
      expect(variants[0].contentLines).toBeGreaterThan(0)
      expect(variants[0].costTokens).toBe(0) // augment is free
    })

    it('sets non-zero costTokens for llm_rewrite', async () => {
      const mockClient: RewriteClient = {
        rewrite: vi.fn().mockResolvedValue('# Rewritten\n\nNew content.'),
      }
      const gen = new SkillVariantGenerator({
        strategies: ['llm_rewrite'],
        rewriteClient: mockClient,
      })
      const variants = await gen.generate(baseParams)
      expect(variants[0].costTokens).toBeGreaterThan(0)
    })

    it('generates unique IDs per variant', async () => {
      const gen = new SkillVariantGenerator({
        strategies: ['augment', 'specialize'],
        benchmarkDomain: 'finance',
      })
      const content = [
        '# Skill',
        '',
        '## Finance',
        '',
        'Finance content.',
        '',
        '## Cooking',
        '',
        'Cooking content.',
      ].join('\n')
      const variants = await gen.generate({
        ...baseParams,
        content,
      })
      if (variants.length >= 2) {
        expect(variants[0].id).not.toBe(variants[1].id)
        expect(variants[0].contentHash).not.toBe(variants[1].contentHash)
      }
    })
  })
})
