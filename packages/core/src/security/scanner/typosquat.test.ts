/**
 * SMI-595: typosquat.ts — detector tests.
 *
 * Covers the Wave 1 acceptance criteria directly:
 *  - exact-skeleton impersonation (fires on exact fold match only, never
 *    substring/affix)
 *  - Levenshtein edit-distance <= 2
 *  - authority-claiming affix, independent of the exact-skeleton rule
 *  - enforcement-mode severity capping
 */

import { describe, it, expect } from 'vitest'
import {
  BRAND_ALIASES,
  levenshteinDistance,
  scanTyposquat,
  applyTyposquatEnforcementMode,
  resolveTyposquatEnforcementMode,
  detectTyposquat,
  DEFAULT_TYPOSQUAT_ENFORCEMENT_MODE,
} from './typosquat.js'
import { HIGH_TRUST_OWNERS } from '../../scripts/github-import/signal-of-intent.js'

const findByCategory = (findings: ReturnType<typeof scanTyposquat>, category: string) =>
  findings.filter((f) => f.category === category)

describe('BRAND_ALIASES (SMI-595 §3)', () => {
  it('maps every alias to a real HIGH_TRUST_OWNERS entry', () => {
    for (const owner of Object.values(BRAND_ALIASES)) {
      expect(HIGH_TRUST_OWNERS.has(owner)).toBe(true)
    }
  })

  it('keys are lowercase brand tokens', () => {
    for (const brand of Object.keys(BRAND_ALIASES)) {
      expect(brand).toBe(brand.toLowerCase())
    }
  })
})

describe('levenshteinDistance', () => {
  it('is 0 for identical strings', () => {
    expect(levenshteinDistance('anthropic', 'anthropic')).toBe(0)
  })

  it('counts a single substitution as distance 1', () => {
    expect(levenshteinDistance('claude-code', 'claude-cude')).toBe(1)
  })

  it('counts a single deletion as distance 1', () => {
    expect(levenshteinDistance('claude-code', 'claude-cod')).toBe(1)
  })

  it('matches the classic kitten/sitting example (distance 3)', () => {
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3)
  })
})

describe('scanTyposquat — exact-skeleton impersonation (rule 1)', () => {
  it('flags a homoglyph-substituted exact match (Cyrillic а for Latin a)', () => {
    const referenceNames = new Set(['anthropic'])
    const findings = scanTyposquat('аnthropic', referenceNames) // Cyrillic а (U+0430)
    expect(findByCategory(findings, 'typosquat:impersonation-exact-skeleton')).toHaveLength(1)
    expect(findings[0].severity).toBe('critical')
    expect(findings[0].confidence).toBe('high')
  })

  it('does NOT flag a substring match (anthropic-community-tools) by this rule alone', () => {
    const referenceNames = new Set(['anthropic'])
    const findings = scanTyposquat('anthropic-community-tools', referenceNames)
    expect(findByCategory(findings, 'typosquat:impersonation-exact-skeleton')).toHaveLength(0)
    // and, more strongly for this specific case, no other rule fires either
    // (no Levenshtein-range match, no authority-claiming affix present).
    expect(findings).toHaveLength(0)
  })

  it('does NOT flag a pure case difference (not a confusable substitution)', () => {
    const referenceNames = new Set(['anthropic'])
    const findings = scanTyposquat('Anthropic', referenceNames)
    expect(findByCategory(findings, 'typosquat:impersonation-exact-skeleton')).toHaveLength(0)
  })

  it('does NOT flag the reference name matching itself', () => {
    const referenceNames = new Set(['anthropic'])
    const findings = scanTyposquat('anthropic', referenceNames)
    expect(findings).toHaveLength(0)
  })
})

