/**
 * `DispositionBatch`/`DispositionBatchStratum` shape parsing — split out of
 * `smi5879-gate-check.ledger-validation.ts` purely for the file-length
 * policy's 500-line cap (the batch schema's field count and accounting
 * invariants alone push past it). Imported by `ledger-validation.ts`, which
 * owns the rest of `Smi5879DispositionLedger`'s shape (entries, batch_id
 * uniqueness, cross-entry/batch checks).
 * @module scripts/indexer/smi5879-gate-check.disposition-batch
 *
 * Plan: docs/internal/implementation/smi-6444-g1-bulk-disposition-plan.md
 *   Item 3 (schema) and Item 7 (validation rules) — every accounting
 *   invariant, sort/no-duplicate rule, and revocation shape rule Item 7
 *   states for a single `DispositionBatch` lives here; ledger-wide rules
 *   (batch_id uniqueness across `batches`, entry/batch cross-checks) live in
 *   `ledger-validation.ts`, which has both arrays in scope.
 */

import {
  type Field,
  isDisjoint,
  isPlainObject,
  isSubset,
  optField,
  parseRevocationInfo,
  reqCountRecord,
  reqIdList,
  reqIso8601,
  reqNonNegInt,
  reqOneOf,
  reqString,
} from './smi5879-gate-check.field-parsers.ts'
import type {
  DispositionBatch,
  DispositionBatchStratum,
  SignOffRevocationEvent,
} from './smi5879-gate-check.types.ts'

const VALID_OUTCOME_CLASSES = ['unfetchable', 'primary_not_found'] as const

function parseStratum(raw: unknown, label: string): Field<DispositionBatchStratum> {
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object` }
  const stratumKey = reqString(raw['stratum_key'], `${label}.stratum_key`)
  if (!stratumKey.ok) return stratumKey
  const populationCount = reqNonNegInt(raw['population_count'], `${label}.population_count`)
  if (!populationCount.ok) return populationCount
  const selectedIds = reqIdList(raw['selected_ids'], `${label}.selected_ids`)
  if (!selectedIds.ok) return selectedIds
  const unavailableIds = reqIdList(raw['unavailable_ids'], `${label}.unavailable_ids`)
  if (!unavailableIds.ok) return unavailableIds
  const mismatchedIds = reqIdList(raw['mismatched_ids'], `${label}.mismatched_ids`)
  if (!mismatchedIds.ok) return mismatchedIds
  const verifiedCount = reqNonNegInt(raw['verified_count'], `${label}.verified_count`)
  if (!verifiedCount.ok) return verifiedCount
  const upperBoundBp = reqNonNegInt(raw['upper_bound_bp'], `${label}.upper_bound_bp`)
  if (!upperBoundBp.ok) return upperBoundBp

  if (!isSubset(unavailableIds.value, selectedIds.value)) {
    return { ok: false, reason: `${label}: unavailable_ids must be a subset of selected_ids` }
  }
  if (!isSubset(mismatchedIds.value, selectedIds.value)) {
    return { ok: false, reason: `${label}: mismatched_ids must be a subset of selected_ids` }
  }
  if (!isDisjoint(unavailableIds.value, mismatchedIds.value)) {
    return { ok: false, reason: `${label}: unavailable_ids and mismatched_ids must be disjoint` }
  }
  const sum = verifiedCount.value + mismatchedIds.value.length + unavailableIds.value.length
  if (sum !== selectedIds.value.length) {
    return {
      ok: false,
      reason:
        `${label}: verified_count + |mismatched_ids| + |unavailable_ids| (${sum}) must equal ` +
        `|selected_ids| (${selectedIds.value.length})`,
    }
  }
  return {
    ok: true,
    value: {
      stratum_key: stratumKey.value,
      population_count: populationCount.value,
      selected_ids: selectedIds.value,
      unavailable_ids: unavailableIds.value,
      mismatched_ids: mismatchedIds.value,
      verified_count: verifiedCount.value,
      upper_bound_bp: upperBoundBp.value,
    },
  }
}

function parseSignOffRevocationEvent(raw: unknown, label: string): Field<SignOffRevocationEvent> {
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object` }
  const revokedBy = reqString(raw['revoked_by'], `${label}.revoked_by`)
  if (!revokedBy.ok) return revokedBy
  const revokedAt = reqIso8601(raw['revoked_at'], `${label}.revoked_at`)
  if (!revokedAt.ok) return revokedAt
  const reason = reqString(raw['reason'], `${label}.reason`)
  if (!reason.ok) return reason
  const priorBy = reqString(raw['prior_signed_off_by'], `${label}.prior_signed_off_by`)
  if (!priorBy.ok) return priorBy
  const priorAt = reqIso8601(raw['prior_signed_off_at'], `${label}.prior_signed_off_at`)
  if (!priorAt.ok) return priorAt
  const priorDigest = reqString(raw['prior_sign_off_digest'], `${label}.prior_sign_off_digest`)
  if (!priorDigest.ok) return priorDigest
  return {
    ok: true,
    value: {
      revoked_by: revokedBy.value,
      revoked_at: revokedAt.value,
      reason: reason.value,
      prior_signed_off_by: priorBy.value,
      prior_signed_off_at: priorAt.value,
      prior_sign_off_digest: priorDigest.value,
    },
  }
}

