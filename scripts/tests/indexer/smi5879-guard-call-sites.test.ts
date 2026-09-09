/**
 * SMI-6481 (GPT-5.6-Sol cross-model pre-merge gate, 2026-09-09): negative-path
 * coverage for the coherence guards' CALL SITES.
 *
 * The shared guard functions themselves
 * (`smi5879-merge-shards.outcome-coherence.ts`) already have direct unit
 * coverage in `smi5879-merge-shards.invariants.test.ts`, and the
 * checkpoint-seed guard has its own end-to-end regression test in
 * `smi5879-simulate-full.test.ts`. What had NO coverage — flagged by the
 * cross-model gate — is whether the guard is actually WIRED at the other
 * three row-introduction sites: `runMainPass`, `runSweepPhase`, and
 * `buildSimulateFullReport`, plus the fourth independent `processRow`
 * producer, `runPreflightEstimate`.
 *
 * That gap matters because every one of those call sites would stay green on
 * the happy path if its `assertRowsInternallyCoherent(...)` line were
 * deleted: the guard only ever fires on input the real classifier never
 * produces. These tests inject exactly that input — a simulated classifier
 * regression via a mocked `processRow` — and assert both that the call
 * throws AND that the durable side effect (checkpoint write / row merge /
 * report emission) never happened.
 *
 * @module scripts/tests/indexer/smi5879-guard-call-sites
 */

import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type {
  BranchMap,
  SimRowResult,
  SimSnapshotRow,
  Smi5879SimulateCheckpoint,
  Smi5879SimulateFullDbDeps,
} from '../../indexer/smi5879-simulate-full.types.ts'

// A single mocked `processRow` stands in for all four producers — every one
// of them imports it from this same module. `importOriginal` keeps the rest
// of the module (CHECKPOINT_BATCH_SIZE, PROCESS_CONCURRENCY,
// assertPatTokenSource) real, so only the classifier is simulated-regressed.
const processRowMock = vi.hoisted(() => vi.fn())
vi.mock('../../indexer/smi5879-simulate-full.helpers.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../indexer/smi5879-simulate-full.helpers.ts')>()
  return { ...actual, processRow: processRowMock }
})

const { runMainPass } = await import('../../indexer/smi5879-simulate-full.mainpass.ts')
const { runSweepPhase, SWEEP_COOLDOWN_MS } =
  await import('../../indexer/smi5879-simulate-full.sweep.ts')
const { buildSimulateFullReport } = await import('../../indexer/smi5879-simulate-full.report.ts')
const { runPreflightEstimate } =
  await import('../../indexer/smi5879-simulate-preflight-estimate.ts')

/**
 * The exact pre-SMI-6436 masking shape: `bundle_absent` (a non-change label)
 * on a row whose own quarantine booleans record a real `newly_cleared`
 * delta. This is the shape the sealed census hid 83 of.
 */
function incoherentResult(id: string): SimRowResult {
  return {
    id,
    cohort: 'C2',
    author: 'acme',
    name: id,
    outcome: 'bundle_absent',
    prePortQuarantine: true,
    postPortQuarantine: false,
    prePortRiskScore: 40,
    postPortRiskScore: 0,
  }
}

function snapshotRow(id: string): SimSnapshotRow {
  return {
    id,
    cohort: 'C2',
    repo_url: `https://github.com/acme/${id}`,
    skill_path: 'SKILL.md',
    author: 'acme',
    name: id,
    content_hash: null,
    snapshot_security_score: null,
    snapshot_quarantined: null,
  }
}

const BRANCH_MAP: BranchMap = new Map()

const scanDeps = {
  scanPostPort: vi.fn(),
  scanPrePort: vi.fn(),
  telemetry: { buckets: {} } as never,
  getHeaders: async () => ({}),
}

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'smi6481-guard-'))
  processRowMock.mockReset()
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('SMI-6481 guard call sites — main pass', () => {
  it('refuses to merge or checkpoint a batch containing an incoherent row', async () => {
    processRowMock.mockImplementation(async (row: SimSnapshotRow) => incoherentResult(row.id))
    const alreadyResults = new Map<string, SimRowResult>()
    const onBatchDone = vi.fn(async () => {})

    await expect(
      runMainPass([snapshotRow('poison-1')], alreadyResults, BRANCH_MAP, scanDeps, onBatchDone)
    ).rejects.toThrow(/SMI-6015|SMI-6436|coheren/i)

    // The guard runs BEFORE the merge and BEFORE the durable checkpoint —
    // if it were removed, both of these would have happened anyway and the
    // poisoned row would be on disk.
    expect(onBatchDone).not.toHaveBeenCalled()
    expect(alreadyResults.size).toBe(0)
  })

  it('still completes normally when the batch is coherent', async () => {
    processRowMock.mockImplementation(async (row: SimSnapshotRow) => ({
      ...incoherentResult(row.id),
      outcome: 'newly_cleared' as const,
    }))
    const alreadyResults = new Map<string, SimRowResult>()
    const onBatchDone = vi.fn(async () => {})

    await expect(
      runMainPass([snapshotRow('ok-1')], alreadyResults, BRANCH_MAP, scanDeps, onBatchDone)
    ).resolves.toEqual({ deadlineExceeded: false })
    expect(onBatchDone).toHaveBeenCalledTimes(1)
    expect(alreadyResults.get('ok-1')?.outcome).toBe('newly_cleared')
  })
})