describe('scanTyposquat — Levenshtein edit-distance <= 2 (rule 2)', () => {
  const referenceNames = new Set(['claude-code']) // models a HIGH_TRUST_OWNERS-published skill name

  it('flags an edit-distance-1 variant', () => {
    const findings = scanTyposquat('claude-cod', referenceNames)
    expect(findByCategory(findings, 'typosquat:levenshtein')).toHaveLength(1)
    expect(findings[0].severity).toBe('high')
  })

  it('flags an edit-distance-2 variant', () => {
    const findings = scanTyposquat('claude-cudo', referenceNames) // 2 substitutions
    expect(findByCategory(findings, 'typosquat:levenshtein')).toHaveLength(1)
  })

  it('does NOT flag an edit-distance-3+ variant (same length, no shared characters)', () => {
    const findings = scanTyposquat('zzzzzzzzzzz', referenceNames) // same length as "claude-code" (11)
    expect(findByCategory(findings, 'typosquat:levenshtein')).toHaveLength(0)
  })

  it('does NOT flag an unrelated name', () => {
    const findings = scanTyposquat('a-totally-unrelated-skill-name', referenceNames)
    expect(findings).toHaveLength(0)
  })
})

describe('scanTyposquat — authority-claiming affix, independent of rule 1 (Change #5)', () => {
  // Same base brand token ("anthropic") used for both the flagged and
  // not-flagged cases, proving the two checks are genuinely independent.
  const referenceNames = new Set(['anthropic'])

  it('flags a brand token + authority-claiming affix (anthropic-mcp-official)', () => {
    const findings = scanTyposquat('anthropic-mcp-official', referenceNames)
    expect(findByCategory(findings, 'typosquat:authority-affix')).toHaveLength(1)
    expect(findings.find((f) => f.category === 'typosquat:authority-affix')?.severity).toBe(
      'critical'
    )
  })

  it('does NOT flag a brand token + benign functional affix (anthropic-mcp)', () => {
    const findings = scanTyposquat('anthropic-mcp', referenceNames)
    expect(findings).toHaveLength(0)
  })

  it('does NOT flag a brand token + benign functional affix (anthropic-tools)', () => {
    const findings = scanTyposquat('anthropic-tools', referenceNames)
    expect(findings).toHaveLength(0)
  })

  it('does NOT flag other claimed-authority affixes without a brand token', () => {
    const findings = scanTyposquat('totally-unrelated-official', referenceNames)
    expect(findings).toHaveLength(0)
  })
})

describe('applyTyposquatEnforcementMode / resolveTyposquatEnforcementMode (§6)', () => {
  it('defaults to warn', () => {
    expect(DEFAULT_TYPOSQUAT_ENFORCEMENT_MODE).toBe('warn')
    expect(resolveTyposquatEnforcementMode(undefined)).toBe('warn')
  })

  it('resolves an explicit mode unchanged', () => {
    expect(resolveTyposquatEnforcementMode('block')).toBe('block')
    expect(resolveTyposquatEnforcementMode('off')).toBe('off')
  })

  it('warn mode caps critical/high severity at medium, regardless of raw confidence', () => {
    const raw = scanTyposquat('anthropic-mcp-official', new Set(['anthropic']))
    expect(raw[0].severity).toBe('critical') // raw, uncapped
    const capped = applyTyposquatEnforcementMode(raw, 'warn')
    expect(capped[0].severity).toBe('medium')
    expect(capped[0].confidence).toBe('high') // confidence is untouched, only severity is capped
  })

  it('off mode discards all findings', () => {
    const raw = scanTyposquat('anthropic-mcp-official', new Set(['anthropic']))
    expect(applyTyposquatEnforcementMode(raw, 'off')).toHaveLength(0)
  })

  it('block mode passes findings through at raw severity', () => {
    const raw = scanTyposquat('anthropic-mcp-official', new Set(['anthropic']))
    const passed = applyTyposquatEnforcementMode(raw, 'block')
    expect(passed[0].severity).toBe('critical')
  })

  it('detectTyposquat is a one-shot detect + apply-mode convenience wrapper, defaulting to warn', () => {
    const findings = detectTyposquat('anthropic-mcp-official', new Set(['anthropic']))
    expect(findings[0].severity).toBe('medium')
  })
})
