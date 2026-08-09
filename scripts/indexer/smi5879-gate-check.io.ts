/**
 * Required-input loading for smi5879-gate-check.ts: the census report(s) and
 * the simulator report. Split out of `smi5879-gate-check.helpers.ts` (which
 * already owns the OPTIONAL-input validators — disposition ledger, freeze
 * attestation — to keep both files under CLAUDE.md's 500-line limit).
 * @module scripts/indexer/smi5879-gate-check.io
 *
 * These two artifacts are NOT optional the way the disposition ledger and
 * freeze attestation are — there is no gate that can meaningfully evaluate
 * without them — but a missing/malformed file still produces a
 * distinctly-worded `INCONCLUSIVE` short-circuit rather than an uncaught
 * exception, per the task's governing rule.
 */

import { loadJsonFile, type LoadResult } from './smi5879-gate-check.helpers.ts'
import type { InvariantResult, Smi5879Purpose, Smi5879RunStatus } from './smi5879-census.types.ts'
import type {
  CohortCoverage,
  SimRowOutcome,
  SimRowResult,
  SimulatedCohort,
  Smi5879SimulateFullReport,
  SweepHardStopReason,
  TokenSource,
} from './smi5879-simulate-full.types.ts'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const VALID_PURPOSES: readonly Smi5879Purpose[] = ['rehearsal', 'decision', 'window']
const VALID_STATUSES: readonly Smi5879RunStatus[] = ['open', 'sealed', 'abandoned']
const VALID_INVARIANT_IDS = ['I-1', 'I-2', 'I-3', 'I-4', 'I-5'] as const

// ---------------------------------------------------------------------------
// Census report — only the fields gate-check actually reads (run_id,
// purpose, status, invariants). The full `Smi5879CensusReport` carries
// several other fields (ruleset_epoch, cohorts, digests, ...) that gate-check
// never consumes directly — those are validated by item 1's own census tool,
// not re-validated here.
// ---------------------------------------------------------------------------

export interface CensusReportEssentials {
  run_id: string
  purpose: Smi5879Purpose
  status: Smi5879RunStatus
  invariants: InvariantResult[]
}

export function loadCensusReport(
  path: string | undefined,
  label: string
): LoadResult<CensusReportEssentials> {
  return loadJsonFile(path, label, (value) => {
    if (!isPlainObject(value)) return { ok: false, reason: 'not a JSON object' }
    const runId = value['run_id']
    const purpose = value['purpose']
    const status = value['status']
    const invariantsRaw = value['invariants']
    if (typeof runId !== 'string' || runId.length === 0) {
      return { ok: false, reason: 'run_id must be a non-empty string' }
    }
    if (typeof purpose !== 'string' || !VALID_PURPOSES.includes(purpose as Smi5879Purpose)) {
      return { ok: false, reason: `purpose must be one of ${VALID_PURPOSES.join('|')}` }
    }
    if (typeof status !== 'string' || !VALID_STATUSES.includes(status as Smi5879RunStatus)) {
      return { ok: false, reason: `status must be one of ${VALID_STATUSES.join('|')}` }
    }
    if (!Array.isArray(invariantsRaw)) return { ok: false, reason: 'invariants must be an array' }
    const invariants: InvariantResult[] = []
    for (const [i, raw] of invariantsRaw.entries()) {
      if (!isPlainObject(raw)) return { ok: false, reason: `invariants[${i}] is not an object` }
      const id = raw['id']
      const name = raw['name']
      const passed = raw['passed']
      const detail = raw['detail']
      if (typeof id !== 'string' || !(VALID_INVARIANT_IDS as readonly string[]).includes(id)) {
        return {
          ok: false,
          reason: `invariants[${i}].id must be one of ${VALID_INVARIANT_IDS.join('|')}`,
        }
      }
      if (typeof name !== 'string')
        return { ok: false, reason: `invariants[${i}].name must be a string` }
      if (typeof passed !== 'boolean')
        return { ok: false, reason: `invariants[${i}].passed must be a boolean` }
      if (typeof detail !== 'string')
        return { ok: false, reason: `invariants[${i}].detail must be a string` }
      invariants.push({ id: id as InvariantResult['id'], name, passed, detail })
    }
    return {
      ok: true,
      value: {
        run_id: runId,
        purpose: purpose as Smi5879Purpose,
        status: status as Smi5879RunStatus,
        invariants,
      },
    }
  })
}

// ---------------------------------------------------------------------------
// Simulator report — full shape validation (every field IS read by at least
// one gate evaluator: G-2 reads coverage/sweep/report_kind/run_id/purpose,
// G-3 reads rows/counts, G-5 reads rows/baseline_commit, G-1 reads rows).
// ---------------------------------------------------------------------------

