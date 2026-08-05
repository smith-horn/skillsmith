/**
 * SMI-5876 Wave 1 / SMI-5881: evidence-tier classification for
 * JAILBREAK_PATTERNS + AI_DEFENCE_PATTERNS.
 * @module @skillsmith/core/security/scanner/patterns.jailbreak.evidence
 *
 * Split out of patterns.jailbreak.ts (SMI-5881 — that file was approaching
 * the 500-line audit:standards gate again, same reason it was split out of
 * patterns.ts in SMI-5876) so EVIDENCE_TYPE_BY_PATTERN's declaration doesn't
 * grow patterns.jailbreak.ts every time a new pattern is added.
 *
 * Keyed by OBJECT IDENTITY, exhaustive over both arrays (asserted by test in
 * scanner-evidence-tiers.test.ts), but classifyEvidence() (SecurityScanner.
 * evidence.ts) still defaults UNMAPPED patterns to `imperative_instruction` —
 * fail-closed: forgetting to classify a newly added pattern makes it
 * strongest, never weakest.
 *
 * Built from parallel index-aligned arrays (not per-named-const references)
 * because the individual pattern consts (JB_IGNORE_PREVIOUS, AD_ROLE_MARKER_
 * BARE, ...) are private to patterns.jailbreak.ts and intentionally not
 * exported — this file only ever sees the same JAILBREAK_PATTERNS /
 * AI_DEFENCE_PATTERNS arrays every other consumer sees, so a length mismatch
 * (pattern added to one array, tier forgotten here) is impossible to
 * misalign silently: the two arrays below MUST stay index-aligned with the
 * exported pattern arrays, or scanner-evidence-tiers.test.ts's exhaustiveness
 * assertion catches it immediately.
 *
 * Consumed ONLY by SecurityScanner's severity resolution. Every other
 * consumer of JAILBREAK_PATTERNS / AI_DEFENCE_PATTERNS (memory-injection-
 * scanner.ts's quarantine gate, SecurityScanner.quickCheck()) ignores it by
 * design — both those call sites test bare pattern presence, not evidence
 * tier, and that is intentional (see their own inline comments).
 */

import type { EvidenceType } from './types.js'
import { JAILBREAK_PATTERNS, AI_DEFENCE_PATTERNS } from './patterns.jailbreak.js'

// Index-aligned with JAILBREAK_PATTERNS (patterns.jailbreak.ts) — keep in sync.
const JAILBREAK_EVIDENCE: readonly EvidenceType[] = [
  'instruction_override', // JB_IGNORE_PREVIOUS
  'instruction_override', // JB_DISREGARD_PREVIOUS
  'mention', // JB_DEVELOPER_MODE
  'mention', // JB_DAN_BARE
  'mention', // JB_DO_ANYTHING_NOW
  'mention', // JB_JAILBREAK_BARE
  'imperative_instruction', // JB_BYPASS_RESTRICTIONS
  'imperative_instruction', // JB_PRETEND_NO_RESTRICTIONS
  'imperative_instruction', // JB_ACT_NO_ETHICS
  'imperative_instruction', // JB_YOU_ARE_NOW_FREE
  'instruction_override', // JB_IGNORE_SAFETY_GUIDELINES
  'imperative_instruction', // JB_HYPOTHETICAL_SCENARIO
  'imperative_instruction', // JB_JN1_MODE_FRAME
  'imperative_instruction', // JB_JN2_DEVELOPER_MODE_FRAME
  'imperative_instruction', // JB_JN3_PERSONA_FRAME
  'state_assertion', // JB_JS1_STATE_BARE
  'state_assertion', // JB_JS2_NOUN_MODE_STATE
  'state_assertion', // JB_JS3A_DEV_MODE_THEN_CAPABILITY
  'state_assertion', // JB_JS3B_CAPABILITY_THEN_DEV_MODE
  'imperative_instruction', // JB_JS4_OBEDIENCE_COMPULSION
  'instruction_override', // JB_SPLIT_IGNORE
  'instruction_override', // JB_SPLIT_DISREGARD
  'imperative_instruction', // JB_SPLIT_BYPASS
]

