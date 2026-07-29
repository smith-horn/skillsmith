/**
 * SMI-5881: Pattern scope model — replaces the old per-source-text
 * multiline-detection heuristic function (formerly in
 * SecurityScanner.helpers.ts, deleted entirely, no compatibility shim).
 * @module @skillsmith/core/security/scanner/patterns.scope
 *
 * The deleted heuristic sniffed a regex's SOURCE TEXT for the literal
 * two-character sequences `\r`/`\n` (or a `(?:^|\n)` prefix) to decide
 * whether a pattern should be tested against the full document (`content`)
 * or per-line. This heuristic was wrong in BOTH directions:
 *
 * - False negative: a pattern that spans lines via a bounded `[\s\S]{0,N}`
 *   character class (which matches a literal newline character at runtime)
 *   but has no literal `\r`/`\n` ESCAPE SEQUENCE in its regex source was
 *   scanned per-line only, so a genuinely cross-line attack could never fire
 *   (AD_HTML_COMMENT_VERB/NOUN, AD_NESTED_INSTRUCTION_BLOCK, AD_ZERO_WIDTH).
 * - False positive: a pattern containing a NEGATED newline-excluding class
 *   (`[^\n]{0,80}?`, deliberately forbidding a newline crossing) still
 *   contains the literal substring `\n` in its `.source` text, so the naive
 *   heuristic misclassified it as content-scope anyway (JB_JS3A/JS3B,
 *   AD_AN3A) — harmless today (these patterns are correctly kept out of the
 *   per-line pass since they were never meant to be tested there either) but
 *   still a real classification bug, not deliberate design.
 *
 * PATTERN_SCOPE replaces the heuristic with an explicit, fail-closed,
 * per-pattern declaration: `'line'` (per-line pass only), `'content'`
 * (full-document pass only), or `'both'` (tested in both passes — needed to
 * fix the false-negative class above without losing existing single-line
 * coverage). There is no default: an unmapped pattern throws at scan time
 * (`resolvePatternScope`) and the whole module fails to load if any pattern
 * in `SCOPED_PATTERN_SETS` is missing an entry (`assertScopeCoverage`, called
 * at the bottom of this file). Unlike the evidence-tier map (which safely
 * defaults an unmapped pattern to its STRONGEST tier), scope has no
 * analogous safe default — a pattern silently scanned in the WRONG pass (or
 * neither) is a silent coverage gap, not a conservative failure mode.
 *
 * Every scope assignment below is BASELINE-PRESERVING relative to the old
 * heuristic's actual current behavior, with exactly 4 explicit promotions
 * (`'line'` → `'both'`, section 1.4 of the SMI-5881 design): AD_HTML_COMMENT_
 * VERB, AD_HTML_COMMENT_NOUN, AD_NESTED_INSTRUCTION_BLOCK, AD_ZERO_WIDTH.
 * Every other pattern — including the two known false positives above
 * (JB_JS3A/JS3B, AD_AN3A) — keeps whatever scope the old heuristic already
 * computed for it; re-scoping any of those changes finding cardinality and
 * needs its own corpus review, out of scope for this P0 fix.
 */

import { JAILBREAK_PATTERNS, AI_DEFENCE_PATTERNS } from './patterns.jailbreak.js'
import { SSRF_INSTRUCTION_PATTERNS } from './patterns.js'

export type PatternScope = 'line' | 'content' | 'both'

// Index-aligned with JAILBREAK_PATTERNS (patterns.jailbreak.ts). Every entry
// here is 'line' except the two naive-heuristic false positives (JB_JS3A/
// JS3B, index 17/18 — see module doc comment) and the 3 genuinely multi-line
// split-word patterns (index 20-22), both baseline-preserving, not promoted.
const JAILBREAK_SCOPE: readonly PatternScope[] = [
  'line', // JB_IGNORE_PREVIOUS
  'line', // JB_DISREGARD_PREVIOUS
  'line', // JB_DEVELOPER_MODE
  'line', // JB_DAN_BARE
  'line', // JB_DO_ANYTHING_NOW
  'line', // JB_JAILBREAK_BARE
  'line', // JB_BYPASS_RESTRICTIONS
  'line', // JB_PRETEND_NO_RESTRICTIONS
  'line', // JB_ACT_NO_ETHICS
  'line', // JB_YOU_ARE_NOW_FREE
  'line', // JB_IGNORE_SAFETY_GUIDELINES
  'line', // JB_HYPOTHETICAL_SCENARIO
  'line', // JB_JN1_MODE_FRAME
  'line', // JB_JN2_DEVELOPER_MODE_FRAME
  'line', // JB_JN3_PERSONA_FRAME
  'line', // JB_JS1_STATE_BARE
  'line', // JB_JS2_NOUN_MODE_STATE
  'content', // JB_JS3A_DEV_MODE_THEN_CAPABILITY (naive-heuristic FP, baseline-preserved)
  'content', // JB_JS3B_CAPABILITY_THEN_DEV_MODE (naive-heuristic FP, baseline-preserved)
  'line', // JB_JS4_OBEDIENCE_COMPULSION
  'content', // JB_SPLIT_IGNORE (genuinely multi-line)
  'content', // JB_SPLIT_DISREGARD (genuinely multi-line)
  'content', // JB_SPLIT_BYPASS (genuinely multi-line)
]

