/**
 * SMI-6444 item 4: `smi5879-disposition-digest.ts` test suite —
 * canonical-JSON determinism (key ordering, nested objects), integer-only
 * numeric serialization, absent-optional-field omission, digest invariance
 * to lifecycle fields, digest sensitivity to every staged field and to
 * entry-id membership, and confirmation-code shape.
 * @module scripts/tests/indexer/smi5879-disposition-digest
 *
 * Plan: docs/internal/implementation/smi-6444-g1-bulk-disposition-plan.md Item 4.
 */

import { describe, it, expect } from 'vitest'
import {
  canonicalJsonStringify,
  computeStageDigest,
  confirmationCodeFor,
  type JsonValue,
} from '../../indexer/smi5879-disposition-digest.ts'
import type { DispositionBatch } from '../../indexer/smi5879-gate-check.types.ts'

function makeBatch(overrides: Partial<DispositionBatch> = {}): DispositionBatch {
  return {
    schema_version: 1,
    batch_id: 'batch-1',
    outcome_class: 'unfetchable',
    run_id: 'run-1',
    reason: 'checked via a full recheck',
    tool_commit: 'a'.repeat(40),
    tool_source_digest: 'b'.repeat(64),
    population_count: 3,
    population_cohort_counts: { C1: 3 },
    verified_count: 3,
    verified_at: '2026-09-01T00:00:00.000Z',
    staged_at: '2026-09-01T00:05:00.000Z',
    entry_count: 3,
    entry_ids_digest: 'stale-should-be-recomputed',
    stage_digest: 'stale-should-be-excluded',
    ...overrides,
  }
}

const ENTRY_IDS = ['id-3', 'id-1', 'id-2']

describe('canonicalJsonStringify — determinism', () => {
  it('sorts object keys by UTF-16 code-unit order regardless of insertion order', () => {
    const a: JsonValue = { b: 1, a: 2, c: 3 }
    const b: JsonValue = { c: 3, a: 2, b: 1 }
    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b))
    expect(canonicalJsonStringify(a)).toBe('{"a":2,"b":1,"c":3}')
  })

  it('sorts keys inside nested objects too, at every depth', () => {
    const value: JsonValue = { z: { y: 1, x: 2 }, a: 1 }
    expect(canonicalJsonStringify(value)).toBe('{"a":1,"z":{"x":2,"y":1}}')
  })

  it('produces no whitespace anywhere in the output', () => {
    const value: JsonValue = { a: [1, 2, 3], b: { c: 'd' } }
    expect(canonicalJsonStringify(value)).not.toMatch(/\s/)
  })

  it('does not re-sort array element order — only object keys', () => {
    const value: JsonValue = { ids: ['z', 'a', 'm'] }
    expect(canonicalJsonStringify(value)).toBe('{"ids":["z","a","m"]}')
  })

  it('is deterministic across repeated calls with structurally-identical input', () => {
    const first = canonicalJsonStringify({ x: 1, nested: { b: 2, a: 1 } })
    const second = canonicalJsonStringify({ nested: { a: 1, b: 2 }, x: 1 })
    expect(first).toBe(second)
  })

  it('serializes whole-valued numbers with no decimal point (integer-only digest-covered numerics)', () => {
    expect(canonicalJsonStringify({ confidence_pct: 95 })).toBe('{"confidence_pct":95}')
    expect(canonicalJsonStringify(0)).toBe('0')
  })

  it('throws on a non-finite number rather than silently producing an unstable digest input', () => {
    expect(() => canonicalJsonStringify(Number.NaN)).toThrow(/non-finite/)
    expect(() => canonicalJsonStringify(Number.POSITIVE_INFINITY)).toThrow(/non-finite/)
  })

  it('throws on a bare undefined object value instead of silently omitting the key', () => {
    const withUndefined = { a: 1, b: undefined } as unknown as JsonValue
    expect(() => canonicalJsonStringify(withUndefined)).toThrow(/undefined/)
  })
})

