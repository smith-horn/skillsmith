/**
 * Unit tests for `classifyIsErrorText` (SMI-5322).
 *
 * Pins the precedence that lets a skill-level not-found map to `SkillNotFound`
 * while the generic tool-not-found contract (`tool not found -> UnknownTool`,
 * uninstall_skill.test.ts) stays intact.
 */
import { describe, it, expect } from 'vitest'

import { classifyIsErrorText } from '../../mcp/callTool.js'

describe('classifyIsErrorText (SMI-5322)', () => {
  it('tier/plan/denied/forbidden/upgrade text -> TierDenied', () => {
    expect(classifyIsErrorText('TierDenied: requires the Individual plan')).toBe('TierDenied')
    expect(classifyIsErrorText('This feature is not available in your current tier')).toBe(
      'TierDenied'
    )
    expect(classifyIsErrorText('Please upgrade to continue')).toBe('TierDenied')
  })

  it('server SKILL_NOT_FOUND message -> SkillNotFound', () => {
    expect(classifyIsErrorText('Error: Skill "smith-horn/docker" not found')).toBe('SkillNotFound')
    // Case-insensitive + extra text between "skill" and "not found".
    expect(classifyIsErrorText('skill foo/bar was not found in the registry')).toBe('SkillNotFound')
  })

  it('server SKILL_INVALID_ID message -> SkillNotFound', () => {
    expect(classifyIsErrorText('Error: Invalid skill ID format: "@@@"')).toBe('SkillNotFound')
  })

  it('skill name containing a tier keyword still classifies SkillNotFound, not TierDenied', () => {
    // The SkillNotFound rule runs before TierDenied so a skill named e.g.
    // "plan-review" / "tier-manager" / "upgrade-kit" does not misroute to the
    // upgrade upsell.
    expect(classifyIsErrorText('Error: Skill "smith-horn/plan-review" not found')).toBe(
      'SkillNotFound'
    )
    expect(classifyIsErrorText('Error: Skill "tier-manager" not found')).toBe('SkillNotFound')
    expect(classifyIsErrorText('Error: Skill "upgrade-kit" not found')).toBe('SkillNotFound')
  })

  it('generic tool-not-found stays UnknownTool (preserves the tested contract)', () => {
    expect(classifyIsErrorText('tool not found')).toBe('UnknownTool')
    expect(classifyIsErrorText('Unknown tool: skill_compare')).toBe('UnknownTool')
    expect(classifyIsErrorText('no such tool')).toBe('UnknownTool')
  })

  it('unrelated errors fall through to Unknown', () => {
    expect(classifyIsErrorText('network timeout')).toBe('Unknown')
    expect(classifyIsErrorText('Unknown error')).toBe('Unknown')
  })
})
