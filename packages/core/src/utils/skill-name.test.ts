/**
 * SMI-6472: validateSkillName tests.
 *
 * Ported from packages/cli/tests/create.test.ts:38-71 — @skillsmith/core is
 * now the canonical source (packages/cli/src/utils/skill-name.ts re-exports
 * from here), so this is where the direct unit coverage lives.
 */
import { describe, it, expect } from 'vitest'
import { validateSkillName } from './skill-name.js'

describe('validateSkillName', () => {
  it('accepts valid lowercase-hyphen names', () => {
    expect(validateSkillName('my-skill')).toBe(true)
    expect(validateSkillName('skill')).toBe(true)
    expect(validateSkillName('a1b2-c3')).toBe(true)
  })

  it('rejects names with uppercase letters', () => {
    const result = validateSkillName('My-Skill')
    expect(result).not.toBe(true)
    expect(typeof result).toBe('string')
  })

  it('rejects names with spaces', () => {
    expect(validateSkillName('my skill')).not.toBe(true)
  })

  it('rejects names starting with a digit', () => {
    expect(validateSkillName('1skill')).not.toBe(true)
  })

  it('rejects empty string', () => {
    expect(validateSkillName('')).not.toBe(true)
  })

  it('rejects names with underscores', () => {
    expect(validateSkillName('my_skill')).not.toBe(true)
  })
})
