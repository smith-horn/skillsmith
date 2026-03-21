/**
 * Unit tests for recommend-scoring.ts pure logic functions
 *
 * Tests inferRolesFromTags, normalizeSkillName, skillsOverlap, filterOverlappingSkills.
 * No mocking required — all functions are pure.
 */

import { describe, it, expect } from 'vitest'
import {
  inferRolesFromTags,
  normalizeSkillName,
  skillsOverlap,
  filterOverlappingSkills,
} from '../src/commands/recommend-scoring.js'
import type { SkillRecommendation, InstalledSkill } from '../src/commands/recommend.types.js'

// ============================================================================
// inferRolesFromTags
// ============================================================================

describe('inferRolesFromTags', () => {
  it('returns empty array for empty tags', () => {
    expect(inferRolesFromTags([])).toEqual([])
  })

  it('returns empty array for unrecognized tags', () => {
    expect(inferRolesFromTags(['banana', 'spaceship'])).toEqual([])
  })

  it('infers code-quality from lint-related tags', () => {
    const roles = inferRolesFromTags(['lint'])
    expect(roles).toContain('code-quality')
  })

  it('infers testing from test-related tags', () => {
    const roles = inferRolesFromTags(['vitest'])
    expect(roles).toContain('testing')
  })

  it('infers documentation from docs tags', () => {
    const roles = inferRolesFromTags(['jsdoc'])
    expect(roles).toContain('documentation')
  })

  it('infers workflow from CI/CD tags', () => {
    const roles = inferRolesFromTags(['ci-cd'])
    expect(roles).toContain('workflow')
  })

  it('infers security from security tags', () => {
    const roles = inferRolesFromTags(['vulnerability'])
    expect(roles).toContain('security')
  })

  it('infers development-partner from AI tags', () => {
    const roles = inferRolesFromTags(['copilot'])
    expect(roles).toContain('development-partner')
  })

  it('deduplicates roles from multiple matching tags', () => {
    const roles = inferRolesFromTags(['lint', 'eslint', 'format'])
    expect(roles).toEqual(['code-quality'])
  })

  it('returns multiple roles for diverse tags', () => {
    const roles = inferRolesFromTags(['lint', 'testing', 'deploy'])
    expect(roles).toContain('code-quality')
    expect(roles).toContain('testing')
    expect(roles).toContain('workflow')
    expect(roles).toHaveLength(3)
  })

  it('normalizes hyphens and underscores in tags', () => {
    const roles = inferRolesFromTags(['code_review'])
    expect(roles).toContain('code-quality')
  })

  it('is case-insensitive', () => {
    const roles = inferRolesFromTags(['LINT', 'Testing'])
    expect(roles).toContain('code-quality')
    expect(roles).toContain('testing')
  })
})

// ============================================================================
// normalizeSkillName
// ============================================================================

describe('normalizeSkillName', () => {
  it('lowercases the name', () => {
    expect(normalizeSkillName('MyLinter')).toBe('mylinter')
  })

  it('removes hyphens and underscores', () => {
    expect(normalizeSkillName('my-linter_tool')).toBe('mylintertool')
  })

  it('strips leading "skill" prefix', () => {
    expect(normalizeSkillName('skill-formatter')).toBe('formatter')
  })

  it('strips trailing "skill" suffix', () => {
    expect(normalizeSkillName('lint-skill')).toBe('lint')
  })

  it('strips leading "helper" prefix', () => {
    expect(normalizeSkillName('helper-utils')).toBe('utils')
  })

  it('strips trailing "helper" suffix', () => {
    expect(normalizeSkillName('code-helper')).toBe('code')
  })

  it('trims whitespace', () => {
    expect(normalizeSkillName('  linter  ')).toBe('linter')
  })

  it('handles combined normalization', () => {
    expect(normalizeSkillName('Skill-Code_Helper')).toBe('code')
  })
})

// ============================================================================
// skillsOverlap
// ============================================================================

describe('skillsOverlap', () => {
  const makeInstalled = (name: string, tags: string[] = []): InstalledSkill => ({
    name,
    directory: name,
    tags,
    category: null,
  })

  const makeRecommended = (name: string, skillId: string): SkillRecommendation => ({
    skill_id: skillId,
    name,
    reason: 'test',
    similarity_score: 0.8,
    trust_tier: 'community',
    quality_score: 80,
  })

  it('detects exact name match after normalization', () => {
    const installed = makeInstalled('lint-skill')
    const recommended = makeRecommended('skill-lint', 'author/skill-lint')
    expect(skillsOverlap(installed, recommended)).toBe(true)
  })

  it('detects when skill_id contains installed name', () => {
    const installed = makeInstalled('formatter')
    const recommended = makeRecommended('code-formatter-pro', 'acme/formatter-pro')
    expect(skillsOverlap(installed, recommended)).toBe(true)
  })

  it('detects substring overlap for names >= 4 chars', () => {
    const installed = makeInstalled('linter')
    const recommended = makeRecommended('super-linter', 'acme/super-linter')
    expect(skillsOverlap(installed, recommended)).toBe(true)
  })

  it('does not detect substring overlap for short names', () => {
    // Short names (<4 chars) skip substring check, but skill_id check still applies
    // Use a skill_id that does NOT contain the installed name
    const installed = makeInstalled('go')
    const recommended = makeRecommended('rust-tools', 'acme/rust-tools')
    expect(skillsOverlap(installed, recommended)).toBe(false)
  })

  it('detects tag overlap with recommended name parts', () => {
    const installed = makeInstalled('my-tool', ['testing', 'vitest'])
    const recommended = makeRecommended('vitest-helper', 'acme/vitest-helper')
    expect(skillsOverlap(installed, recommended)).toBe(true)
  })

  it('returns false for unrelated skills', () => {
    const installed = makeInstalled('formatter', ['formatting'])
    const recommended = makeRecommended('security-auditor', 'acme/security-auditor')
    expect(skillsOverlap(installed, recommended)).toBe(false)
  })
})

// ============================================================================
// filterOverlappingSkills
// ============================================================================

describe('filterOverlappingSkills', () => {
  const makeInstalled = (name: string, tags: string[] = []): InstalledSkill => ({
    name,
    directory: name,
    tags,
    category: null,
  })

  const makeRecommended = (name: string, skillId: string): SkillRecommendation => ({
    skill_id: skillId,
    name,
    reason: 'test',
    similarity_score: 0.8,
    trust_tier: 'community',
    quality_score: 80,
  })

  it('returns all recommendations when no installed skills', () => {
    const recs = [makeRecommended('foo', 'a/foo'), makeRecommended('bar', 'a/bar')]
    const result = filterOverlappingSkills(recs, [])
    expect(result.filtered).toHaveLength(2)
    expect(result.overlapCount).toBe(0)
  })

  it('filters overlapping recommendations', () => {
    const recs = [makeRecommended('linter', 'a/linter'), makeRecommended('security', 'a/security')]
    const installed = [makeInstalled('linter')]
    const result = filterOverlappingSkills(recs, installed)
    expect(result.filtered).toHaveLength(1)
    expect(result.filtered[0]!.name).toBe('security')
    expect(result.overlapCount).toBe(1)
  })

  it('returns empty array when all overlap', () => {
    const recs = [makeRecommended('linter', 'a/linter')]
    const installed = [makeInstalled('linter')]
    const result = filterOverlappingSkills(recs, installed)
    expect(result.filtered).toHaveLength(0)
    expect(result.overlapCount).toBe(1)
  })
})
