/**
 * Pure helpers for smi5879-gate-check.ts: disposition-ledger validation, the
 * G-5 per-row +32 delta bound, R computation (G-1's union of
 * newly_quarantined/newly_cleared), attestation completeness (G-7/G-8), and
 * JSON-file loading with the "absence of evidence is INCONCLUSIVE" shape
 * validation the task's one governing rule requires everywhere.
 * @module scripts/indexer/smi5879-gate-check.helpers
 *
 * Design: docs/internal/implementation/smi-5879-edge-twin-parity-design.md §8.5
 */

import { existsSync, readFileSync } from 'node:fs'
import type {
  AttestationCheck,
  AttestationCheckStatus,
  DispositionRecord,
  DispositionVerdict,
  Smi5879DispositionLedger,
  Smi5879FreezeAttestation,
} from './smi5879-gate-check.types.ts'
import type { SimRowOutcome, SimRowResult } from './smi5879-simulate-full.types.ts'

// ---------------------------------------------------------------------------
// Generic JSON-file loading — "absence of evidence is INCONCLUSIVE"
// ---------------------------------------------------------------------------

export type LoadResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'missing'; reason: string }
  | { status: 'malformed'; reason: string }

/**
 * Load and JSON.parse a file, distinguishing "no path given"/"file does not
 * exist" (missing) from "exists but is not valid JSON" (malformed) — both
 * are INCONCLUSIVE at the gate level, but with distinctly-worded reasons per
 * the task's governing rule. `validate` does the shape check; a validation
 * failure is also `malformed`, with its own message.
 */
export function loadJsonFile<T>(
  path: string | undefined,
  label: string,
  validate: (value: unknown) => { ok: true; value: T } | { ok: false; reason: string }
): LoadResult<T> {
  if (!path) return { status: 'missing', reason: `no --${label} path was given` }
  if (!existsSync(path)) return { status: 'missing', reason: `${label} file not found at ${path}` }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    return {
      status: 'malformed',
      reason: `failed to read ${label} at ${path}: ${(err as Error).message}`,
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return {
      status: 'malformed',
      reason: `${label} at ${path} is not valid JSON: ${(err as Error).message}`,
    }
  }
  const result = validate(parsed)
  if (!result.ok) {
    return {
      status: 'malformed',
      reason: `${label} at ${path} failed shape validation: ${result.reason}`,
    }
  }
  return { status: 'ok', value: result.value }
}

/**
 * Finding #5 (adversarial review): the disposition ledger's and freeze
 * attestation's own `run_id` field is never cross-checked against the CLI's
 * `--decision-run-id` — a stale artifact left over from a DIFFERENT run
 * could silently satisfy G-1/G-7/G-8. Applies the SAME binding pattern
 * already used for the census/simulator report (`checkArtifactRunIdBinding`
 * in `smi5879-gate-check.binding.ts`) to these two operator-authored
 * artifacts too: a `run_id` mismatch is folded into the `LoadResult`'s
 * `malformed` status (the file DOES exist and IS well-formed JSON, but its
 * content doesn't correspond to the run being gated) — this reuses G-1's
 * existing `loadFailureReason`-checks-first plumbing and G-7/G-8's existing
 * `attestation.status === 'malformed'` branch with NO other code changes
 * needed at either call site.
 */
export function checkArtifactRunIdMatch<T extends { run_id: string }>(
  load: LoadResult<T>,
  expectedRunId: string,
  label: string
): LoadResult<T> {
  if (load.status !== 'ok') return load
  if (load.value.run_id !== expectedRunId) {
    return {
      status: 'malformed',
      reason: `${label} run_id="${load.value.run_id}" does not match --decision-run-id=${expectedRunId}`,
    }
  }
  return load
}

// ---------------------------------------------------------------------------
// Disposition ledger (G-1) — validation
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const VALID_VERDICTS: readonly DispositionVerdict[] = ['confirm', 'exclude']