const SIMULATED_COHORTS: readonly SimulatedCohort[] = ['C1', 'C2', 'C3', 'C4']
const VALID_TOKEN_SOURCES: readonly TokenSource[] = ['app', 'pat']
const VALID_HARD_STOP: readonly SweepHardStopReason[] = ['non_convergence', 'max_passes', null]
const VALID_OUTCOMES: readonly SimRowOutcome[] = [
  'newly_quarantined',
  'newly_cleared',
  'unchanged_clean',
  'unchanged_quarantined',
  'content_drifted',
  'bundle_absent',
  'unevaluable',
  'unfetchable',
]

function validateCoverage(
  value: unknown
): { ok: true; value: CohortCoverage } | { ok: false; reason: string } {
  if (!isPlainObject(value)) return { ok: false, reason: 'not an object' }
  const status = value['status']
  const scanned = value['scanned']
  const total = value['total']
  const unevaluable = value['unevaluable']
  const unfetchable = value['unfetchable']
  if (status !== 'full' && status !== 'partial')
    return { ok: false, reason: 'status must be full|partial' }
  if (typeof scanned !== 'number') return { ok: false, reason: 'scanned must be a number' }
  if (typeof total !== 'number') return { ok: false, reason: 'total must be a number' }
  if (typeof unevaluable !== 'number') return { ok: false, reason: 'unevaluable must be a number' }
  if (typeof unfetchable !== 'number') return { ok: false, reason: 'unfetchable must be a number' }
  return { ok: true, value: { status, scanned, total, unevaluable, unfetchable } }
}

function validateRow(
  value: unknown,
  i: number
): { ok: true; value: SimRowResult } | { ok: false; reason: string } {
  if (!isPlainObject(value)) return { ok: false, reason: `rows[${i}] is not an object` }
  const id = value['id']
  const cohort = value['cohort']
  const author = value['author']
  const name = value['name']
  const outcome = value['outcome']
  if (typeof id !== 'string') return { ok: false, reason: `rows[${i}].id must be a string` }
  if (typeof cohort !== 'string' || !(SIMULATED_COHORTS as readonly string[]).includes(cohort)) {
    return { ok: false, reason: `rows[${i}].cohort must be one of ${SIMULATED_COHORTS.join('|')}` }
  }
  if (author !== null && typeof author !== 'string') {
    return { ok: false, reason: `rows[${i}].author must be a string or null` }
  }
  if (name !== null && typeof name !== 'string') {
    return { ok: false, reason: `rows[${i}].name must be a string or null` }
  }
  if (typeof outcome !== 'string' || !(VALID_OUTCOMES as readonly string[]).includes(outcome)) {
    return {
      ok: false,
      reason: `rows[${i}].outcome="${String(outcome)}" is not a recognised SimRowOutcome`,
    }
  }
  const reason = value['reason']
  const prePortQuarantine = value['prePortQuarantine']
  const postPortQuarantine = value['postPortQuarantine']
  const prePortRiskScore = value['prePortRiskScore']
  const postPortRiskScore = value['postPortRiskScore']
  if (reason !== undefined && typeof reason !== 'string') {
    return { ok: false, reason: `rows[${i}].reason must be a string when present` }
  }
  if (prePortQuarantine !== undefined && typeof prePortQuarantine !== 'boolean') {
    return { ok: false, reason: `rows[${i}].prePortQuarantine must be a boolean when present` }
  }
  if (postPortQuarantine !== undefined && typeof postPortQuarantine !== 'boolean') {
    return { ok: false, reason: `rows[${i}].postPortQuarantine must be a boolean when present` }
  }
  if (prePortRiskScore !== undefined && typeof prePortRiskScore !== 'number') {
    return { ok: false, reason: `rows[${i}].prePortRiskScore must be a number when present` }
  }
  if (postPortRiskScore !== undefined && typeof postPortRiskScore !== 'number') {
    return { ok: false, reason: `rows[${i}].postPortRiskScore must be a number when present` }
  }
  return {
    ok: true,
    value: {
      id,
      cohort: cohort as SimulatedCohort,
      author,
      name,
      outcome: outcome as SimRowOutcome,
      ...(typeof reason === 'string' ? { reason } : {}),
      ...(typeof prePortQuarantine === 'boolean' ? { prePortQuarantine } : {}),
      ...(typeof postPortQuarantine === 'boolean' ? { postPortQuarantine } : {}),
      ...(typeof prePortRiskScore === 'number' ? { prePortRiskScore } : {}),
      ...(typeof postPortRiskScore === 'number' ? { postPortRiskScore } : {}),
    },
  }
}