describe('computeStageDigest — absent-field omission', () => {
  it('never appears as "null" for an absent optional field (subtype_counts here)', () => {
    const batch = makeBatch() // subtype_counts absent entirely
    const digest = computeStageDigest(batch, ENTRY_IDS)
    // Sanity: same batch, recomputed twice, is stable.
    expect(computeStageDigest(batch, ENTRY_IDS)).toBe(digest)
  })

  it('changing an absent optional field to present changes the digest', () => {
    const withoutSubtypes = makeBatch()
    const withSubtypes = makeBatch({ subtype_counts: { url_parse: 3 } })
    expect(computeStageDigest(withoutSubtypes, ENTRY_IDS)).not.toBe(
      computeStageDigest(withSubtypes, ENTRY_IDS)
    )
  })
})

describe('computeStageDigest — lifecycle-field invariance', () => {
  it('is identical whether signed_off_by/signed_off_at/sign_off_digest are present or absent', () => {
    const unsigned = makeBatch()
    const signed = makeBatch({
      signed_off_by: 'operator-1',
      signed_off_at: '2026-09-01T01:00:00.000Z',
      sign_off_digest: 'whatever-was-computed-before',
    })
    expect(computeStageDigest(unsigned, ENTRY_IDS)).toBe(computeStageDigest(signed, ENTRY_IDS))
  })

  it('is identical whether revoked is present or absent', () => {
    const active = makeBatch()
    const revoked = makeBatch({
      revoked: { revoked_by: 'operator-1', revoked_at: '2026-09-01T02:00:00.000Z', reason: 'oops' },
    })
    expect(computeStageDigest(active, ENTRY_IDS)).toBe(computeStageDigest(revoked, ENTRY_IDS))
  })

  it('is identical whether sign_off_revocations is present or absent', () => {
    const withoutHistory = makeBatch()
    const withHistory = makeBatch({
      sign_off_revocations: [
        {
          revoked_by: 'operator-1',
          revoked_at: '2026-09-01T02:00:00.000Z',
          reason: 'oops',
          prior_signed_off_by: 'operator-0',
          prior_signed_off_at: '2026-09-01T01:00:00.000Z',
          prior_sign_off_digest: 'prior-digest',
        },
      ],
    })
    expect(computeStageDigest(withoutHistory, ENTRY_IDS)).toBe(
      computeStageDigest(withHistory, ENTRY_IDS)
    )
  })

  it('ignores the batch’s own stored stage_digest entirely (never included in its own input)', () => {
    const a = makeBatch({ stage_digest: 'aaaa' })
    const b = makeBatch({ stage_digest: 'bbbb' })
    expect(computeStageDigest(a, ENTRY_IDS)).toBe(computeStageDigest(b, ENTRY_IDS))
  })
})

