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

const isNonNegInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

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
    typeof v.maxSkillsPerRepo === 'string' && /^\d+$/.test(v.maxSkillsPerRepo),
    'a string of digits'
  )
  need(
    'pathPrefix',
    typeof v.pathPrefix === 'string' && !/[\r\n]/.test(v.pathPrefix),
    'a single-line string'
  )
  for (const k of ['maxRanges', 'minSizeBytes', 'maxSkillsPerDispatch', 'maxElapsedMinutes']) {
    need(k, isNonNegInt(v[k]), 'a non-negative integer')
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
