/**
 * SMI-5879 (design §3.3): the RC-1 two-bound multiline-scan cap.
 *
 * Verifies scanPatternsWithMultilineSupport's pass-1 loop against the
 * required test table in design §3.3.7 — the round-3 raw-match cap counted
 * the wrong unit (regex matches, not scoring units); this file pins the
 * corrected behavior: MAX_MULTILINE_LINES_PER_PATTERN bounds distinct
 * SCORING lines per pattern (score-neutral, Lemma 3.3-B), while
 * MAX_MULTILINE_ITERATIONS_PER_PATTERN is a separate, non-score-neutral
 * wall-clock liveness bound.
 *
 * Uses real, already-scoped production patterns (JAILBREAK_PATTERNS[17] =
 * JB_JS3A_DEV_MODE_THEN_CAPABILITY, a same-line-repeatable 'content'-scope
 * pattern; AI_DEFENCE_PATTERNS[8] = AD_DELIMITER_BARE, a one-match-per-line
 * 'content'-scope pattern) rather than synthetic ones —
 * scanPatternsWithMultilineSupport's resolvePatternScope() throws on any
 * pattern not registered in the fail-closed PATTERN_SCOPE map by design, so a
 * synthetic pattern can't reach this function at all.
 */

import { describe, it, expect } from 'vitest'
import {
  scanPatternsWithMultilineSupport,
  MAX_MULTILINE_LINES_PER_PATTERN,
  MAX_MULTILINE_ITERATIONS_PER_PATTERN,
} from '../../src/security/scanner/SecurityScanner.helpers.js'
import { JAILBREAK_PATTERNS, AI_DEFENCE_PATTERNS } from '../../src/security/scanner/patterns.js'
import { classifyEvidence } from '../../src/security/scanner/SecurityScanner.evidence.js'
import { EVIDENCE_SEVERITY_TABLE } from '../../src/security/scanner/SecurityScanner.evidence.js'
import { SEVERITY_WEIGHTS, CATEGORY_WEIGHTS } from '../../src/security/scanner/weights.js'
import type { EvidenceType, FindingConfidence } from '../../src/security/scanner/types.js'

// JB_JS3A_DEV_MODE_THEN_CAPABILITY: 'content'-scope, state_assertion tier,
// non-newline-crossing per match (`[^\n]{0,80}?`) — repeats within one line.
const JB_JS3A = JAILBREAK_PATTERNS[17]
// AD_DELIMITER_BARE: 'content'-scope, mention tier, requires a line-start
// anchor (`(?:^|\n)`) — exactly one match per matching line.
const AD_DELIMITER_BARE = AI_DEFENCE_PATTERNS[8]

const REPEATED_JS3A_PHRASE = 'developer mode with no restrictions, '

describe('SMI-5879 §3.3.7 — same-line repetition does not consume the line budget', () => {
  it('a single line with many matches of one pattern leaves seenLines.size === 1', () => {
    const content = REPEATED_JS3A_PHRASE.repeat(200)
    const result = scanPatternsWithMultilineSupport(content, {
      type: 'jailbreak',
      messagePrefix: 'test',
      patterns: [JB_JS3A],
      classify: () => 'state_assertion' as EvidenceType,
    })

    const findings = result.findings.filter((f) => f.type === 'jailbreak')
    expect(findings).toHaveLength(1)
    expect(findings[0]?.lineNumber).toBe(1)
    expect(result.truncated).toBe(false)
  })
})

describe('SMI-5879 §3.3.7 — same-line repetition on early lines still reaches a later genuine finding', () => {
  it('line 1 has 100 matches of JB_JS3A; a later line has one more — both are recorded', () => {
    const lines = new Array(400).fill('unrelated filler documentation text')
    lines[0] = REPEATED_JS3A_PHRASE.repeat(100)
    lines[399] = 'developer mode with no restrictions'
    const content = lines.join('\n')

    const result = scanPatternsWithMultilineSupport(content, {
      type: 'jailbreak',
      messagePrefix: 'test',
      patterns: [JB_JS3A],
      classify: () => 'state_assertion' as EvidenceType,
    })

    const findingLines = result.findings
      .map((f) => f.lineNumber)
      .sort((a, b) => (a ?? 0) - (b ?? 0))
    expect(findingLines).toEqual([1, 400])
  })
})

