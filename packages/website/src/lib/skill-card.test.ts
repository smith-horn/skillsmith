/**
 * Inline snapshot gate + assertion set for renderSkillCard (SMI-5366).
 *
 * Snapshot:    regenerate with `npx vitest run -u src/lib/skill-card.test.ts`
 *              (or the Docker equivalent below). Review the diff before committing.
 * Parity companion: skill-card.parity.test.ts pins COMPAT_LABELS vs the core contract.
 *
 * Docker:
 *   docker exec smi-5365-skills-index-bundled-migration-dev-1 \
 *     sh -c 'cd packages/website && npx vitest run -u src/lib/skill-card.test.ts'
 */

import { describe, it, expect } from 'vitest'
import type { WireSkill } from '../types/skills'
import { renderSkillCard } from './skill-card'
import { formatNumber, getQualityTier } from './skills-utils'
import { TRUST_TIER_BADGE_CLASSES, DEFAULT_TRUST_TIER } from '../constants/trust-tier-badges'

/**
 * Representative fully-populated skill for the inline snapshot and many assertion
 * blocks below.  compatibility has 5 entries (> MAX_VISIBLE=4) so the "+N more"
 * expand path is exercised in the snapshot and several assertion tests.
 */
const FULL_SKILL: WireSkill = {
  id: 'acme/test-runner',
  name: 'Test Runner',
  author: 'acme',
  description: 'Runs your tests automatically',
  trust_tier: 'verified',
  stars: 1234,
  categories: ['testing'],
  version: '1.2.0',
  repo_url: 'https://github.com/x/y',
  compatibility: ['claude-code', 'cursor', 'copilot', 'windsurf', 'codex'],
  license: 'MIT',
  _orgMatch: 'acme',
}
const FULL_HREF = '/skills/acme%2Ftest-runner'

