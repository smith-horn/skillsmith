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
import { newRateLimitTelemetry } from '../../indexer/_shared/rate-limit.ts'
import type {
  BranchMap,
  ScanSkillBundleFn,
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

// `runPreflightEstimate` calls `buildGitHubHeaders` before it reaches the code
// under test. Unmocked, that reaches `getInstallationToken()`, which POSTs to
// api.github.com to mint a real App token whenever GITHUB_APP_ID /
// GITHUB_APP_INSTALLATION_ID / GITHUB_APP_PRIVATE_KEY are present in the REAL
// `process.env` — silent in CI (unset) but a live network call under
// `varlock run -- npm test`, which CLAUDE.md documents as a normal invocation.
// The `env` injected into `runPreflightEstimate` only reaches
// `assertPatTokenSource`, so it does not protect this path.
// Partial mock via `importOriginal` — a full replacement would drop the
// module's other exports (e.g. `GitHubAuthError`), which the helpers module
// imports at load time.
vi.mock('../../indexer/_shared/github-auth.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../indexer/_shared/github-auth.ts')>()
  return {
    ...actual,
    buildGitHubHeaders: async () => ({ Authorization: 'token test-token-not-real' }),
  }
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

/**
 * The one guard `incoherentResult` can actually trip, asserted precisely.
 * `incoherentResult` carries all four scored fields, so field-presence and
 * verdict-delta coherence both PASS — only `assertBundleAbsentCoherence`
 * (SMI-6436) can fire. A loose `/SMI-6015|SMI-6436|coheren/i` would also
 * accept an unrelated failure, and would not prove the offending row id
 * reaches the operator, which is what the `findIncoherentRowIds` remediation
 * path depends on.
 */
function expectBundleAbsentMaskingError(err: unknown, rowId: string): void {
  const message = (err as Error).message
  expect(message).toContain('SMI-6436')
  expect(message).toContain(rowId)
  expect(message).toMatch(/is a real verdict change/)
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

/**
 * Fully-typed stub scanner that THROWS if it is ever actually called. Every
 * test here mocks `processRow`, which is the only thing that would reach a
 * scanner — so a call landing here means the mock failed to intercept and the
 * test is silently exercising the real network path. Failing loudly beats a
 * `vi.fn()` that returns `undefined` and lets that go unnoticed.
 */
const unreachableScan: ScanSkillBundleFn = () => {
  throw new Error('scanSkillBundle must not be reached — processRow is mocked in this suite')
}

const scanDeps = {
  scanPostPort: unreachableScan,
  scanPrePort: unreachableScan,
  telemetry: newRateLimitTelemetry(),
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

    const err = await runMainPass(
      [snapshotRow('poison-1')],
      alreadyResults,
      BRANCH_MAP,
      scanDeps,
      onBatchDone
    ).catch((e: unknown) => e)
    expectBundleAbsentMaskingError(err, 'poison-1')

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
      purpose: 'decision',
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
      const settled = pending.catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(SWEEP_COOLDOWN_MS + 1)
      expectBundleAbsentMaskingError(await settled, 'resid-1')
    } finally {
      vi.useRealTimers()
    }

    // The poisoned outcome must not have replaced the residual row, and no
    // checkpoint may have been written carrying it.
    expect(results.get('resid-1')?.outcome).toBe('unevaluable')
    expect(existsSync(checkpointPath)).toBe(false)
  })

  // Control (governance finding S2): without this, an unconditional `throw` at
  // the sweep guard's line would satisfy the negative test above and the whole
  // suite would still pass. `runSweepPhase` has no other test in the repo.
  it('still completes a sweep pass and checkpoints when the rows are coherent', async () => {
    processRowMock.mockImplementation(async (row: SimSnapshotRow) => ({
      ...incoherentResult(row.id),
      outcome: 'newly_cleared' as const,
    }))

    const results = new Map<string, SimRowResult>([
      [
        'resid-1',
        { id: 'resid-1', cohort: 'C2', author: 'acme', name: 'resid-1', outcome: 'unevaluable' },
      ],
    ])
    const checkpointPath = join(tmp, 'sweep-ok-checkpoint.json')
    const checkpoint: Smi5879SimulateCheckpoint = {
      run_id: 'run-1',
      purpose: 'decision',
      baseline_commit: 'abc123',
      token_source: 'pat',
      cohorts: ['C1', 'C2', 'C3', 'C4'],
      clean_shutdown: true,
      row_results: Object.fromEntries(results),
      sweep: { pass: 0, residual_history: [], non_decrease_streak: 0, hard_stopped: null },
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

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
      await vi.advanceTimersByTimeAsync(SWEEP_COOLDOWN_MS + 1)
      await pending
    } finally {
      vi.useRealTimers()
    }

    expect(results.get('resid-1')?.outcome).toBe('newly_cleared')
    expect(existsSync(checkpointPath)).toBe(true)
  })
})

