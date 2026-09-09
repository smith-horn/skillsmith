/**
 * SMI-6441 Wave 1, Step 6 — lexicon-content assertions, mirrored against the
 * Node-edge twin.
 * @module scripts/tests/indexer/weak-password-lexicon
 *
 * Mirror of packages/core/tests/security/weak-password-lexicon.test.ts,
 * against scripts/indexer/_shared/security-scanner-edge.weak-passwords.ts
 * (the Node port of the Deno edge twin) rather than the core copy. Both
 * copies are byte-identical modulo their `@module` line (see L1/L2 parity
 * suites), so the assertions are deliberately identical — this file exists
 * to catch a divergence in the SHIPPED artifact itself, not to test new
 * behaviour.
 *
 * All ranks cited in comments below are properties of the PINNED snapshot
 * (commit c205c36a445bff37f8e58a9ec829105cd4975c58, SOURCES.json). If that
 * pin is ever moved, every rank must be re-derived.
 */

import { describe, it, expect } from 'vitest'
import {
  COMMON_WEAK_PASSWORDS,
  WEAK_PASSWORD_LEXICON_SOURCE,
} from '../../indexer/_shared/security-scanner-edge.weak-passwords.ts'
import { PROSE_STOPWORDS } from '../../indexer/_shared/security-scanner-edge.prose-lexicon.ts'

const SHAPE_RE = /^[a-z]{3,19}$/
const ENCODING_UNSAFE_RE = /[`\\$]/

describe('WEAK_PASSWORD_LEXICON_SOURCE provenance (Node-edge)', () => {
  it('records the pinned commit and SHA-256', () => {
    expect(WEAK_PASSWORD_LEXICON_SOURCE.commit).toBe('c205c36a445bff37f8e58a9ec829105cd4975c58')
    expect(WEAK_PASSWORD_LEXICON_SOURCE.sha256).toBe(
      'c63d5e4ccc31344d662583cc39ca4bd5bd20517ff1d24501f0c4e0c22d9b722a'
    )
    expect(WEAK_PASSWORD_LEXICON_SOURCE.license).toBe('MIT')
  })

  it('sourceRankLimit is 5000 (M-2a)', () => {
    expect(WEAK_PASSWORD_LEXICON_SOURCE.sourceRankLimit).toBe(5000)
  })

  it('entries matches the emitted Set size, and is inside [2000, 6000] (M-2)', () => {
    // SMI-6441 Wave 2: 4,079 -> 4,012 (review round 2) -> 4,009 (round 3,
    // which also changed the veto predicate from some() to every()). Keep this
    // literal in lock-step with the core mirror under packages/core/tests.
    expect(COMMON_WEAK_PASSWORDS.size).toBe(WEAK_PASSWORD_LEXICON_SOURCE.entries)
    expect(COMMON_WEAK_PASSWORDS.size).toBeGreaterThanOrEqual(2000)
    expect(COMMON_WEAK_PASSWORDS.size).toBeLessThanOrEqual(6000)
    expect(COMMON_WEAK_PASSWORDS.size).toBe(4009)
  })
})

describe('COMMON_WEAK_PASSWORDS — shape and encoding-safety invariants (Node-edge)', () => {
  it('every entry matches /^[a-z]{3,19}$/', () => {
    for (const entry of COMMON_WEAK_PASSWORDS) {
      expect(entry).toMatch(SHAPE_RE)
    }
  })

  it('no entry contains a backtick, backslash, or "$" (M-1)', () => {
    for (const entry of COMMON_WEAK_PASSWORDS) {
      expect(entry).not.toMatch(ENCODING_UNSAFE_RE)
    }
  })

  it('is disjoint from PROSE_STOPWORDS', () => {
    const overlap = [...COMMON_WEAK_PASSWORDS].filter((t) => PROSE_STOPWORDS.has(t))
    expect(overlap).toEqual([])
  })
})

describe('COMMON_WEAK_PASSWORDS — truncation-boundary pins (M-2a, Node-edge)', () => {
  it('keeps `ninja` (rank 1,971) and `alenka` (rank 4,993) — well inside the limit', () => {
    expect(COMMON_WEAK_PASSWORDS.has('ninja')).toBe(true)
    expect(COMMON_WEAK_PASSWORDS.has('alenka')).toBe(true)
  })

  it('excludes tokens ranked beyond SOURCE_RANK_LIMIT that pass the shape filter and are not keeplisted', () => {
    expect(COMMON_WEAK_PASSWORDS.has('xerxes')).toBe(false)
    expect(COMMON_WEAK_PASSWORDS.has('wraith')).toBe(false)
    expect(COMMON_WEAK_PASSWORDS.has('subzero')).toBe(false)
    expect(COMMON_WEAK_PASSWORDS.has('woowoo')).toBe(false)
  })
})

describe('COMMON_WEAK_PASSWORDS — positive membership pins (Wave 2 must-fire fixtures, Node-edge)', () => {
  it.each(['horse', 'monkey', 'dragon', 'qwerty', 'letmein', 'sunshine', 'swordfish'])(
    '%s is present',
    (token) => {
      expect(COMMON_WEAK_PASSWORDS.has(token)).toBe(true)
    }
  )
})

describe('COMMON_WEAK_PASSWORDS — negative membership pins (must-stay-MEDIUM fixtures, Node-edge)', () => {
  it.each([
    'rotation',
    'policy',
    'management',
    'access',
    'token',
    'manager',
    'password',
    'key',
    'schedule',
    'master',
  ])('%s is absent (keeplist)', (token) => {
    expect(COMMON_WEAK_PASSWORDS.has(token)).toBe(false)
  })

  it('"use" is absent — doubly moot (PROSE_STOPWORDS disjointness, not a keeplist entry; L-4)', () => {
    expect(COMMON_WEAK_PASSWORDS.has('use')).toBe(false)
  })
})