export function validateDispositionLedgerShape(
  value: unknown
): { ok: true; value: Smi5879DispositionLedger } | { ok: false; reason: string } {
  if (!isPlainObject(value)) return { ok: false, reason: 'not a JSON object' }
  const runId = value['run_id']
  const entriesRaw = value['entries']
  if (typeof runId !== 'string' || runId.length === 0) {
    return { ok: false, reason: 'run_id must be a non-empty string' }
  }
  if (!Array.isArray(entriesRaw)) return { ok: false, reason: 'entries must be an array' }
  const entries: DispositionRecord[] = []
  for (const [i, raw] of entriesRaw.entries()) {
    if (!isPlainObject(raw)) return { ok: false, reason: `entries[${i}] is not an object` }
    const id = raw['id']
    const verdict = raw['verdict']
    if (typeof id !== 'string' || id.length === 0) {
      return { ok: false, reason: `entries[${i}].id must be a non-empty string` }
    }
    if (typeof verdict !== 'string' || !VALID_VERDICTS.includes(verdict as DispositionVerdict)) {
      return {
        ok: false,
        reason: `entries[${i}].verdict must be one of ${VALID_VERDICTS.join('|')}`,
      }
    }
    const reason = raw['reason']
    const recordedBy = raw['recorded_by']
    const recordedAt = raw['recorded_at']
    entries.push({
      id,
      verdict: verdict as DispositionVerdict,
      ...(typeof reason === 'string' ? { reason } : {}),
      ...(typeof recordedBy === 'string' ? { recorded_by: recordedBy } : {}),
      ...(typeof recordedAt === 'string' ? { recorded_at: recordedAt } : {}),
    })
  }
  return { ok: true, value: { run_id: runId, entries } }
}

export interface LedgerValidation {
  valid: boolean
  byId: Map<string, DispositionVerdict>
  /** ids with two-or-more entries carrying DIFFERENT verdicts — never last-write-wins. */
  conflictingIds: string[]
}

/**
 * Validate internal consistency of an already-shape-checked ledger. A
 * duplicate entry for the same id is fine IFF every entry for that id agrees
 * on the verdict; a genuine conflict (confirm AND exclude recorded for the
 * same id) makes the WHOLE ledger untrustworthy, never resolved by
 * last-write-wins (task spec, explicit).
 */
export function validateDispositionLedger(ledger: Smi5879DispositionLedger): LedgerValidation {
  const byId = new Map<string, DispositionVerdict>()
  const conflicting = new Set<string>()
  for (const entry of ledger.entries) {
    const existing = byId.get(entry.id)
    if (existing !== undefined && existing !== entry.verdict) {
      conflicting.add(entry.id)
      continue
    }
    byId.set(entry.id, entry.verdict)
  }
  return { valid: conflicting.size === 0, byId, conflictingIds: [...conflicting].sort() }
}

export interface ResolvedLedger {
  validation: LedgerValidation
  /** Non-null iff the ledger could not be loaded at all (missing/malformed) — distinct
   *  from "loaded but incomplete", which each gate reports on its own terms. */
  loadFailureReason: string | null
}

/**
 * Normalize a `loadJsonFile` result for the disposition ledger into a shape
 * both G-1 and G-2R can consume uniformly: a load failure (missing file,
 * unparseable JSON, failed shape validation) produces an EMPTY, vacuously
 * "valid" ledger plus a distinct `loadFailureReason` — callers check that
 * field FIRST, so "no ledger at all" is never silently indistinguishable
 * from "ledger loaded but every row happens to be undisposed."
 */
export function resolveLedger(loadResult: LoadResult<Smi5879DispositionLedger>): ResolvedLedger {
  if (loadResult.status === 'ok') {
    return { validation: validateDispositionLedger(loadResult.value), loadFailureReason: null }
  }
  return {
    validation: { valid: true, byId: new Map(), conflictingIds: [] },
    loadFailureReason: loadResult.reason,
  }
}

// ---------------------------------------------------------------------------
// R — the union of newly_quarantined/newly_cleared (G-1's input; G-3 checks it)
// ---------------------------------------------------------------------------

export const R_OUTCOMES: readonly SimRowOutcome[] = ['newly_quarantined', 'newly_cleared']

