/**
 * Fixtures for the two OPERATOR-AUTHORED artifacts gate-check consumes: the
 * G-1 disposition ledger (entries, SMI-6444 bulk entries, and the
 * `DispositionBatch` records that authorize them) and the G-7/G-8 freeze
 * attestation. Split out of `smi5879-gate-check.fixtures.ts` once SMI-6444's
 * batch builders pushed that file past the 500-line policy cap.
 * @module scripts/tests/indexer/smi5879-gate-check.fixtures.dispositions
 *
 * IMPORT DIRECTION IS ONE-WAY, deliberately: this file imports shared
 * primitives (`DECISION_RUN_ID`, `SAMPLE_COMMIT`) FROM the base fixtures
 * module, and the base module imports nothing back. Consumers import these
 * helpers from HERE rather than through a re-export, so there is no cycle to
 * reason about — `buildRequiredArgs` writes only the census + simulator
 * reports, never a ledger or attestation, so the base module genuinely has no
 * need of anything below.
 */

import { createHash } from 'node:crypto'
import { computeStageDigest } from '../../indexer/smi5879-disposition-digest.ts'
import type { DispositionBatch } from '../../indexer/smi5879-gate-check.types.ts'
import { DECISION_RUN_ID, SAMPLE_COMMIT } from './smi5879-gate-check.fixtures.ts'

// ---------------------------------------------------------------------------
// Disposition ledger
// ---------------------------------------------------------------------------

export function makeDispositionLedgerJson(
  entries: Record<string, unknown>[] = [],
  runId = DECISION_RUN_ID,
  batches?: Record<string, unknown>[]
): Record<string, unknown> {
  return { run_id: runId, entries, ...(batches !== undefined ? { batches } : {}) }
}

/**
 * SMI-6444 — a `DispositionBatch` whose `stage_digest`/`entry_ids_digest` are
 * COMPUTED, not invented, so the gate's own fresh recomputation
 * (`smi5879-gate-check.gates.bulk-authorization.ts`) agrees with it.
 *
 * `entryIds` is the set of ledger-entry ids this batch covers — the same set
 * the caller must actually write as `method:'bulk'` entries, since the gate
 * re-derives the entry-ids digest from the ledger rather than trusting the
 * stored one, and `validateDispositionLedgerShape` separately requires
 * `entry_count` to equal the real entry count.
 *
 * `signed: false` produces a staged-but-unsigned batch (no sign-off triple);
 * `overrides` is applied LAST, so a test can deliberately corrupt a signed
 * batch (a stale `sign_off_digest`, a wrong `outcome_class`) and still get a
 * shape-valid ledger.
 */
export function makeDispositionBatchJson(opts: {
  batchId: string
  outcomeClass: 'unfetchable' | 'primary_not_found'
  entryIds: readonly string[]
  signed?: boolean
  runId?: string
  overrides?: Record<string, unknown>
}): Record<string, unknown> {
  const entryIds = [...opts.entryIds].sort()
  const staged = {
    schema_version: 1,
    batch_id: opts.batchId,
    outcome_class: opts.outcomeClass,
    run_id: opts.runId ?? DECISION_RUN_ID,
    reason: `bulk ${opts.outcomeClass} re-verification (fixture)`,
    tool_commit: SAMPLE_COMMIT,
    tool_source_digest: 'sha256:fixture-tool-source-digest',
    population_count: entryIds.length,
    population_cohort_counts: { C2: entryIds.length },
    verified_count: entryIds.length,
    verified_at: '2026-07-30T00:00:00.000000Z',
    staged_at: '2026-07-30T00:05:00.000000Z',
    entry_count: entryIds.length,
    entry_ids_digest: createHash('sha256').update(entryIds.join('\n')).digest('hex'),
    stage_digest: '',
  }
  const stageDigest = computeStageDigest(staged as unknown as DispositionBatch, entryIds)
  return {
    ...staged,
    stage_digest: stageDigest,
    ...(opts.signed === false
      ? {}
      : {
          signed_off_by: 'reviewer@example.com',
          signed_off_at: '2026-07-30T00:10:00.000000Z',
          sign_off_digest: stageDigest,
        }),
    ...opts.overrides,
  }
}

/** SMI-6444 — one `method:'bulk'` ledger entry pointing at `batchId`. */
export function makeBulkEntry(
  id: string,
  batchId: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { id, verdict: 'exclude', method: 'bulk', batch_id: batchId, ...overrides }
}

// ---------------------------------------------------------------------------
// G-7 / G-8 freeze attestation
// ---------------------------------------------------------------------------

export function makeAttestationChecks(
  ids: readonly string[],
  status = 'green'
): Record<string, unknown>[] {
  return ids.map((id) => ({ id, status }))
}

export function makeAttestationJson(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    run_id: DECISION_RUN_ID,
    checks: [],
    backfill_kill_switch_clean: true,
    pr2192a_merged: true,
    pr2192a_deploy_green: true,
    pr2192a_merged_at: '2026-07-28T00:00:00.000000Z',
    recorded_at: new Date().toISOString(),
    ...overrides,
  }
}