// Index-aligned with AI_DEFENCE_PATTERNS (patterns.jailbreak.ts). Indices
// 2, 3, 10, 13 are the 4 explicit promotions ('line' -> 'both', SMI-5881 P0
// follow-up); index 19 (AD_AN3A) is the naive-heuristic FP, baseline-preserved
// as 'content' despite its own name/comment implying line-scope.
const AI_DEFENCE_SCOPE: readonly PatternScope[] = [
  'content', // AD_ROLE_MARKER_BARE
  'line', // AD_BRACKET_HIDDEN (deliberately kept line-only, see patterns.jailbreak.ts)
  'both', // AD_HTML_COMMENT_VERB — PROMOTED (was 'line')
  'both', // AD_HTML_COMMENT_NOUN — PROMOTED (was 'line')
  'line', // AD_HOMOGRAPH_RUN_PLUS_KEYWORD
  'line', // AD_MIXED_SCRIPT_WORD
  'line', // AD_XML_TAG_BARE (deliberately kept line-only, see patterns.jailbreak.ts)
  'line', // AD_BASE64_INSTRUCTIONS
  'content', // AD_DELIMITER_BARE
  'line', // AD_JSON_ROLE_FIELD
  'both', // AD_NESTED_INSTRUCTION_BLOCK — PROMOTED (was 'line')
  'content', // AD_CRLF_INJECTION (the P0 pattern — see patterns.jailbreak.ts)
  'line', // AD_TEMPLATE_LITERAL
  'both', // AD_ZERO_WIDTH — PROMOTED (was 'line')
  'line', // AD_MARKDOWN_LINK_PAYLOAD
  'line', // AD_ESCAPE_SEQUENCE_ABUSE
  'line', // AD_ZALGO_COMBINING
  'line', // AD_AN1_ROLE_BODY_SAME_LINE
  'content', // AD_AN2_ROLE_BODY_NEXT_LINE
  'content', // AD_AN3A_CHAT_TOKEN_BODY_SAME_LINE (naive-heuristic FP, baseline-preserved)
  'content', // AD_AN3B_CHAT_TOKEN_BODY_NEXT_LINE
]

// Index-aligned with SSRF_INSTRUCTION_PATTERNS (patterns.ts). None are 'both'
// — scanSsrfPatterns' older skip-based two-pass cannot correctly service it
// (see assertScopeCoverage's SSRF-never-'both' assertion below).
const SSRF_SCOPE: readonly PatternScope[] = [
  'line', // file://
  'line', // gopher://
  'line', // dict://
  'line', // ldap://
  'line', // localhost
  'line', // 127.0.0.\d+
  'line', // 0.0.0.0
  'line', // 169.254.169.254 (cloud metadata, bare)
  'line', // file:///etc/(passwd|shadow|hosts) (bare)
  'line', // gopher://localhost (bare)
  'content', // multiline file://
  'content', // multiline localhost/127/0.0.0.0
  'content', // multiline gopher://
]

export const PATTERN_SCOPE: ReadonlyMap<RegExp, PatternScope> = new Map<RegExp, PatternScope>([
  ...JAILBREAK_PATTERNS.map((p, i) => [p, JAILBREAK_SCOPE[i]] as const),
  ...AI_DEFENCE_PATTERNS.map((p, i) => [p, AI_DEFENCE_SCOPE[i]] as const),
  ...SSRF_INSTRUCTION_PATTERNS.map((p, i) => [p, SSRF_SCOPE[i]] as const),
])

/** Every pattern array consumed by a scope-resolving scan function. */
export const SCOPED_PATTERN_SETS: ReadonlyArray<{ name: string; patterns: readonly RegExp[] }> = [
  { name: 'JAILBREAK_PATTERNS', patterns: JAILBREAK_PATTERNS },
  { name: 'AI_DEFENCE_PATTERNS', patterns: AI_DEFENCE_PATTERNS },
  { name: 'SSRF_INSTRUCTION_PATTERNS', patterns: SSRF_INSTRUCTION_PATTERNS },
]

