/**
 * Deterministic derivation and shape parsing for SMI-6444's `.sample.json`
 * sidecar. Everything here is pure: no filesystem, no lock, no clock — which
 * is what lets the SAME derivation run at creation time and again at
 * resume-validation time and be compared byte-for-byte.
 * @module scripts/indexer/smi5879-dispose-terminal.sidecar.derive
 *
 * Plan: docs/internal/implementation/smi-6444-g1-bulk-disposition-plan.md
 *   Item 5 (stratification, joint sizing, infeasible/empty strata),
 *   Item 8 (sidecar field list + resume validation).
 */

import { createHash } from 'node:crypto'
import {
  isPlainObject,
  reqIso8601,
  reqNonNegInt,
  reqOneOf,
  reqString,
  type Field,
} from './smi5879-gate-check.field-parsers.ts'
import { computeJointSampleSizing, selectStratumSample } from './smi5879-dispose-terminal.stats.ts'
import type { SamplingPolicy } from './smi5879-dispose-terminal.stats.types.ts'
import {
  SAMPLE_RESULT_VALUES,
  SIDECAR_KIND,
  SIDECAR_SCHEMA_VERSION,
  type DerivedSampleSelection,
  type SampleCandidate,
  type SampleResultValue,
  type SampleSidecar,
  type SidecarSelectedRow,
  type SidecarStratum,
} from './smi5879-dispose-terminal.sidecar.types.ts'

function byBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * SHA-256 over the sorted, newline-joined candidate id set — the population
 * rows carrying this outcome class at selection time, INCLUDING rows routed
 * to manual review. Any change to the population (a row added, removed, or
 * re-classified) therefore refuses resume, which is the point: a sample drawn
 * against one population proves nothing about a different one.
 *
 * Same convention as the batch's `entry_ids_digest` (sorted, `\n`-joined),
 * deliberately — one id-set-digest shape across this whole feature.
 */
export function computeCandidateIdsDigest(ids: Iterable<string>): string {
  const sorted = [...new Set(ids)].sort(byBytes)
  return createHash('sha256').update(sorted.join('\n')).digest('hex')
}

/**
 * Derive a sampling run's full selection from live inputs.
 *
 * Rows with no stratum (`stratum_key: null` — the URL did not parse) and
 * every row in an INFEASIBLE stratum (too small to satisfy the ratified
 * design point at any sample size) are routed to
 * `manual_review_required_ids`, never folded into a bulk batch under a weaker
 * guarantee than every other stratum gets. When NO stratum is feasible at all
 * — including the whole-population infeasibility `computeJointSampleSizing`
 * raises when even a full census can't clear the population arm — every
 * candidate routes to manual review and the selection is empty, rather than
 * the derivation throwing at the caller.
 */