describe('renderSkillCard', () => {
  // ─── inline snapshot ──────────────────────────────────────────────────────────
  // Anti-drift gate: any structural change to the renderer's markup breaks this.
  // Regenerate by running vitest with the -u flag (see file header).
  // Review the generated diff before committing — reject garbage output.
  it('renders a fully-populated skill card (inline snapshot)', () => {
    // SMI-5371: normalize the compat-extra-N id so this snapshot is independent
    // of the module-scope compatBadgeSeq counter (no test-ordering fragility).
    // The real id wiring (aria-controls === hidden-span id, monotonic increment)
    // is covered by the aria-controls + monotonic-id tests further down.
    const html = renderSkillCard({ skill: FULL_SKILL, href: FULL_HREF }).replace(
      /compat-extra-\d+/g,
      'compat-extra-N'
    )
    expect(html).toMatchInlineSnapshot(`
      "
              <a href="/skills/acme%2Ftest-runner" class="card-hover block bg-dark-900 rounded-xl border border-dark-800 p-6 hover:border-primary-500/50">
                <div class="flex items-start justify-between mb-4">
                  <div class="flex-1 min-w-0">
                    <h3 class="text-lg font-semibold text-white truncate">Test Runner</h3>
                    <p class="text-dark-500 text-sm">acme</p>
                    <span class="inline-flex items-center gap-1 px-2 py-0.5 mt-2 rounded-full text-xs font-medium bg-primary-500/10 text-primary-300 border border-primary-500/30" aria-label="Matches your org: acme">
          <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2a6 6 0 100 12 6 6 0 000-12zm0 2a4 4 0 110 8 4 4 0 010-8z"/></svg>
          Matches your org: acme
        </span>
                  </div>
                  <span class="ml-4 px-2.5 py-1 text-xs font-medium rounded-full border bg-blue-500/10 text-blue-400 border-blue-500/20">
                    verified
                  </span>
                </div>
                <p class="text-dark-400 text-sm mb-4 line-clamp-2">Runs your tests automatically</p>
                <div class="flex items-center justify-between text-sm">
                  <div class="flex items-center space-x-4">
                    
                      <span class="text-dark-500">
                        <svg class="w-4 h-4 inline-block mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                        </svg>
                        testing
                      </span>
                    
                    <span class="text-dark-500">v1.2.0</span>
                  </div>
                  <span class="text-green-400 text-lg" role="img" aria-label="High Quality: 1,234 stars" title="High Quality: 1,234 stars">●<span class="sr-only">High Quality: 1,234 stars</span></span>
                </div>
                <div class="mt-3 pt-3 border-t border-dark-800">
                    <span class="inline-flex items-center gap-1 text-xs text-dark-500">
                      <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.167 22 16.418 22 12c0-5.523-4.477-10-10-10z"/>
                      </svg>
                      View source
                    </span>
                  </div>
                <div class="mt-3 pt-3 border-t border-dark-800 flex flex-wrap gap-1 items-center">
          <span class="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-primary-500/10 text-primary-400 border border-primary-500/20">Claude Code</span><span class="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-primary-500/10 text-primary-400 border border-primary-500/20">Cursor</span><span class="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-primary-500/10 text-primary-400 border border-primary-500/20">GitHub Copilot</span><span class="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-primary-500/10 text-primary-400 border border-primary-500/20">Windsurf</span>
          <span id="compat-extra-N" style="display:none"><span class="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-primary-500/10 text-primary-400 border border-primary-500/20">Codex</span></span>
          <button
            type="button"
            class="px-1.5 py-0.5 rounded text-xs text-dark-400 hover:text-primary-400 transition-colors focus:outline-none focus:ring-1 focus:ring-primary-500"
            aria-label="Show 1 more compatibility tag"
            aria-expanded="false"
            aria-controls="compat-extra-N"
            onclick="event.preventDefault(); event.stopPropagation(); document.getElementById('compat-extra-N').style.display='contents'; this.setAttribute('aria-expanded','true'); this.style.display='none';"
          >+1 more</button>
        </div>
                <div class="mt-2">
          <span class="inline-flex items-center gap-1 text-xs text-dark-500" aria-label="License: MIT">
            <svg class="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            <span>License: <span class="font-medium">MIT</span></span>
          </span>
        </div>
              </a>
            "
    `)
  })

  // ─── trust badge ──────────────────────────────────────────────────────────────
  describe('trust badge', () => {
    it('verified tier renders the verified badge class and "verified" text', () => {
      const html = renderSkillCard({ skill: FULL_SKILL, href: FULL_HREF })
      expect(html).toContain(TRUST_TIER_BADGE_CLASSES.verified)
      expect(html).toMatch(/rounded-full border [^>]+>\s*verified\s*<\/span>/)
    })

    it('absent trust_tier falls back to DEFAULT_TRUST_TIER class and "unverified" text', () => {
      // Minimal WireSkill with no trust_tier property — exactOptionalPropertyTypes
      // requires omission rather than setting to undefined.
      const html = renderSkillCard({
        skill: { id: 'test', name: 'No Tier Skill' },
        href: '/skills/test',
      })
      expect(html).toContain(TRUST_TIER_BADGE_CLASSES[DEFAULT_TRUST_TIER])
      expect(html).toMatch(/rounded-full border [^>]+>\s*unverified\s*<\/span>/)
    })

    it('runtime-unknown trust_tier falls back to default class, shows raw slug, no "undefined" in any class attr', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberate any-cast: simulates a runtime-unknown trust tier value that cannot exist in the type system
      const skill: WireSkill = { id: 'test', name: 'Test', trust_tier: 'ultra-mega-tier' as any }
      const html = renderSkillCard({ skill, href: '/skills/test' })
      expect(html).toContain(TRUST_TIER_BADGE_CLASSES[DEFAULT_TRUST_TIER])
      expect(html).toContain('ultra-mega-tier')
      expect(html).not.toMatch(/class="[^"]*undefined[^"]*"/)
    })
  })

  // ─── quality dot ──────────────────────────────────────────────────────────────
  describe('quality dot', () => {
    // Compute expected values the same way the renderer does — locale-independent.
    const tier = getQualityTier(1234)
    const expectedLabel = `${tier.label}: ${formatNumber(1234)} stars`

    it('has role="img"', () => {
      const html = renderSkillCard({ skill: FULL_SKILL, href: FULL_HREF })
      expect(html).toContain('role="img"')
    })

    it('has aria-label with locale-grouped star count (regex tolerant of separator)', () => {
      const html = renderSkillCard({ skill: FULL_SKILL, href: FULL_HREF })
      // Tolerates comma, period, narrow-no-break-space (U+202F), or thin-space
      // separators across different Node.js locale/ICU configurations.
      expect(html).toMatch(/aria-label="High Quality: 1[,.\s]?234 stars"/)
    })

    it('has sr-only span with same text as aria-label, and title= equal to aria-label', () => {
      const html = renderSkillCard({ skill: FULL_SKILL, href: FULL_HREF })
      expect(html).toContain(`aria-label="${expectedLabel}"`)
      expect(html).toContain(`title="${expectedLabel}"`)
      expect(html).toContain(`<span class="sr-only">${expectedLabel}</span>`)
    })

    it('has tier.color class text-green-400 for 1234 stars (High Quality tier)', () => {
      const html = renderSkillCard({ skill: FULL_SKILL, href: FULL_HREF })
      expect(tier.color).toBe('text-green-400')
      expect(html).toContain(tier.color)
    })
  })

  // ─── org badge ────────────────────────────────────────────────────────────────
  describe('org badge', () => {
    it('contributes empty string when _orgMatch is absent', () => {
      const html = renderSkillCard({
        skill: { id: 'test', name: 'Test' },
        href: '/skills/test',
      })
      expect(html).not.toContain('Matches your org')
    })

    it('renders aria-label, visible text, and badge classes when _orgMatch is set', () => {
      const html = renderSkillCard({ skill: FULL_SKILL, href: FULL_HREF })
      expect(html).toContain('aria-label="Matches your org: acme"')
      expect(html).toContain('Matches your org: acme')
      expect(html).toContain('bg-primary-500/10 text-primary-300')
    })
  })

  // ─── compatibility ────────────────────────────────────────────────────────────
  describe('compatibility', () => {
    it('known slugs render display labels not raw slugs', () => {
      const html = renderSkillCard({ skill: FULL_SKILL, href: FULL_HREF })
      expect(html).toContain('Claude Code')
      expect(html).toContain('GitHub Copilot')
      expect(html).not.toMatch(/>claude-code</)
      expect(html).not.toMatch(/>copilot</)
    })

    it('unknown slug renders its raw escaped value', () => {
      const skill: WireSkill = {
        id: 'test',
        name: 'Test',
        compatibility: ['claude-code', 'cursor', 'copilot', 'windsurf', 'neovim'],
      }
      const html = renderSkillCard({ skill, href: '/skills/test' })
      expect(html).toContain('>neovim<')
    })

    it('with >4 items, +N more button aria-controls matches the hidden span id', () => {
      const html = renderSkillCard({ skill: FULL_SKILL, href: FULL_HREF })
      const ariaControlsMatch = html.match(/aria-controls="(compat-extra-\d+)"/)
      expect(ariaControlsMatch).not.toBeNull()
      const extraId = ariaControlsMatch?.[1] ?? ''
      expect(extraId).toMatch(/^compat-extra-\d+$/)
      expect(html).toContain(`id="${extraId}"`)
    })

    it('with exactly one hidden item, +N more uses aria-expanded="false" and a singular aria-label', () => {
      // FULL_SKILL has 5 compat tags -> 1 hidden -> singular "tag" (SMI-5371).
      const html = renderSkillCard({ skill: FULL_SKILL, href: FULL_HREF })
      expect(html).toContain('aria-expanded="false"')
      expect(html).toContain('aria-label="Show 1 more compatibility tag"')
      expect(html).not.toContain('Show 1 more compatibility tags')
    })

    it('pluralizes the +N more aria-label when more than one item is hidden (SMI-5371)', () => {
      const skill: WireSkill = {
        ...FULL_SKILL,
        compatibility: ['claude-code', 'cursor', 'copilot', 'windsurf', 'codex', 'gemini'],
      }
      const html = renderSkillCard({ skill, href: FULL_HREF })
      // 6 tags -> 2 hidden -> plural "tags".
      expect(html).toContain('aria-label="Show 2 more compatibility tags"')
    })

    it('onclick contains event.preventDefault() and event.stopPropagation() (SMI-3529 nested-button-in-anchor guard)', () => {
      const html = renderSkillCard({ skill: FULL_SKILL, href: FULL_HREF })
      expect(html).toContain('event.preventDefault()')
      expect(html).toContain('event.stopPropagation()')
    })

    it('max 4 badges are visible before the hidden extra span', () => {
      const skill: WireSkill = {
        id: 'test',
        name: 'Test',
        compatibility: ['claude-code', 'cursor', 'copilot', 'windsurf', 'codex'],
      }
      const html = renderSkillCard({ skill, href: '/skills/test' })
      const hiddenIdx = html.indexOf('style="display:none"')
      expect(hiddenIdx).toBeGreaterThan(0)
      // Everything before the hidden span — only the 4 visible badge spans land here.
      // The +N more button (also has px-1.5 py-0.5 classes) comes after the hidden span.
      const visibleSection = html.slice(0, hiddenIdx)
      const visibleBadgeMatches = visibleSection.match(/px-1\.5 py-0\.5 rounded text-xs/g)
      expect(visibleBadgeMatches).toHaveLength(4)
    })

    it('empty compatibility array renders no compat badge row', () => {
      const html = renderSkillCard({
        skill: { id: 'test', name: 'Test', compatibility: [] },
        href: '/skills/test',
      })
      expect(html).not.toContain('text-primary-400 border border-primary-500/20')
    })

    it('absent compatibility renders no compat badge row', () => {
      const html = renderSkillCard({
        skill: { id: 'test', name: 'Test' },
        href: '/skills/test',
      })
      expect(html).not.toContain('text-primary-400 border border-primary-500/20')
    })

    it('two successive calls with >4 compat tags emit distinct monotonically-increasing compat-extra-N ids', () => {
      const skill: WireSkill = {
        id: 'test',
        name: 'Test',
        compatibility: ['claude-code', 'cursor', 'copilot', 'windsurf', 'codex'],
      }
      const html1 = renderSkillCard({ skill, href: '/skills/test' })
      const html2 = renderSkillCard({ skill, href: '/skills/test' })

      const m1 = html1.match(/id="compat-extra-(\d+)"/)
      const m2 = html2.match(/id="compat-extra-(\d+)"/)
      expect(m1).not.toBeNull()
      expect(m2).not.toBeNull()

      // Use optional-chain + fallback so TypeScript doesn't require non-null assertion.
      // If m1 / m2 are null the above expect() already fails the test.
      const n1 = parseInt(m1?.[1] ?? '0', 10)
      const n2 = parseInt(m2?.[1] ?? '0', 10)
      expect(n1).toBeGreaterThan(0) // sanity: both resolved to valid ids
      expect(n2).toBeGreaterThan(n1) // monotonically increasing, never resetting
    })
  })

  // ─── license ──────────────────────────────────────────────────────────────────
  describe('license', () => {
    it('MIT renders as aria-label="License: MIT" and visible License: MIT', () => {
      const html = renderSkillCard({ skill: FULL_SKILL, href: FULL_HREF })
      expect(html).toContain('aria-label="License: MIT"')
      expect(html).toContain('License: <span class="font-medium">MIT</span>')
    })

    it('null license renders as License: Unknown', () => {
      const html = renderSkillCard({
        skill: { id: 'test', name: 'Test', license: null },
        href: '/skills/test',
      })
      expect(html).toContain('aria-label="License: Unknown"')
      expect(html).toContain('License: <span class="font-medium">Unknown</span>')
    })

    it('absent license renders as License: Unknown', () => {
      const html = renderSkillCard({
        skill: { id: 'test', name: 'Test' },
        href: '/skills/test',
      })
      expect(html).toContain('aria-label="License: Unknown"')
    })

    it('whitespace-only license renders as License: Unknown', () => {
      const html = renderSkillCard({
        skill: { id: 'test', name: 'Test', license: '   ' },
        href: '/skills/test',
      })
      expect(html).toContain('aria-label="License: Unknown"')
    })

    it('output never contains "freely usable" or "no restrictions" (SMI-5327)', () => {
      const htmlNull = renderSkillCard({
        skill: { id: 'test', name: 'Test', license: null },
        href: '/skills/test',
      })
      const htmlAbsent = renderSkillCard({
        skill: { id: 'test', name: 'Test' },
        href: '/skills/test',
      })
      for (const html of [htmlNull, htmlAbsent]) {
        expect(html).not.toContain('freely usable')
        expect(html).not.toContain('no restrictions')
      }
    })
  })

  // ─── repo_url ─────────────────────────────────────────────────────────────────
  describe('repo_url', () => {
    it('View source row appears for https:// URL', () => {
      const html = renderSkillCard({ skill: FULL_SKILL, href: FULL_HREF })
      expect(html).toContain('View source')
    })

    it('View source row absent for http:// URL', () => {
      const skill: WireSkill = { ...FULL_SKILL, repo_url: 'http://github.com/x/y' }
      const html = renderSkillCard({ skill, href: FULL_HREF })
      expect(html).not.toContain('View source')
    })

    it('View source row absent for git@ URL', () => {
      const skill: WireSkill = { ...FULL_SKILL, repo_url: 'git@github.com:x/y.git' }
      const html = renderSkillCard({ skill, href: FULL_HREF })
      expect(html).not.toContain('View source')
    })

    it('View source row absent when repo_url is not provided', () => {
      const html = renderSkillCard({
        skill: { id: 'test', name: 'Test' },
        href: '/skills/test',
      })
      expect(html).not.toContain('View source')
    })
  })

  // ─── conditionals ─────────────────────────────────────────────────────────────
  describe('conditionals', () => {
    it('categories[0] is rendered when present', () => {
      const html = renderSkillCard({ skill: FULL_SKILL, href: FULL_HREF })
      expect(html).toContain('testing')
    })

    it('categories[0] is absent when categories array is empty', () => {
      const skill: WireSkill = { ...FULL_SKILL, categories: [] }
      const html = renderSkillCard({ skill, href: FULL_HREF })
      // The category icon SVG path only appears when categories[0] is truthy
      expect(html).not.toContain('M7 7h.01M7 3h5c')
    })

    it('version renders as vN.N.N when version is present', () => {
      const html = renderSkillCard({ skill: FULL_SKILL, href: FULL_HREF })
      expect(html).toContain('v1.2.0')
    })

    it('version is absent when version is not provided', () => {
      const html = renderSkillCard({
        skill: { id: 'test', name: 'Test' },
        href: '/skills/test',
      })
      expect(html).not.toContain('v1.2.0')
    })
  })

  // ─── href + XSS ───────────────────────────────────────────────────────────────
  describe('href and XSS', () => {
    it('href is used verbatim — URL-encoded chars are preserved', () => {
      const href = '/skills/' + encodeURIComponent('a/b c')
      const html = renderSkillCard({ skill: { id: 'a/b c', name: 'Test' }, href })
      expect(html).toContain(`href="${href}"`)
    })

    it('dangerous chars in name and author are HTML-escaped', () => {
      const skill: WireSkill = {
        id: 'test',
        name: '<img src=x onerror=alert(1)>',
        author: '"></a>',
      }
      const html = renderSkillCard({ skill, href: '/skills/test' })
      // name: raw < must not appear; escaped &lt; must appear in its place
      expect(html).not.toContain('<img src=x')
      expect(html).toContain('&lt;img src=x')
      // author: raw " must not appear as an attribute breakout sequence
      expect(html).not.toContain('"></a>')
    })
  })
})
