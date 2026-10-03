/**
 * SMI-5879: Edge scanner evidence-tier classification + pattern scope + corroboration.
 * @module scripts/indexer/_shared/security-scanner-edge.evidence (Node port)
 *
 * Ported from @skillsmith/core's SecurityScanner.evidence.ts +
 * patterns.jailbreak.evidence.ts + patterns.scope.ts, adapted to edge's
 * `jailbreak`/`prompt_injection` finding types (edge has no separate
 * `ai_defence` type — core's AI_DEFENCE_PATTERNS subset maps onto edge's
 * PROMPT_INJECTION_PATTERNS array). Byte-identical body across both _shared
 * twins (parity test enforces); only the @module header line differs.
 *
 * Turns a pattern's `EvidenceType` (classified below) plus documentation
 * context into a severity/confidence pair, and provides the corroboration
 * escalation that lifts a `mention`-tier finding when it co-occurs with a
 * genuinely dangerous non-documentation signal elsewhere in the same scan.
 */

import type {
  EvidenceType,
  SecurityFinding,
  SecurityFindingType,
  SecuritySeverity,
  FindingConfidence,
} from './security-scanner-edge.context.ts'
import { JAILBREAK_PATTERNS, PROMPT_INJECTION_PATTERNS } from './security-scanner-edge.patterns.ts'

// ============================================================================
// Evidence-tier classification
// ============================================================================

// Index-aligned with JAILBREAK_PATTERNS (security-scanner-edge.patterns.ts) —
// keep in sync. See that module's header comment for the full pattern mapping.
const JAILBREAK_EVIDENCE: readonly EvidenceType[] = [
  'instruction_override', // JB_IGNORE_PREVIOUS
  'instruction_override', // JB_DISREGARD_PREVIOUS
  'mention', // edge's own developer-mode (activation-verb gated)
  'mention', // JB_DAN_BARE
  'mention', // JB_DO_ANYTHING_NOW
  'mention', // JB_JAILBREAK_BARE
  'imperative_instruction', // JB_BYPASS_RESTRICTIONS
  'imperative_instruction', // JB_PRETEND_NO_RESTRICTIONS
  'imperative_instruction', // JB_YOU_ARE_NOW_FREE
  'instruction_override', // JB_IGNORE_SAFETY_GUIDELINES
  'imperative_instruction', // JB_JN1_MODE_FRAME
  'imperative_instruction', // JB_JN2_DEVELOPER_MODE_FRAME
  'imperative_instruction', // JB_JN3_PERSONA_FRAME
  'state_assertion', // JB_JS1_STATE_BARE
  'state_assertion', // JB_JS2_NOUN_MODE_STATE
  'state_assertion', // JB_JS3A_DEV_MODE_THEN_CAPABILITY
  'state_assertion', // JB_JS3B_CAPABILITY_THEN_DEV_MODE
  'imperative_instruction', // JB_JS4_OBEDIENCE_COMPULSION
]

// Index-aligned with PROMPT_INJECTION_PATTERNS (security-scanner-edge.patterns.ts).
const PROMPT_INJECTION_EVIDENCE: readonly EvidenceType[] = [
  'mention', // AD_ROLE_MARKER_BARE
  'mention', // AD_BRACKET_HIDDEN
  'instruction_override', // AD_HTML_COMMENT_VERB
  'mention', // AD_HTML_COMMENT_NOUN
  'mention', // AD_XML_TAG_BARE
  'mention', // AD_DELIMITER_BARE
  'mention', // AD_JSON_ROLE_FIELD
  'role_turn_with_body', // AD_AN1_ROLE_BODY_SAME_LINE
  'role_turn_with_body', // AD_AN2_ROLE_BODY_NEXT_LINE
]

const EVIDENCE_TYPE_BY_PATTERN: ReadonlyMap<RegExp, EvidenceType> = new Map<RegExp, EvidenceType>([
  ...JAILBREAK_PATTERNS.map((p, i) => [p, JAILBREAK_EVIDENCE[i]] as const),
  ...PROMPT_INJECTION_PATTERNS.map((p, i) => [p, PROMPT_INJECTION_EVIDENCE[i]] as const),
])

