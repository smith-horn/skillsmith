/**
 * Tests for getAdvisoriesHtml in skill-panel-html.ts (SMI-5317).
 * Split into its own file to keep skill-panel-html.test.ts under the 500-line
 * gate — same precedent as skill-panel-security.test.ts (SMI-4240).
 *
 * Covers: advisory section render + escaping (L1), severity whitelist (L1),
 * fix marker, aria-live (L2), tier-denied upsell line, and the empty case.
 */
import { describe, it, expect } from 'vitest'
import { getAdvisoriesHtml, getSkillDetailHtml } from '../views/skill-panel-html.js'
import type { McpAdvisory } from '../mcp/types.js'
import type { ExtendedSkillData } from '../types/skill.js'

const NONCE = 'test-nonce-123'
const CSP = "default-src 'none';"

const adv = (o: Partial<McpAdvisory> = {}): McpAdvisory => ({
  skillName: 'tester/test-skill',
  severity: 'high',
  title: 'Prompt injection in tool description',
  id: 'SKADV-2026-001',
  fixAvailable: true,
  ...o,
})

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

describe('getAdvisoriesHtml (SMI-5317)', () => {
  it('renders the section with an escaped title, severity badge, and aria-live', () => {
    const html = getAdvisoriesHtml([adv()], false)
    expect(html).toContain('Security Advisories')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('badge-sev-high')
    expect(html).toContain('HIGH')
    expect(html).toContain('Prompt injection in tool description')
    expect(html).toContain('fix available')
  })

  it('escapes script tags and quotes in the title (L1)', () => {
    const html = getAdvisoriesHtml([adv({ title: '<script>alert("xss")</script>' })], false)
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>alert')
  })

  it('maps an out-of-whitelist severity to the low badge class (L1)', () => {
    const html = getAdvisoriesHtml(
      [adv({ severity: 'evil' as unknown as McpAdvisory['severity'] })],
      false
    )
    expect(html).toContain('badge-sev-low')
    expect(html).not.toContain('badge-sev-evil')
  })

  it('omits the fix marker when fixAvailable is false', () => {
    expect(getAdvisoriesHtml([adv({ fixAvailable: false })], false)).not.toContain('fix available')
  })

  it('renders the quiet upsell line (no link) when tierDenied and no advisories', () => {
    const html = getAdvisoriesHtml(null, true)
    expect(html).toContain('advisory-upsell')
    expect(html).toContain('Security advisories are available on the Team plan.')
    expect(html).not.toContain('<a ')
  })

  it('returns empty string when neither advisories nor tierDenied', () => {
    expect(getAdvisoriesHtml(null, false)).toBe('')
    expect(getAdvisoriesHtml([], false)).toBe('')
  })

  it('integrates into the full panel via getSkillDetailHtml', () => {
    const html = getSkillDetailHtml(
      makeSkill(),
      NONCE,
      CSP,
      false,
      { installed: false },
      {
        advisories: [adv()],
        tierDenied: false,
      }
    )
    expect(html).toContain('Security Advisories')
  })
})
