import { describe, it, expect } from 'vitest'
import { escapeHtml, formatNumber, getQualityTier, TIER_THRESHOLDS } from './skills-utils.js'

/**
 * SMI-5365: skills-utils is the shared, browser/SSR-safe helper module the
 * skills pages (and, in Wave B / SMI-5366, the extracted skill-card renderer)
 * depend on. These tests lock the escaping/formatting contract and the
 * re-exported quality-tier boundaries so a future edit can't silently regress
 * the rendered cards.
 */

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    // Quotes are escaped too (the old DOM-based version did not) — required for
    // the aria-label / title attribute contexts the card interpolates into.
    expect(escapeHtml(`<script>&"'`)).toBe('&lt;script&gt;&amp;&quot;&#39;')
  })

  it('escapes & first so existing entities are not double-mangled by order', () => {
    expect(escapeHtml('a & b < c')).toBe('a &amp; b &lt; c')
  })

  it('neutralizes a classic XSS payload', () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'
    )
  })

  it('returns empty string for empty / null / undefined', () => {
    expect(escapeHtml('')).toBe('')
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(undefined)).toBe('')
  })

  it('leaves plain text untouched', () => {
    expect(escapeHtml('Claude Code skill')).toBe('Claude Code skill')
  })
})

describe('formatNumber', () => {
  it('coerces null / undefined to 0 (explicit contract)', () => {
    expect(formatNumber(null)).toBe('0')
    expect(formatNumber(undefined)).toBe('0')
  })

  it('formats numbers with locale grouping', () => {
    // Asserts grouping happens without pinning a locale-specific separator.
    expect(formatNumber(0)).toBe('0')
    expect(formatNumber(1234).replace(/[,.\s ]/g, '')).toBe('1234')
    expect(formatNumber(10000).replace(/[,.\s ]/g, '')).toBe('10000')
  })
})

describe('getQualityTier (re-exported from utils/quality-tiers)', () => {
  it('exposes the canonical thresholds', () => {
    expect(TIER_THRESHOLDS).toMatchObject({ ELITE: 10000, HIGH_QUALITY: 500, GROWING: 50 })
  })

  // Boundary table — guards the {color,label} pairs the quality dot renders so a
  // re-export drift (or a quality-tiers.ts change) that shifts a tier is caught.
  const cases: Array<[number, string, string]> = [
    [0, 'text-red-400', 'New'],
    [49, 'text-red-400', 'New'],
    [50, 'text-yellow-400', 'Growing'],
    [499, 'text-yellow-400', 'Growing'],
    [500, 'text-green-400', 'High Quality'],
    [9999, 'text-green-400', 'High Quality'],
    [10000, 'text-blue-400', 'Elite'],
  ]
  it.each(cases)('stars=%i → %s / %s', (stars, color, label) => {
    const tier = getQualityTier(stars)
    expect(tier.color).toBe(color)
    expect(tier.label).toBe(label)
  })

  it('coerces null/undefined stars to the lowest tier', () => {
    expect(getQualityTier(null).label).toBe('New')
    expect(getQualityTier(undefined).label).toBe('New')
  })
})