/**
 * Classify a pattern's evidence tier by object identity. Unmapped patterns
 * default to `imperative_instruction` — fail-closed: forgetting to classify a
 * new pattern makes it the STRONGEST tier, never the weakest.
 */
export function classifyEvidence(p: RegExp): EvidenceType {
  return EVIDENCE_TYPE_BY_PATTERN.get(p) ?? 'imperative_instruction'
}

/**
 * Module-load gate: unlike PATTERN_SCOPE below, an unmapped entry here
 * degrades safely (classifyEvidence() fail-closes to the strongest tier), so
 * this isn't a silent-coverage-gap risk the way scope is — still asserted
 * directly (not just via `Map.has()`) since `new Map([[p, undefined]])`
 * reports `.has(p) === true`, which an out-of-range EVIDENCE[i] read during
 * construction (a length mismatch) would pass silently.
 */
function assertEvidenceCoverage(): void {
  const pairs: ReadonlyArray<{
    name: string
    patterns: readonly RegExp[]
    evidence: readonly EvidenceType[]
  }> = [
    { name: 'JAILBREAK_PATTERNS', patterns: JAILBREAK_PATTERNS, evidence: JAILBREAK_EVIDENCE },
    {
      name: 'PROMPT_INJECTION_PATTERNS',
      patterns: PROMPT_INJECTION_PATTERNS,
      evidence: PROMPT_INJECTION_EVIDENCE,
    },
  ]
  for (const { name, patterns, evidence } of pairs) {
    if (patterns.length !== evidence.length) {
      throw new Error(
        `[security-scanner-edge] ${name} has ${patterns.length} pattern(s) but its evidence array ` +
          `has ${evidence.length} entries — they must be index-aligned and equal length.`
      )
    }
    patterns.forEach((pattern, index) => {
      const evidenceType = EVIDENCE_TYPE_BY_PATTERN.get(pattern)
      if (!EVIDENCE_TYPE_BY_PATTERN.has(pattern) || evidenceType === undefined) {
        throw new Error(
          `[security-scanner-edge] ${name}[${index}] (/${pattern.source}/${pattern.flags}) has no ` +
            `evidence-tier entry.`
        )
      }
    })
  }
}

assertEvidenceCoverage()

/**
 * Relative strength ordering used by the merge-loop in security-scanner-edge.ts
 * to pick the strongest evidence per line across both the multi-line and
 * single-line scan passes.
 */
export const EVIDENCE_RANK: Record<EvidenceType, number> = {
  mention: 0,
  role_turn_with_body: 1,
  imperative_instruction: 2,
  instruction_override: 2,
  state_assertion: 2,
}

/** The highest rank in `EVIDENCE_RANK` — once reached, no later pattern on the same line can beat it. */
export const MAX_EVIDENCE_RANK = 2

/**
 * Severity/confidence decision table, ported verbatim from core's
 * EVIDENCE_SEVERITY_TABLE (SecurityScanner.evidence.ts).
 */
export const EVIDENCE_SEVERITY_TABLE: Record<
  EvidenceType,
  {
    doc: { severity: SecuritySeverity; confidence: FindingConfidence }
    nonDoc: { severity: SecuritySeverity; confidence: FindingConfidence }
  }
> = {
  mention: {
    nonDoc: { severity: 'low', confidence: 'low' },
    doc: { severity: 'low', confidence: 'low' },
  },
  role_turn_with_body: {
    nonDoc: { severity: 'high', confidence: 'high' },
    doc: { severity: 'medium', confidence: 'medium' },
  },
  imperative_instruction: {
    nonDoc: { severity: 'critical', confidence: 'high' },
    doc: { severity: 'high', confidence: 'medium' },
  },
  instruction_override: {
    nonDoc: { severity: 'critical', confidence: 'high' },
    doc: { severity: 'high', confidence: 'medium' },
  },
  state_assertion: {
    nonDoc: { severity: 'critical', confidence: 'high' },
    doc: { severity: 'high', confidence: 'medium' },
  },
}

