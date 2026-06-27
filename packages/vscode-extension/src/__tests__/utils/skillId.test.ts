/**
 * Unit tests for src/utils/skillId.ts — isLocalSkillId (SMI-5401).
 *
 * Mirrors the server's `parseSkillIdInternal` complement logic:
 *   - bare, non-UUID, no-slash id → local (true)
 *   - owner/repo, GitHub URL, or UUID → registry (false)
 */
import { describe, it, expect } from 'vitest'
import { isLocalSkillId, skillComparisonKey, buildInstalledKeySet } from '../../utils/skillId.js'

describe('isLocalSkillId', () => {
  // ── true: bare slug → local on-disk read ───────────────────────────────────

  it('returns true for a bare slug (ci-doctor)', () => {
    expect(isLocalSkillId('ci-doctor')).toBe(true)
  })

  it('returns true for a bare slug (skill-builder)', () => {
    expect(isLocalSkillId('skill-builder')).toBe(true)
  })

  it('returns true for a plain single-segment name with no special chars', () => {
    expect(isLocalSkillId('governance')).toBe(true)
  })

  // ── false: owner/repo → registry ──────────────────────────────────────────

  it('returns false for an owner/repo qualified id', () => {
    expect(isLocalSkillId('smith-horn/governance')).toBe(false)
  })

  it('returns false for a path with nested segments', () => {
    expect(isLocalSkillId('smith-horn/governance/extra')).toBe(false)
  })

  // ── false: GitHub URL → registry ──────────────────────────────────────────

  it('returns false for a full GitHub URL', () => {
    expect(isLocalSkillId('https://github.com/smith-horn/governance')).toBe(false)
  })

  it('returns false for a GitHub URL with deep path', () => {
    expect(isLocalSkillId('https://github.com/o/r/blob/main/SKILL.md')).toBe(false)
  })

  // ── false: UUID → registry (L1 case — "surprising but correct") ───────────
  //
  // A UUID-named on-disk directory routes to `get_skill`, not disk. The server
  // accepts UUID ids, and a UUID directory slug is not a real-world installed-
  // skill name. Mirrors the server comment in `parseSkillIdInternal`.
  it('returns false for a UUID-shaped id (surprising but correct: UUID routes to get_skill, not disk)', () => {
    expect(isLocalSkillId('550e8400-e29b-41d4-a716-446655440000')).toBe(false)
  })

  it('returns false for another UUID variant (uppercase hex)', () => {
    expect(isLocalSkillId('A1B2C3D4-E5F6-7890-ABCD-EF1234567890')).toBe(false)
  })
})

// ── Pre-existing helpers (smoke coverage) ─────────────────────────────────────

describe('skillComparisonKey', () => {
  it('strips the owner prefix and lowercases', () => {
    expect(skillComparisonKey('Smith-Horn/My-Skill')).toBe('my-skill')
  })

  it('lowercases a bare slug', () => {
    expect(skillComparisonKey('My-Skill')).toBe('my-skill')
  })
})

describe('buildInstalledKeySet', () => {
  it('builds a Set of lowercased trailing segments', () => {
    const set = buildInstalledKeySet(['ci-doctor', 'smith-horn/governance'])
    expect(set.has('ci-doctor')).toBe(true)
    expect(set.has('governance')).toBe(true)
    expect(set.has('smith-horn/governance')).toBe(false)
  })
})