/**
 * Resolve a pattern's scope by object identity. Throws (does NOT default) for
 * any pattern reaching a scope-resolving scanner without a PATTERN_SCOPE
 * entry — there is no safe default direction for scope the way there is for
 * evidence tier (classifyEvidence's fail-closed-to-strongest-tier doesn't
 * apply here: a pattern scanned in the wrong pass, or neither, is a silent
 * coverage gap regardless of which "direction" you'd guess).
 */
export function resolvePatternScope(pattern: RegExp): PatternScope {
  const scope = PATTERN_SCOPE.get(pattern)
  if (scope === undefined) {
    throw new Error(
      `[SecurityScanner] pattern /${pattern.source}/${pattern.flags} has no PATTERN_SCOPE entry. ` +
        `Every pattern reaching a scope-resolving scanner must declare 'line' | 'content' | 'both'.`
    )
  }
  return scope
}

const VALID_SCOPES: ReadonlySet<PatternScope> = new Set(['line', 'content', 'both'])

/**
 * Named (patterns, scope) pairs consumed by the length-parity and
 * value-validity checks below. Kept separate from SCOPED_PATTERN_SETS (which
 * only names the pattern arrays, not their scope-array counterpart) so a
 * length mismatch between a PATTERNS array and its SCOPE array is caught
 * directly, rather than relying on index-aligned `.map()` silently reading
 * past the shorter array's end (see assertScopeCoverage's doc comment).
 */
const SCOPE_ARRAY_PAIRS: ReadonlyArray<{
  name: string
  patterns: readonly RegExp[]
  scopes: readonly PatternScope[]
}> = [
  { name: 'JAILBREAK_PATTERNS', patterns: JAILBREAK_PATTERNS, scopes: JAILBREAK_SCOPE },
  { name: 'AI_DEFENCE_PATTERNS', patterns: AI_DEFENCE_PATTERNS, scopes: AI_DEFENCE_SCOPE },
  { name: 'SSRF_INSTRUCTION_PATTERNS', patterns: SSRF_INSTRUCTION_PATTERNS, scopes: SSRF_SCOPE },
]

/**
 * Module-load gate: throws (making this module un-importable) if any pattern
 * in SCOPED_PATTERN_SETS lacks a PATTERN_SCOPE entry, if any
 * SSRF_INSTRUCTION_PATTERNS member is scoped 'both' (scanSsrfPatterns' older
 * skip-based two-pass, SecurityScanner.ssrf.ts, cannot correctly service
 * 'both' — see its own inline comment), OR — the case `Map.has()` alone
 * cannot catch — if a PATTERNS array and its index-aligned SCOPE array have
 * drifted out of length parity (e.g. a pattern appended without a
 * corresponding scope entry). `new Map([[p, undefined]])` still reports
 * `.has(p) === true`, so an out-of-range `SCOPE[i]` read during the Map's
 * construction would silently pass a has()-only check; the explicit
 * length-equality and value-membership checks below close that gap.
 * Deterministic (no data dependence), so it can't be silently skipped by a
 * lucky test-ordering fluke.
 */
function assertScopeCoverage(): void {
  for (const { name, patterns, scopes } of SCOPE_ARRAY_PAIRS) {
    if (patterns.length !== scopes.length) {
      throw new Error(
        `[SecurityScanner] ${name} has ${patterns.length} pattern(s) but its scope array has ` +
          `${scopes.length} entries — they must be index-aligned and equal length. ` +
          `Add or remove a scope entry in patterns.scope.ts to match.`
      )
    }
  }

  for (const { name, patterns } of SCOPED_PATTERN_SETS) {
    patterns.forEach((pattern, index) => {
      const scope = PATTERN_SCOPE.get(pattern)
      if (!PATTERN_SCOPE.has(pattern) || scope === undefined) {
        throw new Error(
          `[SecurityScanner] ${name}[${index}] (/${pattern.source}/${pattern.flags}) has no ` +
            `PATTERN_SCOPE entry. Add one to patterns.scope.ts before this pattern can be scanned.`
        )
      }
      if (!VALID_SCOPES.has(scope)) {
        throw new Error(
          `[SecurityScanner] ${name}[${index}] (/${pattern.source}/${pattern.flags}) has an invalid ` +
            `PATTERN_SCOPE value ${JSON.stringify(scope)} — must be 'line', 'content', or 'both'.`
        )
      }
    })
  }

  SSRF_INSTRUCTION_PATTERNS.forEach((pattern, index) => {
    if (PATTERN_SCOPE.get(pattern) === 'both') {
      throw new Error(
        `[SecurityScanner] SSRF_INSTRUCTION_PATTERNS[${index}] (/${pattern.source}/${pattern.flags}) ` +
          `is scoped 'both', but scanSsrfPatterns' two-pass cannot service 'both' — use 'line' or 'content'.`
      )
    }
  })
}

assertScopeCoverage()
