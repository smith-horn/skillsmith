/**
 * Tests for security scan rendering in skill-panel-html.ts
 * Extracted from skill-panel-html.test.ts (SMI-4240) to keep that file under
 * the 500-line gate.
 *
 * Covers: scan pass/fail, tier-aware pending copy (SMI-4240), scan date.
 */
import { describe, it, expect } from 'vitest'
import { getSkillDetailHtml } from '../views/skill-panel-html.js'
import type { ExtendedSkillData } from '../types/skill.js'

function makeSkill(overrides: Partial<ExtendedSkillData> = {}): ExtendedSkillData {
  return {
    id: 'test-skill',
    name: 'Test Skill',
    description: 'A test skill description',
    author: 'tester',
    category: 'testing',
    trustTier: 'verified',
    score: 85,
    version: undefined,
    tags: undefined,
    installCommand: undefined,
    scoreBreakdown: undefined,
    ...overrides,
  }
}

const NONCE = 'test-nonce-123'
const CSP = "default-src 'none';"

describe('security scan rendering (SMI-3857/3858)', () => {
  it('shows PASS for securityPassed: true', () => {
    const html = getSkillDetailHtml(makeSkill({ securityPassed: true }), NONCE, CSP)
    expect(html).toContain('scan-pass')
    expect(html).toContain('PASS')
  })

  it('shows FAIL with risk score for securityPassed: false', () => {
    const html = getSkillDetailHtml(
      makeSkill({ securityPassed: false, securityRiskScore: 72 }),
      NONCE,
      CSP
    )
    expect(html).toContain('scan-fail')
    expect(html).toContain('FAIL (risk: 72/100)')
  })

  it('shows FAIL without risk when riskScore is null', () => {
    const html = getSkillDetailHtml(
      makeSkill({ securityPassed: false, securityRiskScore: null }),
      NONCE,
      CSP
    )
    expect(html).toContain('scan-fail')
    expect(html).toContain('>FAIL<')
  })

  it('shows "Pending review" for verified skills when securityPassed is null (SMI-4240)', () => {
    const html = getSkillDetailHtml(
      makeSkill({ securityPassed: null, trustTier: 'verified' }),
      NONCE,
      CSP
    )
    expect(html).toContain('scan-none')
    expect(html).toContain('Pending review')
    expect(html).not.toContain('Not scanned')
    expect(html).toContain('https://skillsmith.app/docs/security')
  })

  it('shows "Pending scan" for community skills when securityPassed is null (SMI-4240)', () => {
    const html = getSkillDetailHtml(
      makeSkill({ securityPassed: null, trustTier: 'community' }),
      NONCE,
      CSP
    )
    expect(html).toContain('Pending scan')
    expect(html).not.toContain('Not scanned')
  })

  it('shows "Pending scan" for experimental skills when securityPassed is null (SMI-4240)', () => {
    const html = getSkillDetailHtml(
      makeSkill({ securityPassed: null, trustTier: 'experimental' }),
      NONCE,
      CSP
    )
    expect(html).toContain('Pending scan')
  })

  it('shows tier-aware copy when securityPassed is undefined (pre-SMI-4240 MCP responses)', () => {
    // Version-skew safety: older published MCP servers don't populate
    // securityPassed at all. The extension must still render coherent copy.
    const html = getSkillDetailHtml(makeSkill(), NONCE, CSP)
    expect(html).toContain('Pending review') // makeSkill default trustTier is 'verified'
    expect(html).not.toContain('Not scanned')
  })

  it('includes scan date when provided', () => {
    const html = getSkillDetailHtml(
      makeSkill({ securityPassed: true, securityScannedAt: '2026-04-03T12:00:00Z' }),
      NONCE,
      CSP
    )
    expect(html).toContain('scan-date')
    expect(html).toContain('2026-04-03')
  })

  it('omits scan date span when not provided', () => {
    const html = getSkillDetailHtml(makeSkill({ securityPassed: true }), NONCE, CSP)
    expect(html).not.toContain('<span class="scan-date">')
  })
})