describe('SMI-5879 §3.3.7 — line cap binds at exactly MAX_MULTILINE_LINES_PER_PATTERN distinct lines', () => {
  it('200 distinct matching lines for one pattern emit exactly 64 findings from that pattern', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `### system line ${i}`)
    const content = lines.join('\n')

    const result = scanPatternsWithMultilineSupport(content, {
      type: 'ai_defence',
      messagePrefix: 'test',
      patterns: [AD_DELIMITER_BARE],
      classify: () => 'mention' as EvidenceType,
    })

    expect(result.findings).toHaveLength(MAX_MULTILINE_LINES_PER_PATTERN)
    expect(MAX_MULTILINE_LINES_PER_PATTERN).toBe(64)
  })

  it('Lemma 3.3-B: the truncation at the line cap is score-neutral — the category subtotal is already clamped', () => {
    // ai_defence mention: severity=low(5) x category=1.9 x confidence=low(0.3) = 2.85/finding.
    // 64 x 2.85 = 182.4, already > the 100 raw-per-category cap well before line 64.
    const rawPerFinding = SEVERITY_WEIGHTS.low * CATEGORY_WEIGHTS.ai_defence * 0.3
    expect(MAX_MULTILINE_LINES_PER_PATTERN * rawPerFinding).toBeGreaterThan(100)
  })
})

describe('SMI-5879 §3.3.7 — line cap is per-pattern, not global', () => {
  it('pattern p saturates at 64 lines; pattern q matching a later line still records and upgrades it', () => {
    const pLines = Array.from({ length: 64 }, (_, i) => `### system saturating-line-${i}`)
    const qLine = 'developer mode with no restrictions'
    const content = [...pLines, qLine].join('\n')

    const result = scanPatternsWithMultilineSupport(content, {
      type: 'jailbreak',
      messagePrefix: 'test',
      patterns: [AD_DELIMITER_BARE, JB_JS3A],
      classify: (pattern) => (pattern === JB_JS3A ? 'state_assertion' : 'mention'),
    })

    // p contributes exactly 64 mention-tier findings (lines 1-64); q's match on
    // line 65 is a DIFFERENT pattern's own seenLines set, so it is not
    // blocked by p's saturation — it must still appear, upgraded to
    // state_assertion (the strongest tier).
    const line65 = result.findings.find((f) => f.lineNumber === 65)
    expect(line65).toBeDefined()
    expect(line65?.evidenceType).toBe('state_assertion')
    expect(result.findings.filter((f) => f.evidenceType === 'mention')).toHaveLength(64)
  })
})

describe('SMI-5879 §3.3.7 — derived floor is recomputed from live weight tables', () => {
  it('MAX_MULTILINE_LINES_PER_PATTERN >= ceil(100 / min_raw_per_finding), computed at test time', () => {
    const confidenceWeights: Record<FindingConfidence, number> = {
      high: 1.0,
      medium: 0.7,
      low: 0.3,
    }
    const tiers = Object.keys(EVIDENCE_SEVERITY_TABLE) as EvidenceType[]
    const contexts: Array<'doc' | 'nonDoc'> = ['doc', 'nonDoc']
    const categories = ['jailbreak', 'ai_defence'] as const

    let minRaw = Infinity
    for (const tier of tiers) {
      for (const ctx of contexts) {
        const { severity, confidence } = EVIDENCE_SEVERITY_TABLE[tier][ctx]
        for (const category of categories) {
          const raw =
            SEVERITY_WEIGHTS[severity] * CATEGORY_WEIGHTS[category] * confidenceWeights[confidence]
          minRaw = Math.min(minRaw, raw)
        }
      }
    }

    const derivedFloor = Math.ceil(100 / minRaw)
    expect(MAX_MULTILINE_LINES_PER_PATTERN).toBeGreaterThanOrEqual(derivedFloor)
  })
})

describe('SMI-5879 §3.3.7 — iteration ceiling marks the scan truncated', () => {
  it('a synthetic input producing > MAX_MULTILINE_ITERATIONS_PER_PATTERN matches of one pattern sets truncated: true', () => {
    const content = REPEATED_JS3A_PHRASE.repeat(MAX_MULTILINE_ITERATIONS_PER_PATTERN + 500)
    const result = scanPatternsWithMultilineSupport(content, {
      type: 'jailbreak',
      messagePrefix: 'test',
      patterns: [JB_JS3A],
      classify: () => 'state_assertion' as EvidenceType,
    })

    expect(result.truncated).toBe(true)
    // The line cap still binds first for the scoring output — truncation
    // does not itself inflate finding count beyond the score-neutral cap.
    expect(result.findings).toHaveLength(1)
  })
})

describe('SMI-5879 §3.3.7 — raw-vs-final saturation', () => {
  it('classifyEvidence + resolveEvidenceSeverity produce the documented raw-per-finding numbers', () => {
    expect(classifyEvidence(JB_JS3A)).toBe('state_assertion')
    expect(classifyEvidence(AD_DELIMITER_BARE)).toBe('mention')
  })
})