/** Resolve the severity/confidence pair for an evidence tier + documentation context. */
export function resolveEvidenceSeverity(
  tier: EvidenceType,
  inDocumentationContext: boolean
): { severity: SecuritySeverity; confidence: FindingConfidence } {
  const entry = EVIDENCE_SEVERITY_TABLE[tier]
  return inDocumentationContext ? entry.doc : entry.nonDoc
}

// ============================================================================
// Pattern scope model — ported from core patterns.scope.ts
// ============================================================================

export type PatternScope = 'line' | 'content' | 'both'

// Index-aligned with JAILBREAK_PATTERNS. Only JB_JS3A/JS3B are 'content' —
// same naive-heuristic classification core carries forward unchanged.
const JAILBREAK_SCOPE: readonly PatternScope[] = [
  'line', // JB_IGNORE_PREVIOUS
  'line', // JB_DISREGARD_PREVIOUS
  'line', // edge's own developer-mode
  'line', // JB_DAN_BARE
  'line', // JB_DO_ANYTHING_NOW
  'line', // JB_JAILBREAK_BARE
  'line', // JB_BYPASS_RESTRICTIONS
  'line', // JB_PRETEND_NO_RESTRICTIONS
  'line', // JB_YOU_ARE_NOW_FREE
  'line', // JB_IGNORE_SAFETY_GUIDELINES
  'line', // JB_JN1_MODE_FRAME
  'line', // JB_JN2_DEVELOPER_MODE_FRAME
  'line', // JB_JN3_PERSONA_FRAME
  'line', // JB_JS1_STATE_BARE
  'line', // JB_JS2_NOUN_MODE_STATE
  'content', // JB_JS3A_DEV_MODE_THEN_CAPABILITY
  'content', // JB_JS3B_CAPABILITY_THEN_DEV_MODE
  'line', // JB_JS4_OBEDIENCE_COMPULSION
]

// Index-aligned with PROMPT_INJECTION_PATTERNS. Indices 2/3 are the two
// HTML-comment halves, both promoted to 'both' (mirrors core's
// AD_HTML_COMMENT_VERB/NOUN promotion, SMI-5881).
const PROMPT_INJECTION_SCOPE: readonly PatternScope[] = [
  'content', // AD_ROLE_MARKER_BARE
  'line', // AD_BRACKET_HIDDEN
  'both', // AD_HTML_COMMENT_VERB
  'both', // AD_HTML_COMMENT_NOUN
  'line', // AD_XML_TAG_BARE
  'content', // AD_DELIMITER_BARE
  'line', // AD_JSON_ROLE_FIELD
  'line', // AD_AN1_ROLE_BODY_SAME_LINE
  'content', // AD_AN2_ROLE_BODY_NEXT_LINE
]

const PATTERN_SCOPE: ReadonlyMap<RegExp, PatternScope> = new Map<RegExp, PatternScope>([
  ...JAILBREAK_PATTERNS.map((p, i) => [p, JAILBREAK_SCOPE[i]] as const),
  ...PROMPT_INJECTION_PATTERNS.map((p, i) => [p, PROMPT_INJECTION_SCOPE[i]] as const),
])

/**
 * Resolve a pattern's scope by object identity. Throws (does NOT default) for
 * any pattern reaching a scope-resolving scanner without a PATTERN_SCOPE
 * entry — a pattern scanned in the wrong pass, or neither, is a silent
 * coverage gap, not a conservative failure mode.
 */
export function resolvePatternScope(pattern: RegExp): PatternScope {
  const scope = PATTERN_SCOPE.get(pattern)
  if (scope === undefined) {
    throw new Error(
      `[security-scanner-edge] pattern /${pattern.source}/${pattern.flags} has no scope entry. ` +
        `Every pattern reaching a scope-resolving scanner must declare 'line' | 'content' | 'both'.`
    )
  }
  return scope
}

const VALID_SCOPES: ReadonlySet<PatternScope> = new Set(['line', 'content', 'both'])

