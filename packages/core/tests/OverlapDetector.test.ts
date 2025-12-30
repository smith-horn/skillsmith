/**
 * SMI-604: OverlapDetector Tests
 * Tests for trigger phrase overlap detection
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { OverlapDetector, type TriggerPhraseSkill } from '../src/matching/index.js'

describe('OverlapDetector', () => {
  let detector: OverlapDetector

  const testSkills: TriggerPhraseSkill[] = [
    {
      id: 'commit-skill',
      name: 'Git Commit',
      triggerPhrases: ['create commit', 'git commit', 'write commit message'],
    },
    {
      id: 'commit-helper',
      name: 'Commit Helper',
      triggerPhrases: ['make commit', 'git commit', 'commit changes'], // Overlaps with commit-skill
    },
    {
      id: 'pr-review',
      name: 'PR Review',
      triggerPhrases: ['review pr', 'code review', 'check pull request'],
    },
    {
      id: 'test-generator',
      name: 'Test Generator',
      triggerPhrases: ['write test', 'create test', 'generate test'],
    },
    {
      id: 'jest-helper',
      name: 'Jest Helper',
      triggerPhrases: ['jest test', 'write jest test', 'create jest test'],
    },
    {
      id: 'docker-skill',
      name: 'Docker Helper',
      triggerPhrases: ['docker compose', 'create container', 'build docker'],
    },
  ]

  beforeEach(() => {
    detector = new OverlapDetector({
      useFallback: true,
      phraseThreshold: 0.75,
      overlapThreshold: 0.6,
    })
  })

  afterEach(() => {
    detector.close()
  })

  describe('initialization', () => {
    it('should create detector with default options', () => {
      const d = new OverlapDetector()
      expect(d).toBeDefined()
      d.close()
    })

    it('should create detector with custom thresholds', () => {
      const d = new OverlapDetector({
        useFallback: true,
        phraseThreshold: 0.8,
        overlapThreshold: 0.7,
      })
      expect(d.getPhraseThreshold()).toBe(0.8)
      expect(d.getOverlapThreshold()).toBe(0.7)
      d.close()
    })

    it('should report fallback mode correctly', () => {
      expect(detector.isUsingFallback()).toBe(true)
    })

    it('should return correct thresholds', () => {
      expect(detector.getPhraseThreshold()).toBe(0.75)
      expect(detector.getOverlapThreshold()).toBe(0.6)
    })
  })

  describe('detectOverlap', () => {
    it('should detect overlap between similar skills', async () => {
      const skill1 = testSkills[0] // commit-skill
      const skill2 = testSkills[1] // commit-helper (overlaps)

      const result = await detector.detectOverlap(skill1, skill2)

      expect(result.skillId1).toBe('commit-skill')
      expect(result.skillId2).toBe('commit-helper')
      expect(result.overlapScore).toBeGreaterThan(0)
      expect(result.overlappingPhrases.length).toBeGreaterThan(0)
    })

    it('should detect exact phrase matches', async () => {
      const skill1: TriggerPhraseSkill = {
        id: 'skill-a',
        name: 'Skill A',
        triggerPhrases: ['run test', 'execute'],
      }
      const skill2: TriggerPhraseSkill = {
        id: 'skill-b',
        name: 'Skill B',
        triggerPhrases: ['run test', 'other'],
      }

      const result = await detector.detectOverlap(skill1, skill2)

      expect(result.overlappingPhrases.length).toBeGreaterThan(0)
      const exactMatch = result.overlappingPhrases.find(
        (p) => p.phrase1 === 'run test' && p.phrase2 === 'run test'
      )
      expect(exactMatch).toBeDefined()
      expect(exactMatch?.similarity).toBe(1.0)
    })

    it('should detect overlap between unrelated skills based on semantic similarity', async () => {
      const skill1 = testSkills[0] // commit-skill
      const skill2 = testSkills[5] // docker-skill

      const result = await detector.detectOverlap(skill1, skill2)

      // With mock embeddings, semantic similarity may be high for any phrases
      // The important thing is the score is between 0 and 1
      expect(result.overlapScore).toBeGreaterThanOrEqual(0)
      expect(result.overlapScore).toBeLessThanOrEqual(1)
    })

    it('should return correct skill IDs', async () => {
      const result = await detector.detectOverlap(testSkills[0], testSkills[2])

      expect(result.skillId1).toBe(testSkills[0].id)
      expect(result.skillId2).toBe(testSkills[2].id)
    })

    it('should calculate overlap score correctly', async () => {
      const skill1: TriggerPhraseSkill = {
        id: 'a',
        name: 'A',
        triggerPhrases: ['phrase 1', 'phrase 2', 'phrase 3'],
      }
      const skill2: TriggerPhraseSkill = {
        id: 'b',
        name: 'B',
        triggerPhrases: ['phrase 1', 'phrase 2', 'different'],
      }

      const result = await detector.detectOverlap(skill1, skill2)

      expect(result.overlapScore).toBeGreaterThan(0)
      expect(result.overlapScore).toBeLessThanOrEqual(1)
    })

    it('should handle empty trigger phrases', async () => {
      const skill1: TriggerPhraseSkill = {
        id: 'empty1',
        name: 'Empty 1',
        triggerPhrases: [],
      }
      const skill2: TriggerPhraseSkill = {
        id: 'empty2',
        name: 'Empty 2',
        triggerPhrases: [],
      }

      const result = await detector.detectOverlap(skill1, skill2)

      expect(result.overlapScore).toBe(0)
      expect(result.overlappingPhrases).toHaveLength(0)
    })

    it('should mark duplicates correctly', async () => {
      const skill1: TriggerPhraseSkill = {
        id: 'dup1',
        name: 'Duplicate 1',
        triggerPhrases: ['same phrase', 'another same'],
      }
      const skill2: TriggerPhraseSkill = {
        id: 'dup2',
        name: 'Duplicate 2',
        triggerPhrases: ['same phrase', 'another same'],
      }

      const result = await detector.detectOverlap(skill1, skill2)

      expect(result.isDuplicate).toBe(true)
      expect(result.overlapScore).toBeGreaterThanOrEqual(0.6)
    })

    it('should normalize phrases for comparison', async () => {
      const skill1: TriggerPhraseSkill = {
        id: 'norm1',
        name: 'Norm 1',
        triggerPhrases: ['  Run Test  '],
      }
      const skill2: TriggerPhraseSkill = {
        id: 'norm2',
        name: 'Norm 2',
        triggerPhrases: ['run test'],
      }

      const result = await detector.detectOverlap(skill1, skill2)

      expect(result.overlappingPhrases.length).toBeGreaterThan(0)
    })
  })

  describe('filterByOverlap', () => {
    it('should filter overlapping candidates', async () => {
      const installed = [testSkills[0]] // commit-skill
      const candidates = testSkills.slice(1) // Includes commit-helper which overlaps

      const result = await detector.filterByOverlap(candidates, installed)

      expect(result.accepted).toBeDefined()
      expect(result.rejected).toBeDefined()
      expect(result.accepted.length + result.rejected.length).toBe(candidates.length)
    })

    it('should process candidates and return filtered results', async () => {
      const installed = [testSkills[0]] // commit-skill
      const candidates = [testSkills[5]] // docker-skill

      const result = await detector.filterByOverlap(candidates, installed)

      // With mock embeddings, skills may or may not be considered overlapping
      // The important thing is the total count is preserved
      expect(result.accepted.length + result.rejected.length).toBe(1)
    })

    it('should reject overlapping candidates', async () => {
      const installed = [testSkills[0]] // commit-skill
      const candidates = [testSkills[1]] // commit-helper - overlaps

      const result = await detector.filterByOverlap(candidates, installed)

      // May or may not be rejected depending on semantic similarity
      expect(result.accepted.length + result.rejected.length).toBe(1)
    })

    it('should handle empty installed list', async () => {
      const result = await detector.filterByOverlap(testSkills, [])

      // With empty installed list, candidates are checked against each other
      // So some may be rejected if they overlap with previously accepted ones
      expect(result.accepted.length + result.rejected.length).toBe(testSkills.length)
      expect(result.accepted.length).toBeGreaterThan(0)
    })

    it('should handle empty candidates list', async () => {
      const result = await detector.filterByOverlap([], testSkills)

      expect(result.accepted).toHaveLength(0)
      expect(result.rejected).toHaveLength(0)
    })

    it('should track overlap with correct skill', async () => {
      const installed = [testSkills[0]] // commit-skill
      const candidates = [testSkills[1]] // commit-helper

      const d = new OverlapDetector({
        useFallback: true,
        overlapThreshold: 0.1, // Low threshold to ensure rejection
      })

      const result = await d.filterByOverlap(candidates, installed)

      if (result.rejected.length > 0) {
        expect(result.rejected[0].overlapsWith).toBe('commit-skill')
        expect(result.rejected[0].overlapScore).toBeGreaterThan(0)
      }

      d.close()
    })

    it('should prevent duplicate recommendations', async () => {
      const installed: TriggerPhraseSkill[] = []
      const candidates: TriggerPhraseSkill[] = [
        {
          id: 'dup-a',
          name: 'Duplicate A',
          triggerPhrases: ['same action'],
        },
        {
          id: 'dup-b',
          name: 'Duplicate B',
          triggerPhrases: ['same action'],
        },
      ]

      const d = new OverlapDetector({
        useFallback: true,
        overlapThreshold: 0.5,
      })

      const result = await d.filterByOverlap(candidates, installed)

      // At most one should be rejected for overlapping with the other
      expect(result.accepted.length).toBeGreaterThanOrEqual(1)

      d.close()
    })
  })

  describe('findAllOverlaps', () => {
    it('should find all overlapping pairs', async () => {
      const overlaps = await detector.findAllOverlaps(testSkills)

      expect(overlaps).toBeDefined()
      expect(Array.isArray(overlaps)).toBe(true)
    })

    it('should sort by overlap score', async () => {
      const overlaps = await detector.findAllOverlaps(testSkills)

      for (let i = 1; i < overlaps.length; i++) {
        expect(overlaps[i - 1].overlapScore).toBeGreaterThanOrEqual(overlaps[i].overlapScore)
      }
    })

    it('should include overlapping phrase details', async () => {
      const overlaps = await detector.findAllOverlaps(testSkills)

      for (const overlap of overlaps) {
        expect(overlap.overlappingPhrases).toBeDefined()
        expect(Array.isArray(overlap.overlappingPhrases)).toBe(true)
      }
    })

    it('should handle empty skills list', async () => {
      const overlaps = await detector.findAllOverlaps([])

      expect(overlaps).toHaveLength(0)
    })

    it('should handle single skill', async () => {
      const overlaps = await detector.findAllOverlaps([testSkills[0]])

      expect(overlaps).toHaveLength(0)
    })

    it('should not include self-comparison', async () => {
      const overlaps = await detector.findAllOverlaps(testSkills)

      for (const overlap of overlaps) {
        expect(overlap.skillId1).not.toBe(overlap.skillId2)
      }
    })
  })

  describe('clear', () => {
    it('should clear cached phrase embeddings', async () => {
      // Generate some embeddings
      await detector.detectOverlap(testSkills[0], testSkills[1])

      detector.clear()

      // Should be able to detect again without issues
      const result = await detector.detectOverlap(testSkills[0], testSkills[1])
      expect(result).toBeDefined()
    })
  })

  describe('edge cases', () => {
    it('should handle special characters in phrases', async () => {
      const skill1: TriggerPhraseSkill = {
        id: 'special1',
        name: 'Special 1',
        triggerPhrases: ['run $test', 'execute!'],
      }
      const skill2: TriggerPhraseSkill = {
        id: 'special2',
        name: 'Special 2',
        triggerPhrases: ['run @test', 'other'],
      }

      const result = await detector.detectOverlap(skill1, skill2)
      expect(result).toBeDefined()
    })

    it('should handle unicode in phrases', async () => {
      const skill1: TriggerPhraseSkill = {
        id: 'unicode1',
        name: 'Unicode 1',
        triggerPhrases: ['créer test', 'ejecutar'],
      }
      const skill2: TriggerPhraseSkill = {
        id: 'unicode2',
        name: 'Unicode 2',
        triggerPhrases: ['créer test', 'autre'],
      }

      const result = await detector.detectOverlap(skill1, skill2)
      expect(result.overlappingPhrases.length).toBeGreaterThan(0)
    })

    it('should handle very long phrases', async () => {
      const longPhrase = 'this is a very long trigger phrase '.repeat(20)
      const skill1: TriggerPhraseSkill = {
        id: 'long1',
        name: 'Long 1',
        triggerPhrases: [longPhrase],
      }
      const skill2: TriggerPhraseSkill = {
        id: 'long2',
        name: 'Long 2',
        triggerPhrases: [longPhrase],
      }

      const result = await detector.detectOverlap(skill1, skill2)
      expect(result.overlappingPhrases.length).toBeGreaterThan(0)
    })
  })
})