export function computeR(rows: readonly SimRowResult[]): SimRowResult[] {
  return rows.filter((r) => (R_OUTCOMES as readonly string[]).includes(r.outcome))
}

// ---------------------------------------------------------------------------
// G-5 corroboration — the per-row +32 bound over the ENTIRE simulated population
// ---------------------------------------------------------------------------

/**
 * The five scoring outcomes that carry `prePortRiskScore`/`postPortRiskScore`
 * — verified against `smi5879-simulate-full.helpers.ts`'s `processRow`:
 * `bundle_absent` (lines ~316-326) and the final `classifyVerdictDelta`
 * branch (unchanged_clean/unchanged_quarantined/newly_quarantined/
 * newly_cleared, ~328-335) are the ONLY paths that populate the score
 * fields. `unevaluable`/`unfetchable`/`content_drifted` all return early
 * before scoring and never carry them.
 */
export const SCORED_OUTCOMES: readonly SimRowOutcome[] = [
  'bundle_absent',
  'newly_quarantined',
  'newly_cleared',
  'unchanged_clean',
  'unchanged_quarantined',
]

export interface DeltaBoundViolation {
  id: string
  delta: number
}

export interface DeltaBoundCheckResult {
  ok: boolean
  violations: DeltaBoundViolation[]
  /** A scored-outcome row missing one or both score fields — INCONCLUSIVE, never silently skipped. */
  missingScoreIds: string[]
}

const DELTA_BOUND = 32

export function checkDeltaBound(rows: readonly SimRowResult[]): DeltaBoundCheckResult {
  const violations: DeltaBoundViolation[] = []
  const missingScoreIds: string[] = []
  for (const row of rows) {
    if (!(SCORED_OUTCOMES as readonly string[]).includes(row.outcome)) continue
    if (row.prePortRiskScore === undefined || row.postPortRiskScore === undefined) {
      missingScoreIds.push(row.id)
      continue
    }
    const delta = row.postPortRiskScore - row.prePortRiskScore
    if (delta > DELTA_BOUND) violations.push({ id: row.id, delta })
  }
  return {
    ok: violations.length === 0 && missingScoreIds.length === 0,
    violations,
    missingScoreIds,
  }
}

// ---------------------------------------------------------------------------
// Attestation (G-7/G-8) — required-id-set completeness
// ---------------------------------------------------------------------------

export const G7_REQUIRED_ATTESTATION_IDS = [
  'F-1',
  'F-2',
  'F-3',
  'F-4',
  'F-5',
  'F-6',
  'F-7',
  'F-8',
  'F-9',
  'F-1S',
  'F-2S',
  'F-3S',
  'F-4S',
  'F-5S',
  'F-6S',
] as const

export const G8_REQUIRED_ATTESTATION_IDS = [
  'P-0.1',
  'P-0.2',
  'P-0.3',
  'P-0.4',
  'P-0.5',
  'P-0.6',
] as const

export interface AttestationCompletenessResult {
  ok: boolean
  /** ids with NO recorded check at all — distinctly worded from `redIds` (task spec, explicit). */
  missingIds: string[]
  /** ids with a recorded check whose status is `red` (or explicit `missing`). */
  redIds: string[]
  /** ids with two-or-more recorded checks disagreeing on status — never resolved by
   *  last-write-wins (finding #8, adversarial review — same pattern as
   *  {@link validateDispositionLedger}'s `conflictingIds`). */
  conflictingIds: string[]
}

/**
 * Finding #8 (adversarial review): a RED record for some check id followed
 * by a GREEN record for the SAME id must never be silently deduplicated by
 * a `new Map(checks.map(c => [c.id, c]))`-style last-write-wins collapse —
 * that would let whichever record happened to be written last (or appear
 * last in the array) silently win. Applies the SAME conflict-detection
 * pattern {@link validateDispositionLedger} already uses for the disposition
 * ledger: a duplicate id is fine IFF every recorded check for that id agrees
 * on `status`; a genuine disagreement makes that id's completeness
 * unresolvable, never last-write-wins. Checked across the WHOLE `checks`
 * array (not scoped to `requiredIds`) — a conflicting entry anywhere taints
 * trust in the attestation file as a whole, same as the ledger's `conflicting`
 * set is whole-ledger, not per-row.
 */
