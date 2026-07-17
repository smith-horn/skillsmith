/**
 * SMI-595: describeSignals() — banned-vocabulary translation-layer tests.
 *
 * User-facing security copy must describe *what's wrong*, not leak internal
 * detection-method jargon (which means nothing to a skill installer and
 * could help an attacker tune around the detector).
 */

import { describe, it, expect } from 'vitest'
import { describeSignals } from './SecurityScanner.formatters.js'
import { scanTyposquat } from './typosquat.js'
import type { SecurityFinding } from './types.js'

/** Terms that must never appear in describeSignals() output (case-insensitive). */
const BANNED_VOCABULARY = [
  'homoglyph',
  'confusable',
  'skeleton',
  'rule 1',
  'rule 2',
  'rule 3',
  'ladder',
]

describe('describeSignals (SMI-595 §7)', () => {
  it('produces one message per typosquat finding', () => {
    const findings = scanTyposquat('anthropic-mcp-official', new Set(['anthropic']))
    const messages = describeSignals(findings)
    expect(messages).toHaveLength(findings.length)
    expect(messages.length).toBeGreaterThan(0)
  })

  it('never contains banned detection-method vocabulary, across all three rules', () => {
    const impersonation = scanTyposquat('аnthropic', new Set(['anthropic'])) // Cyrillic а
    const levenshtein = scanTyposquat('claude-cod', new Set(['claude-code']))
    const authorityAffix = scanTyposquat('anthropic-mcp-official', new Set(['anthropic']))

    const allFindings = [...impersonation, ...levenshtein, ...authorityAffix]
    expect(allFindings.length).toBeGreaterThan(0)
    const messages = describeSignals(allFindings)
    expect(messages.length).toBe(allFindings.length)

    for (const message of messages) {
      const lower = message.toLowerCase()
      for (const banned of BANNED_VOCABULARY) {
        expect(lower.includes(banned)).toBe(false)
      }
    }
  })

  it('ignores non-typosquat findings', () => {
    const jailbreakFinding: SecurityFinding = {
      type: 'jailbreak',
      severity: 'critical',
      message: 'Ignore previous instructions',
    }
    expect(describeSignals([jailbreakFinding])).toHaveLength(0)
  })

  it('falls back to a safe generic message for an unrecognized typosquat category', () => {
    const finding: SecurityFinding = {
      type: 'typosquat',
      severity: 'medium',
      message: 'internal message',
      category: 'typosquat:some-future-rule',
    }
    const messages = describeSignals([finding])
    expect(messages).toHaveLength(1)
    for (const banned of BANNED_VOCABULARY) {
      expect(messages[0].toLowerCase().includes(banned)).toBe(false)
    }
  })
})