/** Sum of `strata[]`'s count-shaped fields, computed once and reused by
 *  every aggregate accounting-invariant check below (Item 7). */
interface StrataTotals {
  population: number
  selected: number
  verified: number
  mismatched: number
  unavailable: number
}

function sumStrata(strata: readonly DispositionBatchStratum[]): StrataTotals {
  return strata.reduce(
    (acc, s) => ({
      population: acc.population + s.population_count,
      selected: acc.selected + s.selected_ids.length,
      verified: acc.verified + s.verified_count,
      mismatched: acc.mismatched + s.mismatched_ids.length,
      unavailable: acc.unavailable + s.unavailable_ids.length,
    }),
    { population: 0, selected: 0, verified: 0, mismatched: 0, unavailable: 0 }
  )
}

/**
 * Aggregate accounting invariants (Item 7): `population_count` consistency
 * with the strata arrays, plus `unfetchable`'s "no transient-failure mode"
 * rule. Only checkable when `strata` is present — `strata` is optional on
 * the type, and there's nothing to cross-check against without it.
 *
 * `entry_count` is deliberately NOT cross-checked against strata here
 * (queen review correction, SMI-6444): `Σ strata[].verified_count` is a
 * SAMPLE-level count, but `entry_count` covers the actual ledger entries
 * this batch generated — for `unfetchable`'s full-census batches those
 * coincide (every row is both selected and, modulo mismatch/unavailable,
 * verified), but for a sampled `primary_not_found` batch the two are
 * unrelated: staging writes entries for the WHOLE population this batch
 * covers minus mismatched/unavailable/already-active-skipped rows (Item 8),
 * not one entry per SAMPLED row. `entry_count` is instead validated against
 * the ledger's own `entries` array at the whole-ledger level (this file has
 * no access to `entries`, only a single batch) — see
 * `checkEntryBatchCrossReferences` in smi5879-gate-check.ledger-validation.ts.
 */
function checkAggregateInvariants(
  strata: readonly DispositionBatchStratum[],
  populationCount: number,
  verifiedCount: number,
  outcomeClass: DispositionBatch['outcome_class'],
  label: string
): { ok: true } | { ok: false; reason: string } {
  const totals = sumStrata(strata)
  if (totals.population !== populationCount) {
    return {
      ok: false,
      reason: `${label}.population_count (${populationCount}) must equal the sum of strata[].population_count (${totals.population})`,
    }
  }
  if (totals.verified !== verifiedCount) {
    return {
      ok: false,
      reason: `${label}.verified_count (${verifiedCount}) must equal the sum of strata[].verified_count (${totals.verified})`,
    }
  }
  if (totals.verified + totals.mismatched + totals.unavailable !== totals.selected) {
    return {
      ok: false,
      reason:
        `${label}: aggregate verified_count + |mismatched_ids| + |unavailable_ids| must equal ` +
        `|selected_ids| across all strata`,
    }
  }
  if (outcomeClass === 'unfetchable') {
    for (const [i, s] of strata.entries()) {
      if (s.unavailable_ids.length > 0) {
        return {
          ok: false,
          reason: `${label}.strata[${i}]: unfetchable batches must have empty unavailable_ids (no local check has a transient-failure mode)`,
        }
      }
    }
  }
  return { ok: true }
}

