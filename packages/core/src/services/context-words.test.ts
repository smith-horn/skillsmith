/**
 * @fileoverview Unit tests for the shared context-word extraction helper
 *   (SMI-5986). Both CLI `recommend --context` and MCP `skill_recommend`'s
 *   `project_context` now call this instead of duplicating
 *   `.filter((w) => w.length > 3)`, so their behavior can't drift apart.
 * @module @skillsmith/core/services/context-words.test
 */
import { describe, expect, it } from 'vitest'

import { extractContextWords } from './context-words.js'

describe('extractContextWords (SMI-5986)', () => {
  it('keeps real short technical terms that the old length>3 threshold dropped', () => {
    const words = extractContextWords('git ci aws sql k8s')
    expect(words).toEqual(['git', 'ci', 'aws', 'sql', 'k8s'])
  })

  it('does not derive an empty stack from a context of only short technical terms', () => {
    // SMI-5986 regression: this exact shape used to filter to [], which then
    // tripped the SMI-5896 empty-stack guard even though the caller supplied
    // usable context.
    expect(extractContextWords('git').length).toBeGreaterThan(0)
    expect(extractContextWords('ci').length).toBeGreaterThan(0)
  })

  it('drops single-character tokens as noise', () => {
    expect(extractContextWords('a i x')).toEqual([])
  })

  it('drops short English stopwords but keeps a real term in the same input', () => {
    const words = extractContextWords('a be api testing')
    expect(words).not.toContain('a')
    expect(words).not.toContain('be')
    expect(words).toContain('api')
    expect(words).toContain('testing')
  })

  it('drops punctuation-only tokens', () => {
    expect(extractContextWords('... -- !!')).toEqual([])
  })

  it('strips edge punctuation without mangling the term ("git," -> "git")', () => {
    expect(extractContextWords('git,')).toEqual(['git'])
    expect(extractContextWords('(sql)')).toEqual(['sql'])
  })

  it('is case-insensitive ("Git" -> "git")', () => {
    expect(extractContextWords('Git')).toEqual(['git'])
    expect(extractContextWords('AWS SQL')).toEqual(['aws', 'sql'])
  })

  it('preserves + and # as meaningful trailing characters, not strippable punctuation', () => {
    // Code-review regression (SMI-5986): edge-punctuation stripping used to
    // treat "+" and "#" as noise, turning "c++"/"c#" into the single
    // character "c", which the length filter then discarded entirely.
    expect(extractContextWords('c++')).toEqual(['c++'])
    expect(extractContextWords('c#')).toEqual(['c#'])
    expect(extractContextWords('c++,')).toEqual(['c++'])
    expect(extractContextWords('(c#)')).toEqual(['c#'])
  })

  it('does not filter real technical terms that are also common English words', () => {
    // Code-review regression (SMI-5986): "any" (TS/SQL keyword), "let"
    // (JS/Rust keyword), and "can" (CAN-bus acronym) were previously in the
    // stopword set, contradicting its own documented promise.
    expect(extractContextWords('any')).toEqual(['any'])
    expect(extractContextWords('let')).toEqual(['let'])
    expect(extractContextWords('can')).toEqual(['can'])
  })

  it('leaves 4+ character words unaffected (pre-existing behavior preserved)', () => {
    const words = extractContextWords('testing utilities framework')
    expect(words).toEqual(['testing', 'utilities', 'framework'])
  })

  it('slices to the max word count (default 5)', () => {
    const words = extractContextWords('one two three four five six seven')
    expect(words).toHaveLength(5)
  })

  it('respects a custom maxWords argument', () => {
    const words = extractContextWords('git ci aws sql k8s docker', 3)
    expect(words).toEqual(['git', 'ci', 'aws'])
  })

  it('returns [] for undefined, null, or empty input', () => {
    expect(extractContextWords(undefined)).toEqual([])
    expect(extractContextWords(null)).toEqual([])
    expect(extractContextWords('')).toEqual([])
  })

  it('returns [] for whitespace-only input', () => {
    expect(extractContextWords('   ')).toEqual([])
  })
})