function assertScopeCoverage(): void {
  const pairs: ReadonlyArray<{
    name: string
    patterns: readonly RegExp[]
    scopes: readonly PatternScope[]
  }> = [
    { name: 'JAILBREAK_PATTERNS', patterns: JAILBREAK_PATTERNS, scopes: JAILBREAK_SCOPE },
    {
      name: 'PROMPT_INJECTION_PATTERNS',
      patterns: PROMPT_INJECTION_PATTERNS,
      scopes: PROMPT_INJECTION_SCOPE,
    },
  ]
  for (const { name, patterns, scopes } of pairs) {
    if (patterns.length !== scopes.length) {
      throw new Error(
        `[security-scanner-edge] ${name} has ${patterns.length} pattern(s) but its scope array has ` +
          `${scopes.length} entries — they must be index-aligned and equal length.`
      )
    }
    patterns.forEach((pattern, index) => {
      const scope = PATTERN_SCOPE.get(pattern)
      if (!PATTERN_SCOPE.has(pattern) || scope === undefined) {
        throw new Error(
          `[security-scanner-edge] ${name}[${index}] (/${pattern.source}/${pattern.flags}) has no ` +
            `scope entry.`
        )
      }
      if (!VALID_SCOPES.has(scope)) {
        throw new Error(
          `[security-scanner-edge] ${name}[${index}] (/${pattern.source}/${pattern.flags}) has an ` +
            `invalid scope value ${JSON.stringify(scope)} — must be 'line', 'content', or 'both'.`
        )
      }
    })
  }
}

assertScopeCoverage()

// ============================================================================
// Corroboration escalation — ported from core SecurityScanner.evidence.ts
// ============================================================================

/**
 * Corroborator eligibility is an ALLOWLIST of INSTRUCTION-BEARING attack
 * categories (mirrors core's CORROBORATING_SIGNALS — see that file's doc
 * comment for the denylist->allowlist rationale). Edge has no `ssrf` finding
 * type, so this allowlist is core's minus `ssrf`.
 */
const CORROBORATING_SIGNALS: ReadonlySet<SecurityFindingType> = new Set([
  'code_execution',
  'obfuscated_directive',
  'data_exfiltration',
  'privilege_escalation',
])

/**
 * Maximum line distance between a mention and its corroborator — ported
 * verbatim from core (see SecurityScanner.evidence.ts for the bounded-window
 * rationale: corroboration is a risk-SCORE amplifier only, never able to flip
 * `passed`/quarantine on its own).
 */
const MAX_CORROBORATION_LINE_DISTANCE = 40

/**
 * Escalate a `mention`-tier finding when an ALLOWLISTED non-documentation
 * high/critical finding is ALSO present within `MAX_CORROBORATION_LINE_DISTANCE`
 * lines in the same scan. Mutates findings in place.
 *
 * MUST run after `escalateCodeExecution` (security-scanner-edge.exec.ts) so a
 * freshly-critical `code_execution` finding can itself serve as a
 * corroborator.
 */
export function escalateCorroboratedMentions(findings: SecurityFinding[]): void {
  const corroborators = findings.filter(
    (f) =>
      (f.severity === 'high' || f.severity === 'critical') &&
      f.inDocumentationContext !== true &&
      CORROBORATING_SIGNALS.has(f.type) &&
      typeof f.lineNumber === 'number'
  )
  if (corroborators.length === 0) return

  for (const finding of findings) {
    if (finding.evidenceType !== 'mention') continue
    if (typeof finding.lineNumber !== 'number') continue
    const corroborator = corroborators.find(
      (c) =>
        Math.abs((c.lineNumber as number) - (finding.lineNumber as number)) <=
        MAX_CORROBORATION_LINE_DISTANCE
    )
    if (!corroborator) continue

    const inDoc = finding.inDocumentationContext === true
    finding.severity = inDoc ? 'medium' : 'high'
    finding.confidence = inDoc ? 'low' : 'medium'
    finding.corroborated = true
    finding.message =
      `Corroborated by a co-occurring non-documentation ${corroborator.type} ` +
      `finding at line ${corroborator.lineNumber} — ${finding.message}`
  }
}
