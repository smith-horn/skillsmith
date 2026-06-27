/**
 * @see SMI-5413 — affix-tolerant registry-name matching
 */
import { describe, it, expect } from 'vitest'

import { normalizeSkillName, skillNameVariants } from '../../src/provenance/name-variants.js'

describe('normalizeSkillName', () => {
  it('strips a claude-skill- prefix', () => {
    expect(normalizeSkillName('claude-skill-ci-doctor')).toBe('ci-doctor')
  })

  it('strips a claude- prefix', () => {
    expect(normalizeSkillName('claude-ci-doctor')).toBe('ci-doctor')
  })

  it('strips a -claude-skill / -skill / -skills suffix', () => {
    expect(normalizeSkillName('ci-doctor-claude-skill')).toBe('ci-doctor')
    expect(normalizeSkillName('ci-doctor-skill')).toBe('ci-doctor')
    expect(normalizeSkillName('ci-doctor-skills')).toBe('ci-doctor')
  })

  it('leaves a bare name unchanged and lower-cases', () => {
    expect(normalizeSkillName('ci-doctor')).toBe('ci-doctor')
    expect(normalizeSkillName('CI-Doctor')).toBe('ci-doctor')
  })

  it('does NOT strip an unrelated vendor prefix', () => {
    // vercel- is not a known skill affix — only convention claude affixes strip.
    expect(normalizeSkillName('vercel-react-best-practices')).toBe('vercel-react-best-practices')
  })

  it('never reduces to empty (affix-only name kept)', () => {
    // Length-guarded: a same-length affix is not stripped; a shorter one may be,
    // but the result is never empty.
    expect(normalizeSkillName('-skill')).toBe('-skill')
    expect(normalizeSkillName('claude-skill-').length).toBeGreaterThan(0)
  })
})

describe('skillNameVariants', () => {
  it('expands a bare name to the affixed registry forms', () => {
    const v = skillNameVariants('ci-doctor')
    expect(v).toContain('ci-doctor')
    expect(v).toContain('claude-skill-ci-doctor')
    expect(v).toContain('ci-doctor-skill')
  })

  it('expands an affixed name back to its bare form', () => {
    const v = skillNameVariants('claude-skill-ci-doctor')
    expect(v).toContain('ci-doctor')
    expect(v).toContain('claude-skill-ci-doctor')
  })

  it('is deduplicated and non-empty', () => {
    const v = skillNameVariants('ci-doctor')
    expect(new Set(v).size).toBe(v.length)
    expect(v.every((s) => s.length > 0)).toBe(true)
  })
})