export function checkAttestationCompleteness(
  checks: readonly AttestationCheck[],
  requiredIds: readonly string[]
): AttestationCompletenessResult {
  const byId = new Map<string, AttestationCheckStatus>()
  const conflicting = new Set<string>()
  for (const check of checks) {
    const existing = byId.get(check.id)
    if (existing !== undefined && existing !== check.status) {
      conflicting.add(check.id)
      continue
    }
    byId.set(check.id, check.status)
  }
  const missingIds: string[] = []
  const redIds: string[] = []
  for (const id of requiredIds) {
    if (conflicting.has(id)) continue
    const status = byId.get(id)
    if (status === undefined || status === 'missing') {
      missingIds.push(id)
    } else if (status === 'red') {
      redIds.push(id)
    }
  }
  return {
    ok: missingIds.length === 0 && redIds.length === 0 && conflicting.size === 0,
    missingIds,
    redIds,
    conflictingIds: [...conflicting].sort(),
  }
}

const VALID_ATTESTATION_STATUSES = ['green', 'red', 'missing'] as const

export function validateFreezeAttestationShape(
  value: unknown
): { ok: true; value: Smi5879FreezeAttestation } | { ok: false; reason: string } {
  if (!isPlainObject(value)) return { ok: false, reason: 'not a JSON object' }
  const runId = value['run_id']
  const checksRaw = value['checks']
  const backfillClean = value['backfill_kill_switch_clean']
  const pr2192aMerged = value['pr2192a_merged']
  const pr2192aDeployGreen = value['pr2192a_deploy_green']
  const pr2192aMergedAt = value['pr2192a_merged_at']
  const recordedAt = value['recorded_at']
  if (typeof runId !== 'string' || runId.length === 0) {
    return { ok: false, reason: 'run_id must be a non-empty string' }
  }
  if (!Array.isArray(checksRaw)) return { ok: false, reason: 'checks must be an array' }
  const checks: AttestationCheck[] = []
  for (const [i, raw] of checksRaw.entries()) {
    if (!isPlainObject(raw)) return { ok: false, reason: `checks[${i}] is not an object` }
    const id = raw['id']
    const status = raw['status']
    if (typeof id !== 'string' || id.length === 0) {
      return { ok: false, reason: `checks[${i}].id must be a non-empty string` }
    }
    if (
      typeof status !== 'string' ||
      !(VALID_ATTESTATION_STATUSES as readonly string[]).includes(status)
    ) {
      return {
        ok: false,
        reason: `checks[${i}].status must be one of ${VALID_ATTESTATION_STATUSES.join('|')}`,
      }
    }
    const detail = raw['detail']
    checks.push({
      id,
      status: status as AttestationCheck['status'],
      ...(typeof detail === 'string' ? { detail } : {}),
    })
  }
  if (typeof backfillClean !== 'boolean') {
    return { ok: false, reason: 'backfill_kill_switch_clean must be a boolean' }
  }
  if (typeof pr2192aMerged !== 'boolean') {
    return { ok: false, reason: 'pr2192a_merged must be a boolean' }
  }
  if (typeof pr2192aDeployGreen !== 'boolean') {
    return { ok: false, reason: 'pr2192a_deploy_green must be a boolean' }
  }
  if (pr2192aMergedAt !== null && typeof pr2192aMergedAt !== 'string') {
    return { ok: false, reason: 'pr2192a_merged_at must be a string or null' }
  }
  if (typeof recordedAt !== 'string') return { ok: false, reason: 'recorded_at must be a string' }
  return {
    ok: true,
    value: {
      run_id: runId,
      checks,
      backfill_kill_switch_clean: backfillClean,
      pr2192a_merged: pr2192aMerged,
      pr2192a_deploy_green: pr2192aDeployGreen,
      pr2192a_merged_at: pr2192aMergedAt,
      recorded_at: recordedAt,
    },
  }
}