export function loadSimulatorReport(
  path: string | undefined,
  label: string
): LoadResult<Smi5879SimulateFullReport> {
  return loadJsonFile(path, label, (value) => {
    if (!isPlainObject(value)) return { ok: false, reason: 'not a JSON object' }
    const reportKind = value['report_kind']
    const runId = value['run_id']
    const purpose = value['purpose']
    const status = value['status']
    const tokenSource = value['token_source']
    const baselineCommit = value['baseline_commit']
    const coverageRaw = value['coverage']
    const estimatedCompletionAt = value['estimated_completion_at']
    const sweepRaw = value['sweep']
    const rowsRaw = value['rows']
    const countsRaw = value['counts']
    const generatedAt = value['generated_at']

    if (reportKind !== 'full_simulation') {
      return { ok: false, reason: 'report_kind must be "full_simulation"' }
    }
    if (typeof runId !== 'string' || runId.length === 0) {
      return { ok: false, reason: 'run_id must be a non-empty string' }
    }
    if (typeof purpose !== 'string' || !VALID_PURPOSES.includes(purpose as Smi5879Purpose)) {
      return { ok: false, reason: `purpose must be one of ${VALID_PURPOSES.join('|')}` }
    }
    if (typeof status !== 'string' || !VALID_STATUSES.includes(status as Smi5879RunStatus)) {
      return { ok: false, reason: `status must be one of ${VALID_STATUSES.join('|')}` }
    }
    if (
      typeof tokenSource !== 'string' ||
      !VALID_TOKEN_SOURCES.includes(tokenSource as TokenSource)
    ) {
      return { ok: false, reason: `token_source must be one of ${VALID_TOKEN_SOURCES.join('|')}` }
    }
    if (typeof baselineCommit !== 'string' || baselineCommit.length === 0) {
      return { ok: false, reason: 'baseline_commit must be a non-empty string' }
    }
    if (!isPlainObject(coverageRaw)) return { ok: false, reason: 'coverage must be an object' }
    const coverage: Partial<Record<SimulatedCohort, CohortCoverage>> = {}
    for (const cohort of SIMULATED_COHORTS) {
      const result = validateCoverage(coverageRaw[cohort])
      if (!result.ok) return { ok: false, reason: `coverage.${cohort}: ${result.reason}` }
      coverage[cohort] = result.value
    }
    if (estimatedCompletionAt !== null && typeof estimatedCompletionAt !== 'string') {
      return { ok: false, reason: 'estimated_completion_at must be a string or null' }
    }
    if (!isPlainObject(sweepRaw)) return { ok: false, reason: 'sweep must be an object' }
    const passesRun = sweepRaw['passes_run']
    const hardStopped = sweepRaw['hard_stopped']
    if (typeof passesRun !== 'number')
      return { ok: false, reason: 'sweep.passes_run must be a number' }
    if (!VALID_HARD_STOP.includes(hardStopped as SweepHardStopReason)) {
      return { ok: false, reason: 'sweep.hard_stopped must be non_convergence|max_passes|null' }
    }
    if (!Array.isArray(rowsRaw)) return { ok: false, reason: 'rows must be an array' }
    const rows: SimRowResult[] = []
    for (const [i, raw] of rowsRaw.entries()) {
      const result = validateRow(raw, i)
      if (!result.ok) return { ok: false, reason: result.reason }
      rows.push(result.value)
    }
    if (!isPlainObject(countsRaw)) return { ok: false, reason: 'counts must be an object' }
    const counts: Partial<Record<SimRowOutcome, number>> = {}
    for (const outcome of VALID_OUTCOMES) {
      const n = countsRaw[outcome]
      if (typeof n !== 'number') return { ok: false, reason: `counts.${outcome} must be a number` }
      counts[outcome] = n
    }
    if (typeof generatedAt !== 'string')
      return { ok: false, reason: 'generated_at must be a string' }

    const report: Smi5879SimulateFullReport = {
      report_kind: 'full_simulation',
      run_id: runId,
      purpose: purpose as Smi5879Purpose,
      status: status as Smi5879RunStatus,
      token_source: tokenSource as TokenSource,
      baseline_commit: baselineCommit,
      coverage: coverage as Record<SimulatedCohort, CohortCoverage>,
      estimated_completion_at: estimatedCompletionAt,
      sweep: { passes_run: passesRun, hard_stopped: hardStopped as SweepHardStopReason },
      rows,
      counts: counts as Record<SimRowOutcome, number>,
      generated_at: generatedAt,
    }
    return { ok: true, value: report }
  })
}
