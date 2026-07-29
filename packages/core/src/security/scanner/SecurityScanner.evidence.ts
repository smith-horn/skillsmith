/**
 * Security Scanner — evidence-tier severity resolution (SMI-5876)
 * @module @skillsmith/core/security/scanner/SecurityScanner.evidence
 *
 * Turns a pattern's `EvidenceType` (classified in `patterns.jailbreak.ts`'s
 * `EVIDENCE_TYPE_BY_PATTERN`) plus documentation context into a
 * severity/confidence pair, and provides the corroboration escalation that
 * lifts a `mention`-tier finding when it co-occurs with a genuinely dangerous
 * non-documentation signal elsewhere in the same scan.
 */

import type {
  EvidenceType,
  SecurityFinding,
  SecurityFindingType,
  SecuritySeverity,
  FindingConfidence,
} from './types.js'
import { EVIDENCE_TYPE_BY_PATTERN } from './patterns.jailbreak.js'

/**
 * Classify a pattern's evidence tier by object identity. Unmapped patterns
 * (i.e. a pattern added to JAILBREAK_PATTERNS/AI_DEFENCE_PATTERNS without an
 * `EVIDENCE_TYPE_BY_PATTERN` entry) default to `imperative_instruction` —
 * fail-closed: forgetting to classify a new pattern makes it the STRONGEST
 * tier, never the weakest, so a missed classification can never silently
 * soften detection.
 */
export function classifyEvidence(p: RegExp): EvidenceType {
  return EVIDENCE_TYPE_BY_PATTERN.get(p) ?? 'imperative_instruction'
}

/**
 * Relative strength ordering used by the merge-loop in
 * `SecurityScanner.helpers.ts` to pick the strongest evidence per line across
 * both the multi-line and single-line scan passes. `imperative_instruction`,
 * `instruction_override`, and `state_assertion` are equal rank — the
 * severity table below treats them identically, and none needs to out-rank
 * the others. `state_assertion` (SMI-5876 design-pass follow-up) is a
 * distinct machine-readable REASON CODE for a declarative jailbroken-state
 * assertion ("Jailbreak activated") rather than a directive aimed at the
 * model — same severity tuple, different diagnostic label.
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
 * Severity/confidence decision table (SMI-5876 design §4.1). Doc-context
 * confidence for the directive tiers is `medium`, not `low` — `low` would be
 * self-contradictory next to a still-failing severity (it would also cut the
 * risk-score weight to 0.3x, which is not the intent for a directive payload
 * that merely happens to sit inside a fenced example).
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
  // SMI-5876 design-pass follow-up: same tuple as imperative_instruction —
  // state_assertion is a distinct reason code, not a distinct severity tier.
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

/**
 * SMI-5876 (post-implementation correction): corroborator eligibility is an
 * ALLOWLIST of INSTRUCTION-BEARING attack categories, not a denylist of
 * everything-except-self.
 *
 * The original design specified `type ∉ {jailbreak, ai_defence}`, reasoning only
 * about same-category circularity. That is the classic denylist failure — it
 * silently admits every category nobody considered. It admitted `pii`, whose
 * plain-email pattern fires on the author-contact bullet that nearly every
 * SKILL.md carries, so an unrelated `- Email: support@…` 74 lines away lifted a
 * benign "jailbreak" mention to high in this repo's OWN bundled SKILL.md — one of
 * SMI-5876's three acceptance fixtures.
 *
 * Both existing precedents here are allowlists: CODE_EXECUTION_CO_OCCURRENCE
 * (SecurityScanner.exec.ts) and SUPPLY_CHAIN_CO_SIGNALS
 * (SecurityScanner.hostile-update.ts). This restores that discipline.
 *
 * Inclusion rule — the category must be INSTRUCTION-BEARING (its patterns match
 * an instruction to do something adversarial). Deliberately excluded:
 *   • `pii` / `sensitive_path` — REFERENCE-bearing. A contact email or a `.env`
 *     path says something about data hygiene, nothing about whether a jailbreak
 *     ATTEMPT is present.
 *   • `suspicious_pattern` — `eval(` / `child_process` are ordinary vocabulary in
 *     dev-tooling skills.
 *   • `social_engineering` / `prompt_leaking` — semantically ADJACENT to jailbreak;
 *     admitting them recreates the very circularity the self-exclusion prevents
 *     (a persona/roleplay skill would lift its own jailbreak mentions).
 *   • `typosquat` — a property of the skill NAME, not its content.
 *   • `url` — capped at medium, so it could never qualify anyway.
 *   • `jailbreak` / `ai_defence` — same-category self-lift (original exclusion).
 */
const CORROBORATING_SIGNALS: ReadonlySet<SecurityFindingType> = new Set([
  'code_execution',
  'obfuscated_directive',
  'data_exfiltration',
  'privilege_escalation',
  'ssrf',
])

/**
 * Maximum line distance between a mention and its corroborator.
 *
 * Why a bounded window is NOT a bypass vector: corroboration is a risk-SCORE and
 * hostile-update amplifier only — it can never flip `passed`, because any
 * qualifying corroborator is itself high/critical and therefore already fails the
 * scan on its own (`passed = !hasCritical && !hasHigh && !exceedsThreshold`). An
 * attacker who separates the two signals to duck the window still fails on the
 * corroborator alone; all they achieve is a slightly lower numeric score on a
 * scan that already blocks.
 *
 * 40 lines comfortably spans a real payload block (persona preamble plus the
 * instructions it sets up) while excluding the "unrelated finding in a different
 * section of a long document" case that motivated this constraint.
 */
const MAX_CORROBORATION_LINE_DISTANCE = 40

/**
 * Escalate a `mention`-tier finding when an ALLOWLISTED non-documentation
 * high/critical finding is ALSO present within `MAX_CORROBORATION_LINE_DISTANCE`
 * lines in the same scan (SMI-5876 design §4.3, corrected post-implementation —
 * see `CORROBORATING_SIGNALS`' doc comment for the denylist->allowlist fix and
 * the locality-window rationale). Mutates findings in place, mirroring
 * `escalateCodeExecution`'s mutation style (SecurityScanner.exec.ts).
 *
 * MUST run after `escalateCodeExecution` (SecurityScanner.ts's `scan()`) so a
 * freshly-critical `code_execution` finding can itself serve as a
 * corroborator. No feedback loop the other way: `CODE_EXECUTION_CO_OCCURRENCE`
 * (SecurityScanner.exec.ts) contains only `data_exfiltration`,
 * `privilege_escalation`, `sensitive_path`, and `obfuscated_directive` — never
 * `jailbreak` or `ai_defence` — so lifting a mention here can never
 * retroactively change `escalateCodeExecution`'s own decision (verified by
 * reading SecurityScanner.exec.ts directly, SMI-5876 implementation).
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