describe('SMI-6481 guard call sites — sweep pass', () => {
  it('refuses to merge or checkpoint a sweep pass containing an incoherent row', async () => {
    processRowMock.mockImplementation(async (row: SimSnapshotRow) => incoherentResult(row.id))

    // The sweep only re-scans rows currently sitting at `unevaluable`.
    const results = new Map<string, SimRowResult>([
      [
        'resid-1',
        {
          id: 'resid-1',
          cohort: 'C2',
          author: 'acme',
          name: 'resid-1',
          outcome: 'unevaluable',
        },
      ],
    ])
    const checkpointPath = join(tmp, 'sweep-checkpoint.json')
    const checkpoint: Smi5879SimulateCheckpoint = {
      run_id: 'run-1',
      purpose: 'quarantine_efficacy',
      baseline_commit: 'abc123',
      token_source: 'pat',
      cohorts: ['C1', 'C2', 'C3', 'C4'],
      clean_shutdown: true,
      row_results: Object.fromEntries(results),
      sweep: { pass: 0, residual_history: [], non_decrease_streak: 0, hard_stopped: null },
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    // `runTier3Sweep` sleeps SWEEP_COOLDOWN_MS (15 min) BEFORE its first
    // pass, and `runSweepPhase` deliberately does not expose the
    // `sleep`/`cooldownMs` options — so drive the clock rather than
    // weakening the production signature just to make it testable.
    vi.useFakeTimers()
    try {
      const pending = runSweepPhase(
        [snapshotRow('resid-1')],
        BRANCH_MAP,
        scanDeps,
        results,
        checkpoint,
        checkpointPath
      )
      const assertion = expect(pending).rejects.toThrow(/SMI-6015|SMI-6436|coheren/i)
      await vi.advanceTimersByTimeAsync(SWEEP_COOLDOWN_MS + 1)
      await assertion
    } finally {
      vi.useRealTimers()
    }

    // The poisoned outcome must not have replaced the residual row, and no
    // checkpoint may have been written carrying it.
    expect(results.get('resid-1')?.outcome).toBe('unevaluable')
    expect(existsSync(checkpointPath)).toBe(false)
  })
})

describe('SMI-6481 guard call sites — report build', () => {
  it('refuses to emit a report whose rows contain an incoherent row', () => {
    const results = new Map<string, SimRowResult>([['poison-1', incoherentResult('poison-1')]])
    expect(() =>
      buildSimulateFullReport(
        {
          runId: 'run-1',
          purpose: 'quarantine_efficacy',
          status: 'sealed',
          tokenSource: 'pat',
          baselineCommit: 'abc123',
          rowsByCohort: { C1: [], C2: [snapshotRow('poison-1')], C3: [], C4: [] },
          results,
          startedAt: new Date(),
          totalRows: 1,
        },
        1,
        { passes_run: 0, hard_stopped: null }
      )
    ).toThrow(/SMI-6015|SMI-6436|coheren/i)
  })
})

describe('SMI-6481 guard call sites — preflight estimate', () => {
  it('refuses to produce a sampling estimate from incoherent rows', async () => {
    processRowMock.mockImplementation(async (row: SimSnapshotRow) => incoherentResult(row.id))

    const db = {
      getRunSummary: async () => ({ purpose: 'quarantine_efficacy', status: 'sealed' }),
      loadCohortRows: async () => [snapshotRow('p-1'), snapshotRow('p-2')],
      loadBranchMap: async () => BRANCH_MAP,
    } as unknown as Smi5879SimulateFullDbDeps

    await expect(
      runPreflightEstimate(
        db,
        vi.fn() as never,
        vi.fn() as never,
        {
          runId: 'run-1',
          purpose: 'quarantine_efficacy',
          apply: true,
          sampleSize: 2,
          seed: 42,
          baselineCommit: 'abc123',
        },
        { GITHUB_TOKEN: 'ghp_fake_token_for_test' } as NodeJS.ProcessEnv
      )
    ).rejects.toThrow(/SMI-6015|SMI-6436|coheren/i)
  })
})