export function parseDispositionBatch(raw: unknown, index: number): Field<DispositionBatch> {
  const label = `batches[${index}]`
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object` }

  const schemaVersion = reqNonNegInt(raw['schema_version'], `${label}.schema_version`)
  if (!schemaVersion.ok) return schemaVersion
  if (schemaVersion.value < 1) return { ok: false, reason: `${label}.schema_version must be >= 1` }
  const batchId = reqString(raw['batch_id'], `${label}.batch_id`)
  if (!batchId.ok) return batchId
  const outcomeClass = reqOneOf(
    raw['outcome_class'],
    VALID_OUTCOME_CLASSES,
    `${label}.outcome_class`
  )
  if (!outcomeClass.ok) return outcomeClass
  const runId = reqString(raw['run_id'], `${label}.run_id`)
  if (!runId.ok) return runId
  const reason = reqString(raw['reason'], `${label}.reason`)
  if (!reason.ok) return reason
  const toolCommit = reqString(raw['tool_commit'], `${label}.tool_commit`)
  if (!toolCommit.ok) return toolCommit
  const toolSourceDigest = reqString(raw['tool_source_digest'], `${label}.tool_source_digest`)
  if (!toolSourceDigest.ok) return toolSourceDigest
  const populationCount = reqNonNegInt(raw['population_count'], `${label}.population_count`)
  if (!populationCount.ok) return populationCount
  const populationCohortCounts = reqCountRecord(
    raw['population_cohort_counts'],
    `${label}.population_cohort_counts`
  )
  if (!populationCohortCounts.ok) return populationCohortCounts
  const subtypeCounts = optField(raw['subtype_counts'], reqCountRecord, `${label}.subtype_counts`)
  if (!subtypeCounts.ok) return subtypeCounts
  const confidencePct = optField(raw['confidence_pct'], reqNonNegInt, `${label}.confidence_pct`)
  if (!confidencePct.ok) return confidencePct
  const mismatchThresholdBp = optField(
    raw['mismatch_threshold_bp'],
    reqNonNegInt,
    `${label}.mismatch_threshold_bp`
  )
  if (!mismatchThresholdBp.ok) return mismatchThresholdBp
  const stratumThresholdBp = optField(
    raw['stratum_threshold_bp'],
    reqNonNegInt,
    `${label}.stratum_threshold_bp`
  )
  if (!stratumThresholdBp.ok) return stratumThresholdBp
  const designPointBadDraws = optField(
    raw['design_point_bad_draws_per_stratum'],
    reqNonNegInt,
    `${label}.design_point_bad_draws_per_stratum`
  )
  if (!designPointBadDraws.ok) return designPointBadDraws
  const observedPopulationUpperBoundBp = optField(
    raw['observed_population_upper_bound_bp'],
    reqNonNegInt,
    `${label}.observed_population_upper_bound_bp`
  )
  if (!observedPopulationUpperBoundBp.ok) return observedPopulationUpperBoundBp
  const allocation = optField(
    raw['allocation'],
    (v, l) => reqOneOf(v, ['proportional'] as const, l),
    `${label}.allocation`
  )
  if (!allocation.ok) return allocation
  const samplingSeed = optField(raw['sampling_seed'], reqString, `${label}.sampling_seed`)
  if (!samplingSeed.ok) return samplingSeed

  let strata: DispositionBatchStratum[] | undefined
  const strataRaw = raw['strata']
  if (strataRaw !== undefined) {
    if (!Array.isArray(strataRaw)) return { ok: false, reason: `${label}.strata must be an array` }
    const parsed: DispositionBatchStratum[] = []
    for (const [i, s] of strataRaw.entries()) {
      const stratum = parseStratum(s, `${label}.strata[${i}]`)
      if (!stratum.ok) return stratum
      parsed.push(stratum.value)
    }
    strata = parsed
  }

  const verifiedCount = reqNonNegInt(raw['verified_count'], `${label}.verified_count`)
  if (!verifiedCount.ok) return verifiedCount
  const verifiedAt = reqIso8601(raw['verified_at'], `${label}.verified_at`)
  if (!verifiedAt.ok) return verifiedAt
  const stagedAt = reqIso8601(raw['staged_at'], `${label}.staged_at`)
  if (!stagedAt.ok) return stagedAt
  const entryCount = reqNonNegInt(raw['entry_count'], `${label}.entry_count`)
  if (!entryCount.ok) return entryCount
  const entryIdsDigest = reqString(raw['entry_ids_digest'], `${label}.entry_ids_digest`)
  if (!entryIdsDigest.ok) return entryIdsDigest
  const stageDigest = reqString(raw['stage_digest'], `${label}.stage_digest`)
  if (!stageDigest.ok) return stageDigest

  if (strata !== undefined) {
    const check = checkAggregateInvariants(
      strata,
      populationCount.value,
      verifiedCount.value,
      outcomeClass.value,
      label
    )
    if (!check.ok) return check
  }

  // Sign-off triple: jointly present or jointly absent (Item 7).
  const signOffRaw = [raw['signed_off_by'], raw['signed_off_at'], raw['sign_off_digest']]
  const signOffPresentCount = signOffRaw.filter((v) => v !== undefined).length
  if (signOffPresentCount !== 0 && signOffPresentCount !== 3) {
    return {
      ok: false,
      reason: `${label}: signed_off_by/signed_off_at/sign_off_digest must be jointly present or jointly absent`,
    }
  }
  let signedOffBy: string | undefined
  let signedOffAt: string | undefined
  let signOffDigest: string | undefined
  if (signOffPresentCount === 3) {
    const by = reqString(raw['signed_off_by'], `${label}.signed_off_by`)
    if (!by.ok) return by
    const at = reqIso8601(raw['signed_off_at'], `${label}.signed_off_at`)
    if (!at.ok) return at
    const digest = reqString(raw['sign_off_digest'], `${label}.sign_off_digest`)
    if (!digest.ok) return digest
    signedOffBy = by.value
    signedOffAt = at.value
    signOffDigest = digest.value
  }

  const revoked = optField(raw['revoked'], parseRevocationInfo, `${label}.revoked`)
  if (!revoked.ok) return revoked
  if (revoked.value !== undefined && signOffPresentCount === 3) {
    return {
      ok: false,
      reason: `${label}: a revoked batch must not have an active sign-off triple (archive it to sign_off_revocations first)`,
    }
  }

  let signOffRevocations: SignOffRevocationEvent[] | undefined
  const revocationsRaw = raw['sign_off_revocations']
  if (revocationsRaw !== undefined) {
    if (!Array.isArray(revocationsRaw)) {
      return { ok: false, reason: `${label}.sign_off_revocations must be an array` }
    }
    const parsed: SignOffRevocationEvent[] = []
    for (const [i, ev] of revocationsRaw.entries()) {
      const event = parseSignOffRevocationEvent(ev, `${label}.sign_off_revocations[${i}]`)
      if (!event.ok) return event
      parsed.push(event.value)
    }
    signOffRevocations = parsed
  }

  return {
    ok: true,
    value: {
      schema_version: schemaVersion.value,
      batch_id: batchId.value,
      outcome_class: outcomeClass.value,
      run_id: runId.value,
      reason: reason.value,
      tool_commit: toolCommit.value,
      tool_source_digest: toolSourceDigest.value,
      population_count: populationCount.value,
      population_cohort_counts: populationCohortCounts.value,
      ...(subtypeCounts.value !== undefined ? { subtype_counts: subtypeCounts.value } : {}),
      ...(confidencePct.value !== undefined ? { confidence_pct: confidencePct.value } : {}),
      ...(mismatchThresholdBp.value !== undefined
        ? { mismatch_threshold_bp: mismatchThresholdBp.value }
        : {}),
      ...(stratumThresholdBp.value !== undefined
        ? { stratum_threshold_bp: stratumThresholdBp.value }
        : {}),
      ...(designPointBadDraws.value !== undefined
        ? { design_point_bad_draws_per_stratum: designPointBadDraws.value }
        : {}),
      ...(allocation.value !== undefined ? { allocation: allocation.value } : {}),
      ...(samplingSeed.value !== undefined ? { sampling_seed: samplingSeed.value } : {}),
      ...(strata !== undefined ? { strata } : {}),
      verified_count: verifiedCount.value,
      ...(observedPopulationUpperBoundBp.value !== undefined
        ? { observed_population_upper_bound_bp: observedPopulationUpperBoundBp.value }
        : {}),
      verified_at: verifiedAt.value,
      staged_at: stagedAt.value,
      entry_count: entryCount.value,
      entry_ids_digest: entryIdsDigest.value,
      stage_digest: stageDigest.value,
      ...(signedOffBy !== undefined ? { signed_off_by: signedOffBy } : {}),
      ...(signedOffAt !== undefined ? { signed_off_at: signedOffAt } : {}),
      ...(signOffDigest !== undefined ? { sign_off_digest: signOffDigest } : {}),
      ...(revoked.value !== undefined ? { revoked: revoked.value } : {}),
      ...(signOffRevocations !== undefined ? { sign_off_revocations: signOffRevocations } : {}),
    },
  }
}
