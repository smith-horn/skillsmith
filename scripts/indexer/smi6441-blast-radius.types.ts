/**
 * SMI-6441 Wave 2 Step 4 — blast-radius harness row/segment shapes.
 * @module scripts/indexer/smi6441-blast-radius.types
 *
 * Split out of smi6441-blast-radius.ts for the 500-line pre-commit gate
 * (CLAUDE.md § CI Health: "Split into foo.helpers.ts/foo.types.ts if
 * approaching"). Types only — no logic, no imports beyond the scanner's own
 * severity union — so the harness's behaviour lives in exactly one file.
 *
 * This file deliberately carries no direct-entry guard, no shebang and no
 * top-level main() call, so it belongs to none of run-gate-callsites.test.ts's
 * pinned shapes.
 */

import type { SecuritySeverity } from '../../packages/core/src/security/scanner/index.js'

/**
 * One assignment segment the MF-4b veto acted on. `src` distinguishes a value
 * on the finding's own line from one taken via the YAML trailing-bare-key
 * next-line path (value-gate.ts:131) — the shape the plan's C-2 warning is
 * about, and the one a `finding.location`-based reconstruction can never see.
 */
export type VetoSegment = {
  value: string
  src: 'same_line' | 'next_line'
  hits: string[]
}

/**
 * One MEDIUM→HIGH transition, emitted per flip for the Step 4d census.
 * `shapeVerdict` is the hard-abort discriminator: anything other than
 * `two_token_carveout` means the veto acted outside its carve-out.
 */
export interface CensusRow {
  skillId: string
  lineNumber: number
  sourceLine: string
  valueSource: string
  segmentValue: string
  lexiconTokensHit: string[]
  shapeVerdict: 'two_token_carveout' | 'unexplained_shape'
}

/** Per-skill before/after verdicts across all four arms (4a/4b/4c/4d). */
export interface SkillRow {
  skillId: string
  mf4Evaluated: number
  quarantinedBefore: boolean
  quarantinedAfter: boolean
  indexerRiskBefore: number
  indexerRiskAfter: number
  indexerQBefore: boolean
  indexerQAfter: boolean
  codeExecBefore: SecuritySeverity | null
  codeExecAfter: SecuritySeverity | null
  newBlockTiers: string[]
  newRejectTiers: string[]
}
