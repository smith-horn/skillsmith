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
 * The field set here is kept in lock-step with `validateRow`
 * (`smi5879-gate-check.io.ts`), the gate-report-side twin, with ONE deliberate
 * exception: `validateRow` also type-checks `author` and `name`, and this
 * validator does not. That is not an oversight and not a gap — the checkpoint
 * side covers both fields more strongly via
 * `assertCheckpointRowsBelongToGeneration`, which cross-checks every row
 * against the canonical sealed population rather than merely asserting the
 * fields are strings. Every OTHER field belongs in both, and a field added to
 * one belongs in the other in the same change: an asymmetry between the two is
 * exactly the defect class SMI-6481 was filed for.
 *
 * @module scripts/indexer/smi5879-simulate-full.checkpoint-row-shape
 */

import { ALL_SIMULATED_COHORTS, isValidSimRowOutcome } from './smi5879-simulate-full.types.ts'
import type { SimulatedCohort } from './smi5879-simulate-full.types.ts'

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * SMI-6481 (governance round 2, finding F6): per-fragment length cap. `String(v)`
 * had an implicit bound (`'[object Object]'`, 15 chars); `JSON.stringify` has
 * none, so one corrupt field holding a large nested value would serialize in
 * full into the refusal message. The message-count cap in
 * `smi5879-simulate-full.checkpoint.ts` bounds the *count* axis; this bounds
 * the *size* axis of the same message. Same threat model — a hand-edited or
 * corrupt checkpoint.
 */
const MAX_RENDERED_VALUE_CHARS = 200

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
  let rendered: string
  try {
    rendered = JSON.stringify(value) ?? safeToString(value)
  } catch {
    // Circular structure, or a BigInt nested inside an object.
    rendered = safeToString(value)
  }
  return rendered.length > MAX_RENDERED_VALUE_CHARS
    ? `${rendered.slice(0, MAX_RENDERED_VALUE_CHARS)}…`
    : rendered
}

/**
 * SMI-6481 (governance round 2, finding F7): `String(value)` is NOT total —
 * it throws `TypeError: Cannot convert object to primitive value` for a
 * null-prototype object, and propagates anything a custom
 * `toString`/`Symbol.toPrimitive` throws. That would defeat the whole purpose
 * of a fallback inside the error-reporting path. Unreachable from `JSON.parse`
 * today (it produces neither null-prototype nor circular objects — a
 * `"__proto__"` key is created as an own property, not a prototype swap), so
 * this is the same defence-in-depth tier as the `Number.isFinite` tightening,
 * held to that same standard.
 */
function safeToString(value: unknown): string {
  try {
    return String(value)
  } catch {
    return '(unrenderable value)'
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
