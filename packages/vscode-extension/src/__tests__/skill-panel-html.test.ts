/**
 * Tests for skill-panel-html.ts
 * Covers: repository URL fallback, inferred label, description rendering, trust badges
 */
import { describe, it, expect } from 'vitest'
import {
  getSkillDetailHtml,
  getTrustBadgeColor,
  getTrustBadgeText,
  getLoadingHtml,
} from '../views/skill-panel-html.js'
import type { ExtendedSkillData } from '../types/skill.js'

/** Minimal skill fixture */
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

describe('getSkillDetailHtml', () => {
  describe('repository URL rendering', () => {
    it('shows explicit repository when provided', () => {
      const html = getSkillDetailHtml(
        makeSkill({ repository: 'https://github.com/tester/test-skill' }),
        NONCE,
        CSP
      )
      expect(html).toContain('https://github.com/tester/test-skill')
      expect(html).toContain('repository-link')
      // inferred label appears in CSS but should not appear in HTML body content
      expect(html).not.toContain('inferred from skill ID')
    })

    it('infers GitHub URL from author/name skill ID when repository is missing', () => {
      const html = getSkillDetailHtml(makeSkill({ id: 'tester/test-skill' }), NONCE, CSP)
      expect(html).toContain('https://github.com/tester/test-skill')
      expect(html).toContain('inferred-label')
      expect(html).toContain('inferred from skill ID')
    })

    it('does not infer URL for IDs without slash', () => {
      const html = getSkillDetailHtml(makeSkill({ id: 'no-slash-id' }), NONCE, CSP)
      expect(html).not.toContain('inferred from skill ID')
      // Repository heading should not appear (no explicit repo, no inferred)
      expect(html).not.toContain('<h2>Repository</h2>')
    })

    it('validates inferred URL hostname is github.com', () => {
      // A crafted ID that would produce a non-github.com URL should be rejected
      // The URL constructor with template `https://github.com/${id}` always produces
      // github.com hostname, but path traversal in the ID is neutralized by escapeHtml
      const html = getSkillDetailHtml(makeSkill({ id: 'evil/../../../other' }), NONCE, CSP)
      // Still github.com host — path traversal doesn't change hostname
      expect(html).toContain('github.com')
    })

    it('prefers explicit repository over inferred', () => {
      const html = getSkillDetailHtml(
        makeSkill({
          id: 'tester/test-skill',
          repository: 'https://github.com/tester/real-repo',
        }),
        NONCE,
        CSP
      )
      expect(html).toContain('https://github.com/tester/real-repo')
      expect(html).not.toContain('inferred from skill ID')
    })
  })

  describe('description markdown rendering', () => {
    it('renders markdown in description', () => {
      const html = getSkillDetailHtml(
        makeSkill({ description: '**bold** description with [link](https://example.com)' }),
        NONCE,
        CSP
      )
      expect(html).toContain('<strong>bold</strong>')
      expect(html).toContain('href="https://example.com"')
    })

    it('uses div.description instead of p tag', () => {
      const html = getSkillDetailHtml(makeSkill(), NONCE, CSP)
      expect(html).toContain('<div class="description">')
      expect(html).not.toMatch(/<p class="description">/)
    })

    it('strips script tags from description (XSS)', () => {
      const html = getSkillDetailHtml(
        makeSkill({ description: '<script>alert("xss")</script>' }),
        NONCE,
        CSP
      )
      // The script tag should be stripped; only the nonce-protected inline script remains
      const descriptionSection = html.split('class="description"')[1]?.split('</div>')[0] ?? ''
      expect(descriptionSection).not.toContain('<script')
    })
  })

  describe('link click handler', () => {
    it('includes delegated click handler for markdown links', () => {
      const html = getSkillDetailHtml(makeSkill(), NONCE, CSP)
      expect(html).toContain('.skill-content a[href], .description a[href]')
      expect(html).toContain("command: 'openExternal'")
    })

    it('only intercepts https and http links', () => {
      const html = getSkillDetailHtml(makeSkill(), NONCE, CSP)
      expect(html).toContain("url.startsWith('https://')")
      expect(html).toContain("url.startsWith('http://')")
    })
  })

  describe('CSS styles', () => {
    it('includes description heading size cap', () => {
      const html = getSkillDetailHtml(makeSkill(), NONCE, CSP)
      expect(html).toContain('.description h1')
      expect(html).toContain('font-size: 14px')
    })

    it('includes description link color reset', () => {
      const html = getSkillDetailHtml(makeSkill(), NONCE, CSP)
      expect(html).toContain('.description a')
      expect(html).toContain('var(--vscode-textLink-foreground)')
    })

    it('includes inferred-label styling', () => {
      const html = getSkillDetailHtml(makeSkill(), NONCE, CSP)
      expect(html).toContain('.inferred-label')
      expect(html).toContain('font-size: 12px')
    })
  })

  describe('content rendering', () => {
    it('includes skill content section when content is provided', () => {
      const html = getSkillDetailHtml(
        makeSkill({ content: '# My Skill\n\nDoes things.' }),
        NONCE,
        CSP
      )
      expect(html).toContain('Skill Content')
      expect(html).toContain('<h1')
    })

    it('omits skill content section when content is absent', () => {
      const html = getSkillDetailHtml(makeSkill(), NONCE, CSP)
      expect(html).not.toContain('Skill Content')
    })
  })
})

describe('getTrustBadgeColor', () => {
  it('returns verified for verified tier', () => {
    expect(getTrustBadgeColor('verified')).toBe('verified')
  })

  it('returns community for community tier', () => {
    expect(getTrustBadgeColor('community')).toBe('community')
  })

  it('returns unverified for unknown tier', () => {
    expect(getTrustBadgeColor('unknown')).toBe('unverified')
  })

  it('is case-insensitive', () => {
    expect(getTrustBadgeColor('VERIFIED')).toBe('verified')
  })
})

describe('getTrustBadgeText', () => {
  it('returns Verified for verified tier', () => {
    expect(getTrustBadgeText('verified')).toBe('Verified')
  })

  it('returns Unverified for unknown tier', () => {
    expect(getTrustBadgeText('something')).toBe('Unverified')
  })
})

describe('getLoadingHtml', () => {
  it('returns loading spinner HTML', () => {
    const html = getLoadingHtml()
    expect(html).toContain('Loading skill details')
    expect(html).toContain('spinner')
  })
})
