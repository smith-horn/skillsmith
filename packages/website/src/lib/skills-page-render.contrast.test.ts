/**
 * Contrast, heading-structure and label tests for the /account/skills device
 * cards (SMI-6503).
 *
 * Why these assertions exist: six of eight text elements on a *stale* device
 * card were below WCAG AA on the live page, and the single largest contributor
 * was `opacity: .72` on `.device-card--stale` — which composites the whole card
 * as a group and costs every color on it roughly a third of its contrast. The
 * declared colors alone looked survivable; the rendered result was not.
 * standards-astro.md:460 names that trap directly ("opacity compounds
 * contrast").
 *
 * These are static assertions over the CSS string and the emitted markup. They
 * cannot prove *rendered* contrast — a seeded browser check is the gate for
 * that. What they do prove is that the specific regressions this fix removes
 * cannot come back silently: the opacity, the four below-AA literals, the
 * missing link underline, and the raw harness slugs.
 */

import { describe, it, expect } from 'vitest'
import { SKILLS_PAGE_CSS, buildDeviceCardHtml, harnessHeadingLabel } from './skills-page-render'
import type { DeviceView } from './inventory-view'

/** Colors measured below 4.5:1 on this page's own surfaces. */
const BELOW_AA_LITERALS = [
  '#71717a', // 3.90:1 on the card, 3.67:1 on a skill row
  '#52525b', // 2.29:1 on a skill row — the worst offender
  '#a16207', // 3.83:1 on the card
]

function deviceWithHarnesses(harnesses: string[], isStale = true): DeviceView {
  return {
    deviceId: 'abcdef12-3456-4789-8abc-def012345678',
    label: 'Test Device',
    hostnameDisplay: null,
    platform: 'darwin',
    lastSeen: '2026-06-26T00:00:00.000Z',
    deviceState: isStale ? 'stale' : 'fresh',
    neverSynced: false,
    skills: harnesses.map((harness, i) => ({
      harness,
      skillId: `acme/skill-${i}`,
      version: '1.0.0',
      present: true,
      pinned: false,
      state: 'current' as const,
      author: null,
      repository: null,
      license: null,
    })),
  }
}

describe('SKILLS_PAGE_CSS — contrast regressions', () => {
  it('does not apply opacity to stale cards', () => {
    const staleRule = SKILLS_PAGE_CSS.split('\n').find((l) => l.startsWith('.device-card--stale{'))
    expect(staleRule).toBeDefined()
    expect(staleRule).not.toContain('opacity')
  })

  it.each(BELOW_AA_LITERALS)('does not use the below-AA literal %s', (literal) => {
    // Strip comments first — the header comment cites the values it replaced.
    const declarations = SKILLS_PAGE_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(declarations).not.toContain(literal)
  })

  it('routes every text color through a --sk-* custom property', () => {
    const declarations = SKILLS_PAGE_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    const colorDecls = declarations.match(/(?<![-\w])color:\s*[^;}]+/g) ?? []
    expect(colorDecls.length).toBeGreaterThan(0)
    for (const decl of colorDecls) {
      expect(decl).toContain('var(--sk-')
    }
  })

  it('underlines source links at rest, not only on hover', () => {
    const rule = SKILLS_PAGE_CSS.split('\n').find((l) => l.startsWith('.skill-source-link{'))
    expect(rule).toBeDefined()
    // standards-astro.md:465 — links in text blocks need a non-color cue.
    expect(rule).toContain('text-decoration:underline')
    expect(rule).not.toContain('text-decoration:none')
  })

  it('marks staleness with a border rather than a dimmed card', () => {
    const staleRule = SKILLS_PAGE_CSS.split('\n').find((l) => l.startsWith('.device-card--stale{'))
    expect(staleRule).toContain('var(--sk-accent-stale)')
  })
})

describe('harnessHeadingLabel', () => {
  it('renders the shared AGENTS.md directory readably', () => {
    expect(harnessHeadingLabel('agents')).toBe('Shared (AGENTS.md)')
  })

  it('renders a client slug as its product name', () => {
    expect(harnessHeadingLabel('claude-code')).toBe('Claude Code')
    expect(harnessHeadingLabel('copilot')).toBe('GitHub Copilot')
  })

  it('falls through to the raw slug for an unmapped harness', () => {
    // Forward compatibility: a newly-supported client renders readably without
    // a change here, rather than showing a blank or a wrong label.
    expect(harnessHeadingLabel('some-future-client')).toBe('some-future-client')
  })

  it('names the unreported case rather than emitting an empty heading', () => {
    expect(harnessHeadingLabel('')).toBe('Default harness')
  })
})

describe('buildDeviceCardHtml — heading structure', () => {
  it('emits exactly one Skills section heading per card', () => {
    const html = buildDeviceCardHtml(deviceWithHarnesses(['agents', 'claude-code']))
    const matches = html.match(/class="skills-section-heading"/g) ?? []
    expect(matches).toHaveLength(1)
  })

  it('nests harness subgroups below the section heading, not beside it', () => {
    // Device name is <h3>, section is <h4>, subgroups are <h5>. Emitting both
    // levels as <h4> would make them peers and break the document outline.
    const html = buildDeviceCardHtml(deviceWithHarnesses(['agents', 'claude-code']))
    expect(html).toContain('<h3 class="device-name"')
    expect(html).toContain('<h4 class="skills-section-heading">Skills</h4>')
    expect(html).toContain('<h5 class="harness-heading">')
    expect(html).not.toContain('<h4 class="harness-heading">')
  })

  it('renders one subgroup heading per distinct harness', () => {
    const html = buildDeviceCardHtml(deviceWithHarnesses(['agents', 'claude-code']))
    const matches = html.match(/class="harness-heading"/g) ?? []
    expect(matches).toHaveLength(2)
    expect(html).toContain('Shared (AGENTS.md)')
    expect(html).toContain('Claude Code')
  })

  it('shows readable labels instead of raw slugs', () => {
    const html = buildDeviceCardHtml(deviceWithHarnesses(['agents', 'claude-code']))
    expect(html).not.toContain('>agents<')
    expect(html).not.toContain('>claude-code<')
  })

  it('escapes an unmapped harness slug', () => {
    // The fall-through path returns attacker-influenced data verbatim, so the
    // call site's escaping is what keeps it safe.
    const html = buildDeviceCardHtml(deviceWithHarnesses(['<img src=x onerror=alert(1)>']))
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })
})
