/**
 * Unit tests for mock skills data
 */
import { describe, it, expect } from 'vitest'
import { MOCK_SKILLS, getSkillById, searchSkills } from '../data/mockSkills.js'

describe('MOCK_SKILLS', () => {
  it('should have at least 5 skills', () => {
    expect(MOCK_SKILLS.length).toBeGreaterThanOrEqual(5)
  })

  it('should have valid skill data structure', () => {
    for (const skill of MOCK_SKILLS) {
      expect(skill.id).toBeDefined()
      expect(skill.name).toBeDefined()
      expect(skill.description).toBeDefined()
      expect(skill.author).toBeDefined()
      expect(skill.category).toBeDefined()
      expect(skill.trustTier).toBeDefined()
      expect(typeof skill.score).toBe('number')
    }
  })

  it('should have unique IDs', () => {
    const ids = MOCK_SKILLS.map((s) => s.id)
    const uniqueIds = new Set(ids)
    expect(uniqueIds.size).toBe(ids.length)
  })
})

describe('getSkillById', () => {
  it('should return skill for valid ID', () => {
    const skill = getSkillById('governance')
    expect(skill.id).toBe('governance')
    expect(skill.name).toBe('Governance')
  })

  it('should return fallback for unknown ID', () => {
    const skill = getSkillById('unknown-skill-id')
    expect(skill.id).toBe('unknown-skill-id')
    expect(skill.name).toBe('unknown-skill-id')
    expect(skill.trustTier).toBe('unverified')
    expect(skill.score).toBe(0)
  })
})

describe('searchSkills', () => {
  it('should find skills by name', () => {
    const results = searchSkills('governance')
    expect(results.length).toBeGreaterThan(0)
    expect(results.some((s) => s.name.toLowerCase().includes('governance'))).toBe(true)
  })

  it('should find skills by category', () => {
    const results = searchSkills('development')
    expect(results.length).toBeGreaterThan(0)
  })

  it('should find skills by author', () => {
    const results = searchSkills('skillsmith')
    expect(results.length).toBeGreaterThan(0)
  })

  it('should be case insensitive', () => {
    const results1 = searchSkills('DOCKER')
    const results2 = searchSkills('docker')
    expect(results1).toEqual(results2)
  })

  it('should return empty array for no matches', () => {
    const results = searchSkills('xyznonexistent123')
    expect(results).toEqual([])
  })

  it('should return empty array for empty query', () => {
    const results = searchSkills('')
    expect(results).toEqual([])
  })

  it('should return empty array for whitespace query', () => {
    const results = searchSkills('   ')
    expect(results).toEqual([])
  })
})
