/**
 * SMI-7112: runtime validation of a recovered `dispatch_inputs` value against
 * the `workflow_dispatch` input definitions in
 * `.github/workflows/indexer-backfill.yml` (the schema these values are
 * replayed into).
 * @module scripts/indexer/backfill-dispatch-inputs.validate
 */

import type { BackfillDispatchInputs } from './backfill-dispatch-inputs.ts'

/** A recovered `dispatch_inputs` object does not satisfy the workflow_dispatch schema. */
export class MalformedDispatchInputs extends Error {
  constructor(detail: string) {
    super(`Malformed dispatch_inputs: ${detail}`)
    this.name = 'MalformedDispatchInputs'
  }
}

/**
 * Parity with the real execution path, deliberately NOT stricter. The workflow
 * declares every numeric input as `type: string`, and `getInt()` in
 * `parse-env.ts` accepts whatever `Number(raw)` finds finite (fractions,
 * negatives, exponents, hex), treating only an empty string as "use the
 * default". A recovered value the original dispatch ran with must therefore
 * never be rejected on recovery, or the chain strands on an input that already
 * ran. JSON cannot carry NaN or Infinity, so `Number.isFinite` is the whole test.
 */
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** The workflow-input string form of {@link isFiniteNumber}: `getInt()`'s test, plus single-line. */
const isNumericInputString = (v: unknown): v is string =>
  typeof v === 'string' && !/[\r\n]/.test(v) && (v === '' || Number.isFinite(Number(v)))

/**
 * TypeScript types are erased at the JSONB boundary, so a truthy-but-wrong
 * object (`{}`, a number where a string belongs, an out-of-enum env) would
 * otherwise reach `gh workflow run` as `"undefined"` or an invalid value.
 * Throws {@link MalformedDispatchInputs}.
 */
export function validateDispatchInputs(value: unknown): BackfillDispatchInputs {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MalformedDispatchInputs('not an object')
  }
  const v = value as Record<string, unknown>
  const need = (key: string, ok: boolean, shape: string): void => {
    if (!(key in v)) throw new MalformedDispatchInputs(`missing required key '${key}'`)
    if (!ok) throw new MalformedDispatchInputs(`'${key}' must be ${shape}`)
  }
  need(
    'maxSkillsPerRepo',
    isNumericInputString(v.maxSkillsPerRepo),
    'a single-line string that parses as a finite number'
  )
  need(
    'pathPrefix',
    typeof v.pathPrefix === 'string' && !/[\r\n]/.test(v.pathPrefix),
    'a single-line string'
  )
  for (const k of ['maxRanges', 'minSizeBytes', 'maxSkillsPerDispatch', 'maxElapsedMinutes']) {
    need(k, isFiniteNumber(v[k]), 'a finite number')
  }
  need('acceptTruncation', typeof v.acceptTruncation === 'boolean', 'a boolean')
  need(
    'supabaseEnv',
    v.supabaseEnv === 'prod' || v.supabaseEnv === 'staging',
    "'prod' or 'staging'"
  )
  need(
    'tokenSource',
    v.tokenSource === 'backfill' || v.tokenSource === 'fallback',
    "'backfill' or 'fallback'"
  )
  return v as unknown as BackfillDispatchInputs
}