export function deriveSampleSelection(params: {
  candidates: readonly SampleCandidate[]
  policy: SamplingPolicy
  seed: string
}): DerivedSampleSelection {
  const { candidates, policy, seed } = params
  const candidateIdsDigest = computeCandidateIdsDigest(candidates.map((c) => c.id))

  const idsByStratum = new Map<string, string[]>()
  const manualReview = new Set<string>()
  for (const candidate of candidates) {
    if (candidate.stratum_key === null) {
      manualReview.add(candidate.id)
      continue
    }
    const bucket = idsByStratum.get(candidate.stratum_key) ?? []
    bucket.push(candidate.id)
    idsByStratum.set(candidate.stratum_key, bucket)
  }

  const populations = [...idsByStratum.entries()]
    .map(([stratumKey, ids]) => ({ stratumKey, populationCount: new Set(ids).size }))
    .sort((a, b) => byBytes(a.stratumKey, b.stratumKey))

  let sizing: ReturnType<typeof computeJointSampleSizing> | null = null
  if (populations.length > 0) {
    try {
      sizing = computeJointSampleSizing(populations, policy)
    } catch (error) {
      if (!(error instanceof RangeError)) throw error
      // No feasible stratum, or a population that cannot clear the
      // population arm even at a full census — every row goes to manual
      // review (plan Item 5's infeasible-stratum posture, applied whole).
      sizing = null
    }
  }

  if (sizing === null) {
    for (const ids of idsByStratum.values()) for (const id of ids) manualReview.add(id)
    return {
      candidate_ids_digest: candidateIdsDigest,
      strata: [],
      selected: [],
      manual_review_required_ids: [...manualReview].sort(byBytes),
      empty_stratum_keys: [],
    }
  }

  for (const stratum of sizing.infeasibleStrata) {
    for (const id of idsByStratum.get(stratum.stratumKey) ?? []) manualReview.add(id)
  }

  const strata: SidecarStratum[] = []
  const selected: SidecarSelectedRow[] = []
  for (const sized of sizing.strata) {
    const candidateIds = [...new Set(idsByStratum.get(sized.stratumKey) ?? [])].sort(byBytes)
    const drawn = selectStratumSample({
      candidateIds,
      sampleSize: sized.sampleSize,
      seed,
      stratumKey: sized.stratumKey,
    })
    strata.push({
      stratum_key: sized.stratumKey,
      population_count: sized.populationCount,
      selected_count: sized.sampleSize,
    })
    for (const id of drawn) selected.push({ id, stratum_key: sized.stratumKey })
  }

  return {
    candidate_ids_digest: candidateIdsDigest,
    strata: strata.sort((a, b) => byBytes(a.stratum_key, b.stratum_key)),
    selected: selected.sort((a, b) => byBytes(a.id, b.id)),
    manual_review_required_ids: [...manualReview].sort(byBytes),
    empty_stratum_keys: [...sizing.emptyStrataKeys].sort(byBytes),
  }
}

// ---------------------------------------------------------------------------
// Shape parsing — explicit field-by-field, never JSON pass-through
// ---------------------------------------------------------------------------

function parseStratum(raw: unknown, label: string): Field<SidecarStratum> {
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object` }
  const key = reqString(raw['stratum_key'], `${label}.stratum_key`)
  if (!key.ok) return key
  const population = reqNonNegInt(raw['population_count'], `${label}.population_count`)
  if (!population.ok) return population
  const selected = reqNonNegInt(raw['selected_count'], `${label}.selected_count`)
  if (!selected.ok) return selected
  return {
    ok: true,
    value: {
      stratum_key: key.value,
      population_count: population.value,
      selected_count: selected.value,
    },
  }
}

function parseSelectedRow(raw: unknown, label: string): Field<SidecarSelectedRow> {
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object` }
  const id = reqString(raw['id'], `${label}.id`)
  if (!id.ok) return id
  const key = reqString(raw['stratum_key'], `${label}.stratum_key`)
  if (!key.ok) return key
  return { ok: true, value: { id: id.value, stratum_key: key.value } }
}

function parseArray<T>(
  raw: unknown,
  label: string,
  parse: (item: unknown, itemLabel: string) => Field<T>
): Field<T[]> {
  if (!Array.isArray(raw)) return { ok: false, reason: `${label} must be an array` }
  const out: T[] = []
  for (const [i, item] of raw.entries()) {
    const parsed = parse(item, `${label}[${i}]`)
    if (!parsed.ok) return parsed
    out.push(parsed.value)
  }
  return { ok: true, value: out }
}

