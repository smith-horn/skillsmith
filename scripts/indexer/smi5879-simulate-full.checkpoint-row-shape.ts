/**
 * SMI-6481: per-row runtime shape validation for a checkpoint's
 * `row_results`, split out of `smi5879-simulate-full.checkpoint.ts` (which
 * sat at 493/500 lines once the SMI-6481 type checks landed — the next
 * addition would have tripped the blocking pre-commit gate).
 *
 * Why this exists at all: the coherence guards
 * (`smi5879-merge-shards.outcome-coherence.ts`) test field PRESENCE with
 * `!== undefined` and then read the quarantine pair through truthiness. That
 * is fail-OPEN against a hand-edited checkpoint: a `bundle_absent` row
 * carrying `prePortQuarantine: null, postPortQuarantine: null` (or two equal
 * strings) satisfies both the pair-presence check and
 * `expectedVerdictDeltaOutcome`, so the poisoned row loads clean and the
 * checkpoint refusal this issue added never fires. Type-checking at load is
 * what makes that refusal actually closed.
 *
 * The field set here is kept deliberately in lock-step with `validateRow`
 * (`smi5879-gate-check.io.ts`), the gate-report-side twin. An asymmetry
 * between the two is exactly the defect class SMI-6481 was filed for, so a
 * field added to one belongs in the other in the same change.
 *
 * @module scripts/indexer/smi5879-simulate-full.checkpoint-row-shape
 */

import { ALL_SIMULATED_COHORTS, isValidSimRowOutcome } from './smi5879-simulate-full.types.ts'
import type { SimulatedCohort } from './smi5879-simulate-full.types.ts'

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Render a rejected value legibly in an error message. A bare `String(v)`
 * (the original) collapses `{}` to `[object Object]` and `[]` to the empty
 * string, which makes a corrupt-checkpoint report unreadable at exactly the
 * moment an operator needs it. Numbers stay bare so `NaN`/`Infinity` read
 * naturally; strings are quoted so `"true"` is visibly distinct from the
 * boolean `true` — the whole point of these checks.
 */
export function describeValue(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    // Circular structure, or a BigInt nested inside an object — either way a
    // legible fallback beats throwing from inside the error-reporting path.
    return String(value)
  }
}

/** The scored-field pairs `processRow` only ever sets as a unit. */
const BOOLEAN_FIELDS = ['prePortQuarantine', 'postPortQuarantine'] as const
const FINITE_NUMBER_FIELDS = ['prePortRiskScore', 'postPortRiskScore'] as const
const VALID_UNFETCHABLE_SUBTYPES = ['url_parse', 'branch_resolution'] as const

/**
 * Validate one `row_results` entry, returning zero or more human-readable
 * error fragments (never throws — the caller aggregates across all rows so a
 * corrupt checkpoint reports every problem at once, not one per re-run).
 */
export function validateCheckpointRowShape(id: string, rawResult: unknown): string[] {
  if (!isPlainObject(rawResult)) return [`row_results.${id} (not an object)`]

  const errors: string[] = []
  const at = (field: string) => `row_results.${id}.${field}`

  if (typeof rawResult['id'] !== 'string') errors.push(at('id'))

  const cohort = rawResult['cohort']
  if (typeof cohort !== 'string' || !ALL_SIMULATED_COHORTS.includes(cohort as SimulatedCohort)) {
    errors.push(`${at('cohort')}=${describeValue(cohort)}`)
  }

  const outcome = rawResult['outcome']
  if (!isValidSimRowOutcome(outcome)) {
    errors.push(`${at('outcome')}=${describeValue(outcome)}`)
  }

  for (const field of BOOLEAN_FIELDS) {
    const v = rawResult[field]
    if (v !== undefined && typeof v !== 'boolean') {
      errors.push(`${at(field)}=${describeValue(v)} (must be a boolean when present)`)
    }
  }

  for (const field of FINITE_NUMBER_FIELDS) {
    const v = rawResult[field]
    if (v !== undefined && !Number.isFinite(v)) {
      errors.push(`${at(field)}=${describeValue(v)} (must be a finite number when present)`)
    }
  }

  // Both of the following mirror `validateRow` (`smi5879-gate-check.io.ts`).
  // They are defence-in-depth here — a bad value is also caught at the
  // report-load boundary — but leaving them out would preserve the very
  // checkpoint-vs-gate asymmetry this issue exists to remove.
  const reason = rawResult['reason']
  if (reason !== undefined && typeof reason !== 'string') {
    errors.push(`${at('reason')}=${describeValue(reason)} (must be a string when present)`)
  }

  const subtype = rawResult['unfetchable_subtype']
  if (
    subtype !== undefined &&
    !(VALID_UNFETCHABLE_SUBTYPES as readonly unknown[]).includes(subtype)
  ) {
    errors.push(
      `${at('unfetchable_subtype')}=${describeValue(subtype)} ` +
        `(must be one of ${VALID_UNFETCHABLE_SUBTYPES.join('/')} when present)`
    )
  }

  return errors
}