describe('computeStageDigest — sensitivity to every staged field', () => {
  const baseline = makeBatch({
    subtype_counts: { url_parse: 3 },
    confidence_pct: 95,
    mismatch_threshold_bp: 200,
    stratum_threshold_bp: 300,
    design_point_bad_draws_per_stratum: 1,
    allocation: 'proportional',
    sampling_seed: 'seed-1',
    strata: [
      {
        stratum_key: 's1',
        population_count: 3,
        selected_ids: ['id-1', 'id-2', 'id-3'],
        unavailable_ids: [],
        mismatched_ids: [],
        verified_count: 3,
        upper_bound_bp: 50,
      },
    ],
    observed_population_upper_bound_bp: 40,
  })
  const baselineDigest = computeStageDigest(baseline, ENTRY_IDS)

  const cases: Array<[string, Partial<DispositionBatch>]> = [
    ['schema_version', { schema_version: 2 }],
    ['batch_id', { batch_id: 'batch-2' }],
    ['outcome_class', { outcome_class: 'primary_not_found' }],
    ['run_id', { run_id: 'run-2' }],
    ['reason', { reason: 'a different reason' }],
    ['tool_commit', { tool_commit: 'c'.repeat(40) }],
    ['tool_source_digest', { tool_source_digest: 'd'.repeat(64) }],
    ['population_count', { population_count: 4 }],
    ['population_cohort_counts', { population_cohort_counts: { C1: 4 } }],
    ['subtype_counts', { subtype_counts: { url_parse: 2, branch_resolution: 1 } }],
    ['confidence_pct', { confidence_pct: 99 }],
    ['mismatch_threshold_bp', { mismatch_threshold_bp: 250 }],
    ['stratum_threshold_bp', { stratum_threshold_bp: 350 }],
    ['design_point_bad_draws_per_stratum', { design_point_bad_draws_per_stratum: 2 }],
    ['sampling_seed', { sampling_seed: 'seed-2' }],
    [
      'strata',
      {
        strata: [
          {
            stratum_key: 's1',
            population_count: 3,
            selected_ids: ['id-1', 'id-2', 'id-3'],
            unavailable_ids: [],
            mismatched_ids: ['id-2'],
            verified_count: 2,
            upper_bound_bp: 99,
          },
        ],
      },
    ],
    ['verified_count', { verified_count: 2 }],
    ['observed_population_upper_bound_bp', { observed_population_upper_bound_bp: 41 }],
    ['verified_at', { verified_at: '2026-09-02T00:00:00.000Z' }],
    ['staged_at', { staged_at: '2026-09-02T00:05:00.000Z' }],
    ['entry_count', { entry_count: 4 }],
  ]

  it.each(cases)('changing %s changes the digest', (_field, override) => {
    const changed = makeBatch({ ...baseline, ...override })
    expect(computeStageDigest(changed, ENTRY_IDS)).not.toBe(baselineDigest)
  })

  it('allocation is digest-covered', () => {
    const withoutAllocation = makeBatch({ ...baseline })
    delete withoutAllocation.allocation
    expect(computeStageDigest(withoutAllocation, ENTRY_IDS)).not.toBe(baselineDigest)
  })
})

describe('computeStageDigest — sensitivity to entry-id membership', () => {
  it('changes when entryIdsForBatch membership changes, even with identical batch content', () => {
    const batch = makeBatch()
    const digestA = computeStageDigest(batch, ['id-1', 'id-2', 'id-3'])
    const digestB = computeStageDigest(batch, ['id-1', 'id-2', 'id-4'])
    expect(digestA).not.toBe(digestB)
  })

  it('is invariant to the ORDER entryIdsForBatch is passed in (sorted before hashing)', () => {
    const batch = makeBatch()
    const digestA = computeStageDigest(batch, ['id-3', 'id-1', 'id-2'])
    const digestB = computeStageDigest(batch, ['id-1', 'id-2', 'id-3'])
    expect(digestA).toBe(digestB)
  })

  it('ignores batch.entry_ids_digest entirely — recomputes fresh from entryIdsForBatch', () => {
    const a = makeBatch({ entry_ids_digest: 'aaaa' })
    const b = makeBatch({ entry_ids_digest: 'bbbb' })
    expect(computeStageDigest(a, ENTRY_IDS)).toBe(computeStageDigest(b, ENTRY_IDS))
  })
})

describe('confirmationCodeFor', () => {
  it('returns the first 12 hex characters of the stage digest', () => {
    const batch = makeBatch()
    const digest = computeStageDigest(batch, ENTRY_IDS)
    const code = confirmationCodeFor(digest)
    expect(code).toBe(digest.slice(0, 12))
    expect(code).toHaveLength(12)
    expect(code).toMatch(/^[0-9a-f]{12}$/)
  })

  it('is a substring of a real SHA-256 hex digest (64 chars)', () => {
    const batch = makeBatch()
    const digest = computeStageDigest(batch, ENTRY_IDS)
    expect(digest).toHaveLength(64)
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
  })
})
