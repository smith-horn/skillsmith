/**
 * @fileoverview Shared context-word extraction for skill recommendations.
 * @module @skillsmith/core/services/context-words
 * @see SMI-5986: CLI `recommend --context` (`recommend.ts:76`) and MCP
 *   `skill_recommend`'s `project_context` (`recommend.ts:127`) each derived a
 *   "context words" slice for the recommendation stack via
 *   `.filter((w) => w.length > 3)` — a bare length threshold that silently
 *   dropped real 2-3 character technical terms ("git", "ci", "aws", "sql")
 *   that happen to be short. When a caller's context consisted only of such
 *   terms, the resulting derived stack was empty and the SMI-5896
 *   empty-stack guard (`buildEmptyStackGuidance`, this module's sibling)
 *   fired even though the caller *did* supply usable context.
 *
 *   Shared here (not duplicated per-twin) so CLI and MCP can't independently
 *   drift on what counts as noise vs. a real short technical term — the same
 *   class of duplication risk `buildEmptyStackGuidance` above already closed
 *   for the empty-stack message itself (plan-review correction, SMI-5984
 *   Wave 1: a bare length threshold "admits noise words" and leaves the two
 *   twins free to drift apart again independently).
 */

/** Maximum context words carried into the recommendation stack (matches both callers' pre-existing `.slice(0, 5)`). */
const MAX_CONTEXT_WORDS = 5

/**
 * Common short English function words that would otherwise pass a
 * length-based filter and pollute the recommendation stack as noise. Kept
 * intentionally short and grammar-only — no 2-3 letter technical acronym
 * ("ci", "ai", "ml", "db", "os", "ui", "js", "go", "git", "aws", "sql",
 * "cli", "api", "sdk", "css") appears here, since those are exactly the real
 * terms this fix exists to stop dropping.
 */
const CONTEXT_STOPWORDS = new Set<string>([
  // 2-letter
  'an',
  'is',
  'it',
  'be',
  'to',
  'of',
  'in',
  'on',
  'at',
  'as',
  'or',
  'if',
  'so',
  'no',
  'do',
  'am',
  'we',
  'us',
  'he',
  'my',
  'up',
  // 3-letter
  'the',
  'and',
  'but',
  'not',
  'did',
  'has',
  'had',
  'she',
  'him',
  'her',
  'its',
  'our',
  'all',
  'few',
  'out',
  'off',
  'via',
  'per',
  'own',
  'too',
  'yet',
  'nor',
  'you',
  'are',
  'was',
  'for',
  'may',
  'who',
  'why',
  'how',
  // Code-review correction (SMI-5986): "any" (TS/SQL keyword), "let"
  // (JS/Rust keyword), and "can" (CAN-bus acronym) were removed from this
  // set — each is a real technical term this fix exists to stop dropping,
  // same class as "git"/"ci"/"aws"/"sql". Leaving them in would have
  // contradicted this list's own documented promise above.
])

/**
 * Whether a single character counts as "keep" (not strippable edge
 * punctuation) — see `stripEdgePunctuation`. Plain character-code range
 * checks, not a regex — this is the actual "no regex" implementation (PR
 * review round 3, SMI-5986): round 2's fix still called `.test()` against a
 * single-character-class regex, which isn't the polynomial-backtracking
 * shape CodeQL flags, but didn't match its own doc comment's "manual
 * index-scan rather than a regex" claim either.
 */
function isKeepChar(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '+' || ch === '#'
}

/**
 * Whether a word contains at least one alphanumeric character — used to
 * reject punctuation-only tokens ("++", "##", "+#") that `isKeepChar` alone
 * would let through, since `+`/`#` count as "keep" but aren't themselves
 * usable content (PR review round 3, SMI-5986: `extractContextWords('++ ##
 * +#')` was returning `['++', '##', '+#']` — all three passed the length
 * filter with no alphanumeric substance at all).
 */
function hasAlphaNumeric(word: string): boolean {
  for (let i = 0; i < word.length; i++) {
    const ch = word[i]
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) return true
  }
  return false
}

/**
 * Strip leading/trailing punctuation from an already-lowercased token
 * without touching interior characters — "k8s" is untouched, but "git," ->
 * "git" and "(sql)" -> "sql". Real-world context strings aren't always
 * clean whitespace-delimited tokens (trailing commas, wrapping parens),
 * and a stray comma would otherwise make "git," fail to match the real
 * "git" term downstream.
 *
 * `+` and `#` count as "keep" characters (code-review correction, SMI-5986)
 * — they're meaningful trailing characters in real technical terms ("c++",
 * "c#"), not punctuation noise; stripping them turned both into the single
 * character "c", which the length filter then discarded entirely. A
 * punctuation-only token surviving this step (e.g. "++") is rejected
 * downstream by `hasAlphaNumeric`, not here — this function only trims
 * edges, it doesn't judge the result's usability.
 *
 * O(n), two linear index scans, no regex anywhere in the call chain
 * (CodeQL js/polynomial-redos, SMI-5986 PR review round 2 — verified
 * empirically, a 200k-character adversarial input runs in under 1ms).
 */
function stripEdgePunctuation(word: string): string {
  let start = 0
  while (start < word.length && !isKeepChar(word[start])) start++
  let end = word.length
  while (end > start && !isKeepChar(word[end - 1])) end--
  return word.slice(start, end)
}

/**
 * Extract up to `maxWords` usable technical terms from free-text project
 * context for the recommendation stack.
 *
 * Replaces the old `.filter((w) => w.length > 3)` threshold: real technical
 * terms of 2-3 characters ("git", "ci", "aws", "sql") are now kept, while
 * single-character tokens, punctuation-only tokens (including one that
 * survives edge-stripping because it's made entirely of `+`/`#`, e.g. "++"
 * or "+#" — PR review round 3, SMI-5986), and short English function words
 * ("a", "the", "is", ...) are still dropped as noise. Words of 4+
 * characters are unaffected — this only changes the outcome for the short
 * end of the spectrum the length threshold got wrong.
 *
 * @param projectContext - Free-text project/context description. `null`/
 *   `undefined`/empty returns `[]`, mirroring both callers' pre-existing
 *   `if (project_context)` guard.
 * @param maxWords - Maximum number of words to return (default 5).
 */
export function extractContextWords(
  projectContext: string | undefined | null,
  maxWords: number = MAX_CONTEXT_WORDS
): string[] {
  if (!projectContext) return []

  return projectContext
    .toLowerCase()
    .split(/\s+/)
    .map(stripEdgePunctuation)
    .filter(
      (word) =>
        word.length >= 2 &&
        hasAlphaNumeric(word) &&
        !(word.length <= 3 && CONTEXT_STOPWORDS.has(word))
    )
    .slice(0, maxWords)
}