// Index-aligned with AI_DEFENCE_PATTERNS (patterns.jailbreak.ts) — keep in sync.
const AI_DEFENCE_EVIDENCE: readonly EvidenceType[] = [
  'mention', // AD_ROLE_MARKER_BARE
  'mention', // AD_BRACKET_HIDDEN
  'instruction_override', // AD_HTML_COMMENT_VERB
  'mention', // AD_HTML_COMMENT_NOUN
  'imperative_instruction', // AD_HOMOGRAPH_RUN_PLUS_KEYWORD
  'mention', // AD_MIXED_SCRIPT_WORD
  'mention', // AD_XML_TAG_BARE
  'imperative_instruction', // AD_BASE64_INSTRUCTIONS
  'mention', // AD_DELIMITER_BARE
  'mention', // AD_JSON_ROLE_FIELD
  'role_turn_with_body', // AD_NESTED_INSTRUCTION_BLOCK
  'instruction_override', // AD_CRLF_INJECTION
  'mention', // AD_TEMPLATE_LITERAL
  'mention', // AD_ZERO_WIDTH
  'imperative_instruction', // AD_MARKDOWN_LINK_PAYLOAD
  'imperative_instruction', // AD_ESCAPE_SEQUENCE_ABUSE
  'mention', // AD_ZALGO_COMBINING
  'role_turn_with_body', // AD_AN1_ROLE_BODY_SAME_LINE
  'role_turn_with_body', // AD_AN2_ROLE_BODY_NEXT_LINE
  'role_turn_with_body', // AD_AN3A_CHAT_TOKEN_BODY_SAME_LINE
  'role_turn_with_body', // AD_AN3B_CHAT_TOKEN_BODY_NEXT_LINE
]

export const EVIDENCE_TYPE_BY_PATTERN: ReadonlyMap<RegExp, EvidenceType> = new Map<
  RegExp,
  EvidenceType
>([
  ...JAILBREAK_PATTERNS.map((p, i) => [p, JAILBREAK_EVIDENCE[i]] as const),
  ...AI_DEFENCE_PATTERNS.map((p, i) => [p, AI_DEFENCE_EVIDENCE[i]] as const),
])

/**
 * Module-load gate: unlike patterns.scope.ts's PATTERN_SCOPE, an unmapped
 * entry here degrades safely (classifyEvidence() fail-closes to the
 * strongest tier), so this isn't a silent-coverage-gap risk the way scope is.
 * Still asserted directly rather than relying solely on `Map.has()` via
 * scanner-evidence-tiers.test.ts's exhaustiveness check: `new Map([[p,
 * undefined]])` reports `.has(p) === true`, so an out-of-range EVIDENCE[i]
 * read during construction (a length mismatch between a PATTERNS array and
 * its index-aligned EVIDENCE array) would pass a has()-only check silently.
 */
function assertEvidenceCoverage(): void {
  const pairs: ReadonlyArray<{
    name: string
    patterns: readonly RegExp[]
    evidence: readonly EvidenceType[]
  }> = [
    { name: 'JAILBREAK_PATTERNS', patterns: JAILBREAK_PATTERNS, evidence: JAILBREAK_EVIDENCE },
    { name: 'AI_DEFENCE_PATTERNS', patterns: AI_DEFENCE_PATTERNS, evidence: AI_DEFENCE_EVIDENCE },
  ]
  for (const { name, patterns, evidence } of pairs) {
    if (patterns.length !== evidence.length) {
      throw new Error(
        `[SecurityScanner] ${name} has ${patterns.length} pattern(s) but its evidence array has ` +
          `${evidence.length} entries — they must be index-aligned and equal length. ` +
          `Add or remove an evidence entry in patterns.jailbreak.evidence.ts to match.`
      )
    }
    patterns.forEach((pattern, index) => {
      const evidenceType = EVIDENCE_TYPE_BY_PATTERN.get(pattern)
      if (!EVIDENCE_TYPE_BY_PATTERN.has(pattern) || evidenceType === undefined) {
        throw new Error(
          `[SecurityScanner] ${name}[${index}] (/${pattern.source}/${pattern.flags}) has no ` +
            `EVIDENCE_TYPE_BY_PATTERN entry.`
        )
      }
    })
  }
}

assertEvidenceCoverage()
