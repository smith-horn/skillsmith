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
  getErrorHtml,
  mapErrorToUserMessage,
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
      expect(html).toContain('No repository URL available')
    })

    it('rejects path traversal IDs (multiple segments)', () => {
      const html = getSkillDetailHtml(makeSkill({ id: 'evil/../../../other' }), NONCE, CSP)
      expect(html).not.toContain('inferred from skill ID')
      expect(html).toContain('No repository URL available')
    })

    it('does not infer URL for claude-plugins/UUID IDs', () => {
      const html = getSkillDetailHtml(
        makeSkill({ id: 'claude-plugins/a7584183-4df5-435e-bb24-ce219c3fab0a' }),
        NONCE,
        CSP
      )
      expect(html).not.toContain('inferred from skill ID')
      expect(html).toContain('No repository URL available')
    })

    it('does not infer URL for IDs with 3+ segments', () => {
      const html = getSkillDetailHtml(makeSkill({ id: 'source/sub/path' }), NONCE, CSP)
      expect(html).not.toContain('inferred from skill ID')
      expect(html).toContain('No repository URL available')
    })

    it('infers URL for repo names with dots', () => {
      const html = getSkillDetailHtml(makeSkill({ id: 'octocat/hello.world' }), NONCE, CSP)
      expect(html).toContain('https://github.com/octocat/hello.world')
      expect(html).toContain('inferred from skill ID')
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

    it('shows View Repository button for explicit repository', () => {
      const html = getSkillDetailHtml(
        makeSkill({ repository: 'https://github.com/tester/test-skill' }),
        NONCE,
        CSP
      )
      expect(html).toContain('View Repository')
    })

    it('suppresses View Repository button for inferred repository', () => {
      const html = getSkillDetailHtml(makeSkill({ id: 'tester/test-skill' }), NONCE, CSP)
      expect(html).toContain('inferred from skill ID')
      expect(html).not.toContain('View Repository')
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

  describe('a11y: repository links', () => {
    it('includes tabindex and role on repository-link spans', () => {
      const html = getSkillDetailHtml(
        makeSkill({ repository: 'https://github.com/tester/test-skill' }),
        NONCE,
        CSP
      )
      expect(html).toContain('tabindex="0"')
      expect(html).toContain('role="link"')
    })

    it('includes keyboard handler for Enter/Space on repository links', () => {
      const html = getSkillDetailHtml(makeSkill(), NONCE, CSP)
      expect(html).toContain("e.key === 'Enter'")
      expect(html).toContain("e.key === ' '")
    })

    it('includes focus style for repository links', () => {
      const html = getSkillDetailHtml(makeSkill(), NONCE, CSP)
      expect(html).toContain('.repository-link:focus')
      expect(html).toContain('var(--vscode-focusBorder)')
    })
  })

  describe('no-repo placeholder', () => {
    it('shows placeholder when no repository and no inference', () => {
      const html = getSkillDetailHtml(makeSkill({ id: 'no-slash' }), NONCE, CSP)
      expect(html).toContain('No repository URL available')
      expect(html).toContain('<h2>Repository</h2>')
    })

    it('does not show placeholder when explicit repository exists', () => {
      const html = getSkillDetailHtml(
        makeSkill({ repository: 'https://github.com/tester/repo' }),
        NONCE,
        CSP
      )
      expect(html).not.toContain('No repository URL available')
    })
  })

  describe('badge contrast', () => {
    it('uses WCAG AA compliant color for community badge', () => {
      const html = getSkillDetailHtml(makeSkill(), NONCE, CSP)
      // #b8960a with white text meets WCAG AA 4.5:1 contrast ratio
      expect(html).toContain('#b8960a')
      expect(html).not.toContain('#ffc107')
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

  it('returns experimental for experimental tier', () => {
    expect(getTrustBadgeColor('experimental')).toBe('experimental')
  })

  it('returns local for local tier', () => {
    expect(getTrustBadgeColor('local')).toBe('local')
  })

  it('returns unknown for unrecognized tier', () => {
    expect(getTrustBadgeColor('something')).toBe('unknown')
  })

  it('is case-insensitive', () => {
    expect(getTrustBadgeColor('VERIFIED')).toBe('verified')
  })
})

describe('getTrustBadgeText', () => {
  it('returns Verified for verified tier', () => {
    expect(getTrustBadgeText('verified')).toBe('Verified')
  })

  it('returns Experimental for experimental tier', () => {
    expect(getTrustBadgeText('experimental')).toBe('Experimental')
  })

  it('returns Local for local tier', () => {
    expect(getTrustBadgeText('local')).toBe('Local')
  })

  it('returns Unknown for unrecognized tier', () => {
    expect(getTrustBadgeText('something')).toBe('Unknown')
  })
})

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

  it('shows Not scanned for securityPassed: null', () => {
    const html = getSkillDetailHtml(makeSkill({ securityPassed: null }), NONCE, CSP)
    expect(html).toContain('scan-none')
    expect(html).toContain('Not scanned')
  })

  it('shows Not scanned when securityPassed is undefined', () => {
    const html = getSkillDetailHtml(makeSkill(), NONCE, CSP)
    expect(html).toContain('Not scanned')
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

describe('getLoadingHtml', () => {
  it('returns loading spinner HTML with CSP', () => {
    const html = getLoadingHtml(NONCE, CSP)
    expect(html).toContain('Loading skill details')
    expect(html).toContain('spinner')
    expect(html).toContain('Content-Security-Policy')
    expect(html).toContain(`nonce="${NONCE}"`)
  })
})

describe('mapErrorToUserMessage', () => {
  it('maps ECONNREFUSED to friendly message', () => {
    expect(mapErrorToUserMessage('connect ECONNREFUSED 127.0.0.1:3000')).toBe(
      'Could not connect to the skill server. Check that the MCP server is running.'
    )
  })

  it('maps ENOTFOUND to friendly message', () => {
    expect(mapErrorToUserMessage('getaddrinfo ENOTFOUND example.com')).toBe(
      'Could not connect to the skill server. Check that the MCP server is running.'
    )
  })

  it('maps ETIMEDOUT to friendly message', () => {
    expect(mapErrorToUserMessage('connect ETIMEDOUT')).toBe(
      'Could not connect to the skill server. Check that the MCP server is running.'
    )
  })

  it('maps JSON parse errors to friendly message', () => {
    expect(mapErrorToUserMessage('Unexpected token < in JSON at position 0')).toBe(
      'Received an unexpected response from the server.'
    )
  })

  it('maps "Failed to parse" errors to friendly message', () => {
    expect(mapErrorToUserMessage('Failed to parse MCP response as JSON: bad input')).toBe(
      'Received an unexpected response from the server.'
    )
  })

  it('maps "not connected" to friendly message', () => {
    expect(mapErrorToUserMessage('MCP client not connected')).toBe(
      'MCP client is not connected. Try reconnecting.'
    )
  })

  it('passes through unknown errors unchanged', () => {
    expect(mapErrorToUserMessage('Something unexpected happened')).toBe(
      'Something unexpected happened'
    )
  })
})

describe('getErrorHtml', () => {
  const ERROR_NONCE = 'abcdefghijklmnop12345678'

  it('escapes HTML in message', () => {
    const html = getErrorHtml('<script>alert("xss")</script>', 'test/skill', ERROR_NONCE)
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>alert')
  })

  it('includes CSP nonce in script tag', () => {
    const html = getErrorHtml('error', 'test/skill', ERROR_NONCE)
    expect(html).toContain(`nonce="${ERROR_NONCE}"`)
    expect(html).toContain('<script nonce=')
  })

  it('includes aria-live="polite" for screen readers', () => {
    const html = getErrorHtml('error', 'test/skill', ERROR_NONCE)
    expect(html).toContain('aria-live="polite"')
  })

  it('includes role="alert" on the error message', () => {
    const html = getErrorHtml('error', 'test/skill', ERROR_NONCE)
    expect(html).toContain('role="alert"')
  })

  it('includes retry button with correct styling', () => {
    const html = getErrorHtml('error', 'test/skill', ERROR_NONCE)
    expect(html).toContain('id="retryBtn"')
    expect(html).toContain('var(--vscode-button-background)')
    expect(html).toContain('var(--vscode-button-foreground)')
  })

  it('includes details block when rawError differs from message', () => {
    const html = getErrorHtml('Friendly message', 'test/skill', ERROR_NONCE, 'ECONNREFUSED')
    expect(html).toContain('<details')
    expect(html).toContain('Technical details')
    expect(html).toContain('ECONNREFUSED')
  })

  it('omits details block when rawError matches message', () => {
    const html = getErrorHtml('same error', 'test/skill', ERROR_NONCE, 'same error')
    expect(html).not.toContain('<details')
  })

  it('omits details block when rawError is undefined', () => {
    const html = getErrorHtml('some error', 'test/skill', ERROR_NONCE)
    expect(html).not.toContain('<details')
  })

  it('escapes HTML in rawError details', () => {
    const html = getErrorHtml('error', 'test/skill', ERROR_NONCE, '<img src=x onerror=alert(1)>')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('sends retry command on button click', () => {
    const html = getErrorHtml('error', 'test/skill', ERROR_NONCE)
    expect(html).toContain("command: 'retry'")
    expect(html).toContain('vscode.postMessage')
  })

  it('includes Content-Security-Policy meta tag', () => {
    const html = getErrorHtml('error', 'test/skill', ERROR_NONCE)
    expect(html).toContain('Content-Security-Policy')
    expect(html).toContain("default-src 'none'")
  })
})