function parseResults(raw: unknown, label: string): Field<Record<string, SampleResultValue>> {
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} must be an object` }
  const out: Record<string, SampleResultValue> = {}
  for (const [id, value] of Object.entries(raw)) {
    const parsed = reqOneOf(value, SAMPLE_RESULT_VALUES, `${label}["${id}"]`)
    if (!parsed.ok) return parsed
    out[id] = parsed.value
  }
  return { ok: true, value: out }
}

const OUTCOME_CLASSES = ['unfetchable', 'primary_not_found'] as const

/** Full shape check. A sidecar that fails this is never partially trusted —
 *  the caller refuses resume outright (plan Item 8). */
export function parseSampleSidecar(raw: unknown): Field<SampleSidecar> {
  if (!isPlainObject(raw)) return { ok: false, reason: 'sidecar is not a JSON object' }
  if (raw['sidecar_kind'] !== SIDECAR_KIND) {
    return { ok: false, reason: `sidecar_kind must be "${SIDECAR_KIND}"` }
  }
  const schemaVersion = reqNonNegInt(raw['schema_version'], 'schema_version')
  if (!schemaVersion.ok) return schemaVersion
  if (schemaVersion.value !== SIDECAR_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `schema_version ${schemaVersion.value} is not supported (this tool writes and reads ${SIDECAR_SCHEMA_VERSION})`,
    }
  }
  const strings = {
    run_id: reqString(raw['run_id'], 'run_id'),
    batch_id: reqString(raw['batch_id'], 'batch_id'),
    candidate_ids_digest: reqString(raw['candidate_ids_digest'], 'candidate_ids_digest'),
    sampling_seed: reqString(raw['sampling_seed'], 'sampling_seed'),
    tool_commit: reqString(raw['tool_commit'], 'tool_commit'),
    tool_source_digest: reqString(raw['tool_source_digest'], 'tool_source_digest'),
  }
  for (const parsed of Object.values(strings)) if (!parsed.ok) return parsed
  const numbers = {
    confidence_pct: reqNonNegInt(raw['confidence_pct'], 'confidence_pct'),
    mismatch_threshold_bp: reqNonNegInt(raw['mismatch_threshold_bp'], 'mismatch_threshold_bp'),
    stratum_threshold_bp: reqNonNegInt(raw['stratum_threshold_bp'], 'stratum_threshold_bp'),
    design_point_bad_draws_per_stratum: reqNonNegInt(
      raw['design_point_bad_draws_per_stratum'],
      'design_point_bad_draws_per_stratum'
    ),
  }
  for (const parsed of Object.values(numbers)) if (!parsed.ok) return parsed
  const outcomeClass = reqOneOf(raw['outcome_class'], OUTCOME_CLASSES, 'outcome_class')
  if (!outcomeClass.ok) return outcomeClass
  const allocation = reqOneOf(raw['allocation'], ['proportional'] as const, 'allocation')
  if (!allocation.ok) return allocation
  const strata = parseArray(raw['strata'], 'strata', parseStratum)
  if (!strata.ok) return strata
  const selected = parseArray(raw['selected'], 'selected', parseSelectedRow)
  if (!selected.ok) return selected
  const results = parseResults(raw['results'], 'results')
  if (!results.ok) return results
  const createdAt = reqIso8601(raw['created_at'], 'created_at')
  if (!createdAt.ok) return createdAt
  const updatedAt = reqIso8601(raw['updated_at'], 'updated_at')
  if (!updatedAt.ok) return updatedAt

  return {
    ok: true,
    value: {
      sidecar_kind: SIDECAR_KIND,
      schema_version: schemaVersion.value,
      run_id: unwrap(strings.run_id),
      outcome_class: outcomeClass.value,
      batch_id: unwrap(strings.batch_id),
      candidate_ids_digest: unwrap(strings.candidate_ids_digest),
      sampling_seed: unwrap(strings.sampling_seed),
      confidence_pct: unwrap(numbers.confidence_pct),
      mismatch_threshold_bp: unwrap(numbers.mismatch_threshold_bp),
      stratum_threshold_bp: unwrap(numbers.stratum_threshold_bp),
      design_point_bad_draws_per_stratum: unwrap(numbers.design_point_bad_draws_per_stratum),
      allocation: allocation.value,
      strata: strata.value,
      selected: selected.value,
      results: results.value,
      tool_commit: unwrap(strings.tool_commit),
      tool_source_digest: unwrap(strings.tool_source_digest),
      created_at: createdAt.value,
      updated_at: updatedAt.value,
    },
  }
}

/** Every field passed here was already proven `ok` by the loops above; this
 *  exists only to satisfy the type narrowing those loops cannot express. */
function unwrap<T>(field: Field<T>): T {
  /* c8 ignore next 3 -- unreachable: callers check `ok` first. */
  if (!field.ok) {
    throw new Error(`parseSampleSidecar: unwrap called on a failed field: ${field.reason}`)
  }
  return field.value
}
