/**
 * Canonical-JSON + digest helpers for the G-1 bulk-disposition mechanism
 * (SMI-6444). Shared between the producer (`smi5879-dispose-terminal.ts`,
 * which stages and signs `DispositionBatch` records) and gate-check (which
 * re-verifies them) — two independent implementations of the same
 * serialization would drift. Node `crypto` only, no new dependency.
 * @module scripts/indexer/smi5879-disposition-digest
 *
 * Plan: docs/internal/implementation/smi-6444-g1-bulk-disposition-plan.md
 *   Item 4 (sign-off as a real checkpoint) — this file is exactly its "New
 *   shared module" code block: `canonicalJsonStringify`, `computeStageDigest`,
 *   `confirmationCodeFor`.
 */

import { createHash } from 'node:crypto'
import type { DispositionBatch } from './smi5879-gate-check.types.ts'

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

/**
 * Canonical JSON serialization: object keys sorted by UTF-16 code-unit
 * order (plain `<`/`>` string comparison on JS strings already compares by
 * UTF-16 code unit, not code point — exactly what's specified), no
 * whitespace. Every id-list field in this schema is validator-enforced to
 * already be sorted-and-deduplicated in the data itself (Item 7), so array
 * element ORDER is never independently re-sorted here — only object keys are.
 *
 * `undefined` must never appear as an object value passed in here — every
 * digest-covered optional field is omitted entirely when absent, never
 * serialized as `null` (Item 4). A bare `undefined` found inside an object
 * throws rather than silently omitting the key, so a caller who forgot to
 * drop an absent field fails loudly instead of producing a digest that
 * quietly covers less than it appears to.
 */
export function canonicalJsonStringify(value: JsonValue): string {
  if (value === null) return 'null'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`canonicalJsonStringify: non-finite number ${value}`)
    }
    return JSON.stringify(value)
  }
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJsonStringify(v)).join(',')}]`
  const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const parts: string[] = []
  for (const key of keys) {
    const entryValue = value[key]
    if (entryValue === undefined) {
      throw new Error(
        `canonicalJsonStringify: key "${key}" has value undefined — omit it from the object entirely instead of setting it to undefined`
      )
    }
    parts.push(`${JSON.stringify(key)}:${canonicalJsonStringify(entryValue)}`)
  }
  return `{${parts.join(',')}}`
}

/**
 * SHA-256 over the sorted, newline-joined entry-id set. Exported (SMI-6444
 * follow-up) so `smi5879-dispose-terminal.ledger.helpers.ts`'s own
 * `computeEntryIdsDigest` — previously a byte-identical private duplicate —
 * imports this one instead of re-implementing it; the two computations must
 * never drift, since a batch's stored `entry_ids_digest` (produced by the
 * ledger helper) is exactly what {@link computeStageDigest} below recomputes
 * internally via this same function at both staging and re-verification time.
 */
export function computeEntryIdsDigest(entryIds: readonly string[]): string {
  const sorted = [...entryIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return createHash('sha256').update(sorted.join('\n')).digest('hex')
}

/**
 * Every `DispositionBatch` field `computeStageDigest` covers, i.e. every
 * field EXCEPT `signed_off_by`/`signed_off_at`/`sign_off_digest`/
 * `stage_digest`/`revoked`/`sign_off_revocations` and `entry_ids_digest`
 * itself (recomputed fresh below, never copied from the batch). Declared as
 * a `Record<DigestCoveredKey, true>` literal, not a plain string array, so
 * that adding/renaming a `DispositionBatch` field that should be
 * digest-covered (or excluded) is a COMPILE ERROR here, not a silent drift
 * from Item 4's "covers every field except these six" spec.
 */
type DigestCoveredKey = Exclude<
  keyof DispositionBatch,
  | 'signed_off_by'
  | 'signed_off_at'
  | 'sign_off_digest'
  | 'stage_digest'
  | 'revoked'
  | 'sign_off_revocations'
  | 'entry_ids_digest'
>

const DIGEST_COVERED_FIELD_MAP: Record<DigestCoveredKey, true> = {
  schema_version: true,
  batch_id: true,
  outcome_class: true,
  run_id: true,
  reason: true,
  tool_commit: true,
  tool_source_digest: true,
  population_count: true,
  population_cohort_counts: true,
  subtype_counts: true,
  confidence_pct: true,
  mismatch_threshold_bp: true,
  stratum_threshold_bp: true,
  design_point_bad_draws_per_stratum: true,
  allocation: true,
  sampling_seed: true,
  strata: true,
  verified_count: true,
  observed_population_upper_bound_bp: true,
  verified_at: true,
  staged_at: true,
  entry_count: true,
}

const DIGEST_COVERED_FIELDS = Object.keys(DIGEST_COVERED_FIELD_MAP) as DigestCoveredKey[]

function buildStageDigestPayload(
  batch: DispositionBatch,
  entryIdsForBatch: readonly string[]
): Record<string, JsonValue> {
  const payload: Record<string, JsonValue> = {}
  for (const field of DIGEST_COVERED_FIELDS) {
    const value = batch[field]
    if (value === undefined) continue
    // Every DigestCoveredKey's value type is a plain JSON string/number/
    // array-of-strings/record-of-numbers/array-of-stratum-objects shape --
    // all structurally JsonValue-compatible, verified by DispositionBatch's
    // own type definition. `unknown` first, since the union of possible
    // per-field value types doesn't directly overlap JsonValue in TS's eyes.
    payload[field] = value as unknown as JsonValue
  }
  // entry_ids_digest is computed fresh from the caller's OWN independently-
  // derived entryIdsForBatch, never copied from batch.entry_ids_digest --
  // this is what lets gate-check's re-verification catch entry-membership
  // tampering rather than trusting whatever digest is stored in the file.
  payload['entry_ids_digest'] = computeEntryIdsDigest(entryIdsForBatch)
  return payload
}

/**
 * SHA-256 over the canonical JSON of every digest-covered `DispositionBatch`
 * field (see {@link DIGEST_COVERED_FIELD_MAP}), with `entry_ids_digest`
 * recomputed from `entryIdsForBatch` rather than trusted from `batch` — so
 * changing ANY staged fact (statistical parameters, sample membership, batch
 * metadata) invalidates a prior sign-off, while lifecycle/revocation
 * metadata (added after staging) is deliberately excluded, since it
 * describes what happened TO the batch after staging, not a staged fact
 * about it.
 */
export function computeStageDigest(
  batch: DispositionBatch,
  entryIdsForBatch: readonly string[]
): string {
  const payload = buildStageDigestPayload(batch, entryIdsForBatch)
  return createHash('sha256').update(canonicalJsonStringify(payload)).digest('hex')
}

/**
 * The confirmation code a `sign-off` invocation must be given back
 * (`--confirm=<code>`) to actually write a sign-off — forces the signing
 * invocation to reference the CURRENTLY staged content: a code copied from a
 * stale run, a different batch, or ledger state that's since changed fails
 * closed, deterministically and testably (Item 4).
 */
export function confirmationCodeFor(stageDigest: string): string {
  return stageDigest.slice(0, 12)
}
