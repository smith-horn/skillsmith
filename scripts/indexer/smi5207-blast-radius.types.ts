/**
 * SMI-5207 Wave 1 Step 4 — shared types for the 4b/4e blast-radius verifiers.
 * @module scripts/indexer/smi5207-blast-radius.types
 *
 * 4b (smi5207-blast-radius-weekly.ts) replays a population through the
 * CURRENT core weekly-scanner (`SecurityScanner.scan()` +
 * `shouldQuarantine()`) and compares each skill's verdict against a
 * "before" ground truth. 4e (smi5207-blast-radius-transitions.ts) adds a
 * finding-level severity-transition metric on top, specifically attributing
 * `code_execution` critical->medium flips to `sensitive_path` co-signal
 * demotion where that is the actual cause. See each script's own header for
 * the full design rationale — this file only holds the shared shapes.
 *
 * Plan: docs/internal/implementation/smi-5207-sensitive-path-action-context-gating.md
 * — Wave 1 Step 4, sub-steps 4b and 4e. 4a (the existing, unmodified tool
 * this deliberately does NOT touch) is `smi5879-simulate-full.*` in this
 * same directory — a full-population Node-indexer-only replay harness for a
 * different, unrelated investigation (SMI-5879) whose census/generation
 * machinery (`smi5879_run` sealed generations, claim/heartbeat/release) is
 * out of scope for a core-weekly-scanner verifier: see the 4b script's own
 * header for why this population loader is intentionally lighter weight.
 */

import type { ImportedSkill } from '../../packages/core/src/scripts/skill-scanner/types.js'
import type { SecuritySeverity } from '../../packages/core/src/security/scanner/index.js'

/**
 * One population row. Extends the real weekly-scan `ImportedSkill` shape
 * (on the weekly-scan surface, the scanned document IS always exactly
 * `# {name}\n\n{description}` — see the plan's Context section, "Why this
 * over field-provenance tagging") with an optional `beforeQuarantined`
 * ground-truth field.
 *
 * For a REAL corpus run (not this repo's hand-crafted fixtures — see
 * smi5207-blast-radius.fixtures.ts's header for why fixtures were used
 * instead for THIS worker's own verification pass), `beforeQuarantined`
 * should be sourced from a pre-fix artifact captured before this PR's
 * ruleset went live: either (a) a read-only export of the `skills.quarantined`
 * DB column, or (b) a prior `data/quarantine-skills.json` weekly-scan run's
 * skill-ID set. Absent (`undefined`) is a legitimate value — "no ground
 * truth for this row" — and is reported as `unknown_before`, never silently
 * treated as clean or as a pass.
 */
export interface Smi5207PopulationSkill extends ImportedSkill {
  beforeQuarantined?: boolean
}

/** Outcome bucket for one skill's before/after quarantine-verdict comparison (4b). */
export type Smi5207RowOutcome =
  | 'unchanged_quarantined'
  | 'unchanged_clean'
  | 'newly_cleared'
  | 'newly_quarantined'
  | 'unknown_before'

export interface Smi5207WeeklyRow {
  skillId: string
  /** `null` means no ground truth was supplied for this row (`unknown_before`). */
  before: boolean | null
  after: boolean
  afterRiskScore: number
  afterHighestSeverity: SecuritySeverity | null
  outcome: Smi5207RowOutcome
}

export interface Smi5207WeeklyReport {
  reportKind: 'smi5207_blast_radius_weekly'
  generatedAt: string
  scannerRulesetVersion: string
  allowlistPath: string
  allowlistEntryCount: number
  /** Step 4 item 1's explicit allowed-flip list, as resolved for this run. */
  allowedFlipList: string[]
  populationSource: string
  totalScanned: number
  counts: Record<Smi5207RowOutcome, number>
  /** Every `newly_quarantined` row (always a violation) plus every `newly_cleared` row NOT on the allow-list. */
  violations: Smi5207WeeklyRow[]
  rows: Smi5207WeeklyRow[]
}

/** One finding-level severity transition (4e). */
export interface Smi5207FindingTransition {
  skillId: string
  type: string
  lineNumber?: number
  location?: string
  severityBefore: SecuritySeverity
  severityAfter: SecuritySeverity
  messageAfter: string
}

/**
 * A `code_execution` critical->medium flip, with candidate co-signal context
 * for the mandatory hand review (plan Step 4 item 2: "hand-review, not
 * sample, every flip it surfaces").
 */
export interface Smi5207CodeExecFlip {
  skillId: string
  codeExecLineNumber?: number
  codeExecLocation?: string
  codeExecMessageAfter: string
  /**
   * Set by actually re-running the real, unmodified `escalateCodeExecution`
   * against a counterfactual pre-fix findings array (see the 4e script's
   * header) — never inferred from a severity diff alone, which cannot
   * distinguish "sensitive_path stopped qualifying" from "some other
   * co-signal also changed" (it can't, in this fix's scope — but the
   * distinction is proven, not assumed).
   */
  attributedTo: 'sensitive_path_co_signal_demotion' | 'other_or_unattributed'
  coSignalCandidates: Array<{
    type: string
    lineNumber?: number
    location?: string
    severityBefore: SecuritySeverity
    severityAfter: SecuritySeverity
    /** Within the escalation mechanism's own 40-line window — display/triage aid only, not the decision. */
    withinReportingWindow: boolean
  }>
}

export interface Smi5207TransitionsReport {
  reportKind: 'smi5207_blast_radius_transitions'
  generatedAt: string
  populationSource: string
  totalSkills: number
  totalFindingTransitions: number
  findingTransitions: Smi5207FindingTransition[]
  codeExecutionFlips: {
    criticalToMedium: Smi5207CodeExecFlip[]
    count: number
    attributedToSensitivePathCount: number
  }
}