describe('SMI-6481 guard call sites — report build', () => {
  function buildWith(rows: SimRowResult[]) {
    return () =>
      buildSimulateFullReport(
        {
          runId: 'run-1',
          purpose: 'decision',
          status: 'sealed',
          tokenSource: 'pat',
          baselineCommit: 'abc123',
          rowsByCohort: { C1: [], C2: rows.map((r) => snapshotRow(r.id)), C3: [], C4: [] },
          results: new Map(rows.map((r) => [r.id, r])),
          startedAt: new Date(),
          totalRows: rows.length,
        },
        rows.length,
        { passes_run: 0, hard_stopped: null }
      )
  }

  it('refuses to emit a report whose rows contain an incoherent row', () => {
    let caught: unknown
    try {
      buildWith([incoherentResult('poison-1')])()
    } catch (e) {
      caught = e
    }
    expectBundleAbsentMaskingError(caught, 'poison-1')
  })

  // Control (governance finding S2). `buildSimulateFullReport` is pure, so
  // there is no durable side effect to assert the absence of — the negative
  // test can only assert the throw, which makes this control the only thing
  // distinguishing the real guard from an unconditional `throw`.
  it('emits a report normally when every row is coherent', () => {
    const ok: SimRowResult = { ...incoherentResult('ok-1'), outcome: 'newly_cleared' }
    const report = buildWith([ok])()
    expect(report.report_kind).toBe('full_simulation')
    expect(report.counts.newly_cleared).toBe(1)
  })
})

describe('SMI-6481 guard call sites — preflight estimate', () => {
  // `runPreflightEstimate` touches exactly these three of the interface's
  // methods; the rest belong to the claim/heartbeat lifecycle it never enters.
  // Typed through a Pick so the compiler still checks the three that matter,
  // rather than an unchecked `as unknown as` over the whole interface — if any
  // of these three signatures change, this stub breaks.
  const db = {
    getRunSummary: async () => ({ purpose: 'decision', status: 'sealed' }),
    loadCohortRows: async () => [snapshotRow('p-1'), snapshotRow('p-2')],
    loadBranchMap: async () => BRANCH_MAP,
  } as Pick<
    Smi5879SimulateFullDbDeps,
    'getRunSummary' | 'loadCohortRows' | 'loadBranchMap'
  > as Smi5879SimulateFullDbDeps

  const args = {
    runId: 'run-1',
    purpose: 'decision' as const,
    apply: true,
    sampleSize: 2,
    seed: 42,
    baselineCommit: 'abc123',
  }
  const env = { GITHUB_TOKEN: 'ghp_fake_token_for_test' } as NodeJS.ProcessEnv

  it('refuses to produce a sampling estimate from incoherent rows', async () => {
    processRowMock.mockImplementation(async (row: SimSnapshotRow) => incoherentResult(row.id))

    const err = await runPreflightEstimate(db, unreachableScan, unreachableScan, args, env).catch(
      (e: unknown) => e
    )
    expectBundleAbsentMaskingError(err, 'p-')
  })

  // Control (governance finding S2). This also covers the SMI-6481 `getHeaders`
  // wiring fix: before it, `runPreflightEstimate` threw
  // `TypeError: getHeaders is not a function` on the first row in production —
  // and the negative test above could not see that, because a throw was the
  // expected outcome there. This test's success path is what proves the
  // function can complete at all.
  it('produces an estimate when every row is coherent', async () => {
    processRowMock.mockImplementation(async (row: SimSnapshotRow) => ({
      ...incoherentResult(row.id),
      outcome: 'newly_cleared' as const,
    }))

    const report = await runPreflightEstimate(db, unreachableScan, unreachableScan, args, env)
    expect(report.report_kind).toBe('preflight_estimate')
    expect(report.counts.newly_cleared).toBe(2)
    expect(report.verdict_change_rate).toBe(1)
  })
})
