/**
 * SMI-6441 Wave 1, Step 6 — lexicon-content assertions: "did the data
 * actually land" gate.
 * @module packages/core/tests/security/weak-password-lexicon
 *
 * Mirrored under scripts/tests/indexer/weak-password-lexicon.test.ts against
 * the Node-edge twin. This class of test exists because of SMI-5207's
 * hardest-won lesson: a fixture list hand-traced through the plan's prose
 * contradicted the real implementation, and only running assertions against
 * the REAL generated data caught it.
 *
 * All ranks cited in comments below are properties of the PINNED snapshot
 * (commit c205c36a445bff37f8e58a9ec829105cd4975c58, SOURCES.json). If that
 * pin is ever moved, every rank must be re-derived — see the plan doc's
 * Wave 1 Step 3 warning.
 */

import { describe, it, expect } from 'vitest'
import {
  COMMON_WEAK_PASSWORDS,
  WEAK_PASSWORD_LEXICON_SOURCE,
} from '../../src/security/scanner/SecurityScanner.weak-passwords.js'
import { PROSE_STOPWORDS } from '../../src/security/scanner/SecurityScanner.prose-lexicon.js'

const SHAPE_RE = /^[a-z]{3,19}$/
const ENCODING_UNSAFE_RE = /[`\\$]/

describe('WEAK_PASSWORD_LEXICON_SOURCE provenance', () => {
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
    // Bound must name the SAME two numbers as the generator's own gate
    // (scripts/gen-weak-password-lexicon.mjs MIN_ENTRIES/MAX_ENTRIES).
    // Asserting the RANGE (not the literal count) so a legitimate future
    // keeplist addition doesn't fail this test — but the exact measured
    // value at SOURCE_RANK_LIMIT=5000 against the pinned snapshot + shipped
    // keeplist is recorded here so an unexplained drift is visible in review.
    //
    // SMI-6441 Wave 2: 4,079 -> 4,012 (review round 2) -> 4,009 (round 3).
    // Round 2: two reviewers found the keeplist had no software-engineering
    // vocabulary section, so ordinary documentation nouns were still in the
    // lexicon and vetoed benign two-token labels to HIGH — which BLOCKS AN
    // INSTALL, since that gate fails on hasHigh alone. Round 3 then showed
    // curation does not converge (55% of entries are English dictionary
    // words), so the VETO PREDICATE changed from some() to every() and the
    // keeplist's remaining job narrowed to both-tokens pairs (center, office,
    // trial). This literal moving is the intended, reviewed consequence.
    expect(COMMON_WEAK_PASSWORDS.size).toBe(WEAK_PASSWORD_LEXICON_SOURCE.entries)
    expect(COMMON_WEAK_PASSWORDS.size).toBeGreaterThanOrEqual(2000)
    expect(COMMON_WEAK_PASSWORDS.size).toBeLessThanOrEqual(6000)
    expect(COMMON_WEAK_PASSWORDS.size).toBe(4009)
  })
})

describe('COMMON_WEAK_PASSWORDS — shape and encoding-safety invariants', () => {
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

describe('COMMON_WEAK_PASSWORDS — truncation-boundary pins (M-2a)', () => {
  // Testing only survivors would pass even if the SOURCE_RANK_LIMIT
  // truncation silently never ran (or was raised) — the exclusion half is
  // the load-bearing half of this test class.
  it('keeps `ninja` (rank 1,971) and `alenka` (rank 4,993) — well inside the limit', () => {
    expect(COMMON_WEAK_PASSWORDS.has('ninja')).toBe(true)
    expect(COMMON_WEAK_PASSWORDS.has('alenka')).toBe(true)
  })

  it('excludes tokens ranked beyond SOURCE_RANK_LIMIT that pass the shape filter and are not keeplisted', () => {
    // xerxes (5,008), wraith (5,009), subzero (5,015), woowoo (9,025) are
    // genuine common passwords the untruncated design would have caught —
    // absent here for exactly one reason: they rank beyond 5,000. A
    // regression that removes or raises the truncation step turns these
    // green and fails this test.
    expect(COMMON_WEAK_PASSWORDS.has('xerxes')).toBe(false)
    expect(COMMON_WEAK_PASSWORDS.has('wraith')).toBe(false)
    expect(COMMON_WEAK_PASSWORDS.has('subzero')).toBe(false)
    expect(COMMON_WEAK_PASSWORDS.has('woowoo')).toBe(false)
  })
})

describe('COMMON_WEAK_PASSWORDS — positive membership pins (Wave 2 must-fire fixtures)', () => {
  it.each([
    ['horse', 1038],
    ['monkey', 15],
    ['dragon', 10],
    ['qwerty', 4],
    ['letmein', 16],
    ['sunshine', 50],
    ['swordfish', 1172],
  ])('%s (rank %i) is present', (token) => {
    // If any of these is ever absent, the corresponding Wave 2 fixture must
    // be changed to a present token — never add words to the lexicon by
    // hand to make a fixture pass; that defeats the generator (plan § Step
    // 6 warning).
    expect(COMMON_WEAK_PASSWORDS.has(token)).toBe(true)
  })
})

describe('COMMON_WEAK_PASSWORDS — negative membership pins (must-stay-MEDIUM fixtures)', () => {
  // Step 6 reconciliation table: every token a must-stay-MEDIUM fixture
  // depends on being absent, and the gate that covers it.
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
    'master', // C-1: certain top-1000 password; pins the keeplist
  ])('%s is absent (keeplist)', (token) => {
    expect(COMMON_WEAK_PASSWORDS.has(token)).toBe(false)
  })

  it('"use" is absent — doubly moot (PROSE_STOPWORDS disjointness, not a keeplist entry; L-4)', () => {
    // Retained here per the plan's L-4 note so nobody later "fixes" this by
    // adding `use` to doc-vocab-keeplist.txt: it is already prose evidence
    // (PROSE_STOPWORDS), and its only fixture is 3-token so the 2-token
    // carve-out never reaches it regardless.
    expect(COMMON_WEAK_PASSWORDS.has('use')).toBe(false)
  })
})
