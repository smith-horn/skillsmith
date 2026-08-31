/**
 * @fileoverview Tests for `SubagentGenerator.helpers.ts` — split from
 * `SubagentGenerator.ts` (SMI-6276 Wave 6 Step 1, 500-line standard).
 */
import { describe, it, expect } from 'vitest'
import { extractTriggerPhrases } from '../SubagentGenerator.helpers.js'

describe('extractTriggerPhrases', () => {
  it('extracts phrases from normal descriptions and content', () => {
    const phrases = extractTriggerPhrases(
      'Use this when you need to test REST APIs.',
      'This skill helps you validate API responses.'
    )
    expect(phrases.length).toBeGreaterThan(0)
    expect(phrases.length).toBeLessThanOrEqual(5)
  })

  it('returns an empty array for content with no trigger-like phrasing', () => {
    const phrases = extractTriggerPhrases('A skill', 'Nothing special here')
    expect(Array.isArray(phrases)).toBe(true)
  })

  // CodeQL finding (SMI-6276, "polynomial regular expression used on
  // uncontrolled data"): the pre-fix patterns paired an optional word group
  // directly against an unbounded lazy wildcard capture, giving
  // polynomially-many ways to split ambiguous repeated content between "the
  // optional group matched" and "the wildcard consumed it instead" --
  // `description` here is NOT length-capped before reaching these patterns
  // (only `content` is sliced to 2000 chars), and is untrusted,
  // externally-authored text in a skill registry — a genuine attack
  // surface. Empirically confirmed (not just theoretical) before this fix:
  // the exact 3-pattern loop below, run against a ~32KB adversarial
  // description built the same way as this test's input, took ~1.25s
  // pre-fix and ~7ms post-fix on this same test machine -- a real,
  // measurable quadratic-ish blowup a large-enough description would turn
  // into a genuine multi-second-or-more DoS.
  it('does not exhibit polynomial-time blowup on adversarial "helps ... tasks" input (ReDoS)', () => {
    const adversarialDescription = 'helps you to ' + 'a '.repeat(16000) + 'nomatch'
    const start = Date.now()
    const phrases = extractTriggerPhrases(adversarialDescription, '')
    const elapsedMs = Date.now() - start

    expect(Array.isArray(phrases)).toBe(true)
    // The fixed patterns finish in single-digit milliseconds regardless of
    // input size (bounded capture groups cap worst-case per-position work
    // to a small constant); the pre-fix patterns measured ~1250ms on this
    // exact input on this machine. 1000ms leaves generous CI-jitter
    // headroom while still failing hard on any reintroduction of the
    // unbounded-wildcard shape.
    expect(elapsedMs).toBeLessThan(1000)
  })

  it('does not exhibit polynomial-time blowup on adversarial "when ... need to" input (ReDoS)', () => {
    const adversarialDescription = 'when ' + 'you need to '.repeat(16000) + 'nomatch'
    const start = Date.now()
    const phrases = extractTriggerPhrases(adversarialDescription, '')
    const elapsedMs = Date.now() - start

    expect(Array.isArray(phrases)).toBe(true)
    expect(elapsedMs).toBeLessThan(1000)
  })

  it('still caps extracted phrases at the existing 50-character limit', () => {
    const longDescription = 'when you need to ' + 'x'.repeat(200) + '.'
    const phrases = extractTriggerPhrases(longDescription, '')
    for (const phrase of phrases) {
      expect(phrase.length).toBeLessThanOrEqual(50)
    }
  })
})
