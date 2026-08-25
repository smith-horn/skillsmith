/**
 * SMI-5879 Wave 3 item 3: smi5879-simulate-full.ts / .helpers.ts / .sweep.ts
 * tests — `runSimulateFull` end-to-end orchestration, including SMI-5879
 * review finding 2b (sweep-pass-accounting) and finding 4 (heartbeat). This
 * is the primary file of a suite split across several siblings (this file
 * kept the original name) after the single-file suite grew past the
 * 500-line-per-file gate (`scripts/check-file-length.mjs`):
 *   - `smi5879-simulate-full.classification.test.ts` — `processRow` tier-2
 *     outcome classification, `computeCoverage`, `decideExitCode`,
 *     `assertPatTokenSource`.
 *   - `smi5879-simulate-full.sweep.test.ts` — `runTier3Sweep` (termination
 *     conditions + resume durability, review finding 2a).
 *   - `smi5879-simulate-full.checkpoint.test.ts` — checkpoint I/O.
 *   - `smi5879-simulate-full.cli.test.ts` — `parseArgs` (SMI-6015 Wave 1).
 *   - `smi5879-simulate-full.deadline-cohorts.test.ts` — `--max-elapsed-minutes`
 *     / `--cohorts` end-to-end behavior (SMI-6015 Wave 1).
 *   - `smi5879-simulate-full.fixtures.ts` — shared fixtures/fakes.
 * @module scripts/tests/indexer/smi5879-simulate-full
 *
 * JUDGMENT CALL (flagged per task instructions, carried over unchanged from
 * before the split — see `smi5879-simulate-full.fixtures.ts` for the full
 * rationale): this suite injects fake `Smi5879SimulateFullDbDeps` and
 * `ScanSkillBundleFn` implementations rather than standing up a live
 * Postgres instance. `global.fetch` IS mocked (not skipped) for the
 * primary/sibling GitHub fetch paths, so the REAL `fetchSkillMd`/
 * `fetchSiblingContent`/`parseSkillMdUrl`/`withFetchRetry` machinery is
 * exercised end-to-end; only the network transport and the DB round trip
 * are faked.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HEARTBEAT_INTERVAL_MS } from '../../indexer/smi5879-simulate-full.helpers.ts'
import { SWEEP_COOLDOWN_MS } from '../../indexer/smi5879-simulate-full.sweep.ts'
import { readCheckpoint, writeCheckpoint } from '../../indexer/smi5879-simulate-full.checkpoint.ts'
import { runSimulateFull, type CliArgs } from '../../indexer/smi5879-simulate-full.ts'
import type {
  BranchMap,
  SimSnapshotRow,
  Smi5879SimulateCheckpoint,
} from '../../indexer/smi5879-simulate-full.types.ts'
import {
  makeRow,
  makeFakeDb,
  makeVerdictScanner,
  registerPrimary,
  contentsApiResponse,
  flushMicrotasks,
  resetRowCounter,
  installFetchMock,
  restoreFetchMock,
} from './smi5879-simulate-full.fixtures.ts'

beforeEach(() => {
  resetRowCounter()
  installFetchMock()
})

afterEach(() => {
  restoreFetchMock()
})

// ---------------------------------------------------------------------------
// runSimulateFull — end-to-end orchestration
// ---------------------------------------------------------------------------

describe('runSimulateFull', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smi5879-sim-e2e-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function baseArgs(overrides: Partial<CliArgs> = {}): CliArgs {
    return {
      runId: 'run-e2e',
      purpose: 'decision',
      apply: true,
      baselineCommit: 'deadbeef',
      checkpointPath: join(dir, 'checkpoint.json'),
      reportPath: join(dir, 'report.json'),
      ...overrides,
    }
  }

  it('refuses to run when the generation is not sealed', async () => {
    const db = makeFakeDb({ getRunSummary: async () => ({ purpose: 'decision', status: 'open' }) })
    const scanner = makeVerdictScanner(new Map())
    await expect(runSimulateFull(db, scanner, scanner, baseArgs())).rejects.toThrow(/not "sealed"/)
  })

  it('refuses to run when the purpose does not match the generation', async () => {
    const db = makeFakeDb({ getRunSummary: async () => ({ purpose: 'window', status: 'sealed' }) })
    const scanner = makeVerdictScanner(new Map())
    await expect(
      runSimulateFull(db, scanner, scanner, baseArgs({ purpose: 'decision' }))
    ).rejects.toThrow(/purpose/)
  })

  it('hard-refuses to start when token_source resolves to app', async () => {
    const db = makeFakeDb()
    const scanner = makeVerdictScanner(new Map())
    await expect(
      runSimulateFull(db, scanner, scanner, baseArgs(), {
        GITHUB_APP_ID: 'x',
        GITHUB_APP_INSTALLATION_ID: 'y',
        GITHUB_APP_PRIVATE_KEY: 'z',
      })
    ).rejects.toThrow(/token_source resolved to "app"/)
  })

  it('produces a report_kind: full_simulation report with token_source: pat and full coverage on a clean run', async () => {
    const rows: [SimSnapshotRow, SimSnapshotRow] = [
      makeRow({ cohort: 'C2' }),
      makeRow({ cohort: 'C4' }),
    ]
    registerPrimary(rows[0], [contentsApiResponse('# a')])
    registerPrimary(rows[1], [contentsApiResponse('# b')])
    const db = makeFakeDb({ loadCohortRows: async () => rows })
    const scanner = makeVerdictScanner(new Map())

    const report = await runSimulateFull(db, scanner, scanner, baseArgs(), {})

    expect(report.report_kind).toBe('full_simulation')
    expect(report.token_source).toBe('pat')
    expect(report.run_id).toBe('run-e2e')
    expect(report.coverage.C2.status).toBe('full')
    expect(report.coverage.C4.status).toBe('full')
    expect(report.rows).toHaveLength(2)
    expect(report.sweep.hard_stopped).toBeNull()
  })

  it('resuming from an existing checkpoint does not re-fetch already-resolved rows', async () => {
    const rows: [SimSnapshotRow, SimSnapshotRow] = [
      makeRow({ cohort: 'C2', id: 'resume-a' }),
      makeRow({ cohort: 'C2', id: 'resume-b' }),
    ]
    const db = makeFakeDb({ loadCohortRows: async () => rows })
    const scanner = makeVerdictScanner(new Map())
    const args = baseArgs()

    // Seed a checkpoint where row 'resume-a' is already resolved. Only
    // 'resume-b' needs its primary URL registered — if the resume logic
    // incorrectly re-fetched 'resume-a', the unregistered-URL fetch mock
    // would throw and fail this test.
    const seeded: Smi5879SimulateCheckpoint = {
      run_id: args.runId,
      purpose: args.purpose,
      baseline_commit: args.baselineCommit,
      token_source: 'pat',
      cohorts: ['C1', 'C2', 'C3', 'C4'],
      clean_shutdown: true,
      row_results: {
        'resume-a': {
          id: 'resume-a',
          cohort: 'C2',
          author: 'acme',
          name: 'resume-a',
          outcome: 'unchanged_clean',
        },
      },
      sweep: { pass: 0, residual_history: [], non_decrease_streak: 0, hard_stopped: null },
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    writeCheckpoint(args.checkpointPath as string, seeded)
    registerPrimary(rows[1], [contentsApiResponse('# b')])

    const report = await runSimulateFull(db, scanner, scanner, args, {})

    expect(report.rows).toHaveLength(2)
    expect(report.coverage.C2.status).toBe('full')
    const byId = Object.fromEntries(report.rows.map((r) => [r.id, r]))
    expect(byId['resume-a']).toBeDefined()
    expect(byId['resume-b']).toBeDefined()
    expect(byId['resume-a']?.outcome).toBe('unchanged_clean')
    expect(byId['resume-b']?.outcome).toBe('unchanged_clean')
  })

  it('verifies digest at a cold start but not on a clean resume', async () => {
    const rows: [SimSnapshotRow] = [makeRow({ cohort: 'C2', id: 'digest-row' })]
    registerPrimary(rows[0], [contentsApiResponse('# a')])
    const verifyDigest = vi.fn(async () => ({ populationMatches: true, branchMatches: true }))
    const db = makeFakeDb({ loadCohortRows: async () => rows, verifyDigest })
    const scanner = makeVerdictScanner(new Map())

    await runSimulateFull(db, scanner, scanner, baseArgs(), {})
    expect(verifyDigest).toHaveBeenCalledTimes(1)

    // Second invocation resumes from the checkpoint written by the first
    // (clean_shutdown: true) — digest must NOT be re-verified.
    await runSimulateFull(db, scanner, scanner, baseArgs(), {})
    expect(verifyDigest).toHaveBeenCalledTimes(1)
  })

  it('re-verifies digest when resuming an abnormal (clean_shutdown: false) checkpoint', async () => {
    const rows: [SimSnapshotRow] = [makeRow({ cohort: 'C2', id: 'abnormal-row' })]
    const args = baseArgs()
    const seeded: Smi5879SimulateCheckpoint = {
      run_id: args.runId,
      purpose: args.purpose,
      baseline_commit: args.baselineCommit,
      token_source: 'pat',
      cohorts: ['C1', 'C2', 'C3', 'C4'],
      clean_shutdown: false, // abnormal prior termination
      row_results: {},
      sweep: { pass: 0, residual_history: [], non_decrease_streak: 0, hard_stopped: null },
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    writeCheckpoint(args.checkpointPath as string, seeded)
    registerPrimary(rows[0], [contentsApiResponse('# a')])

    const verifyDigest = vi.fn(async () => ({ populationMatches: true, branchMatches: true }))
    const db = makeFakeDb({ loadCohortRows: async () => rows, verifyDigest })
    const scanner = makeVerdictScanner(new Map())

    await runSimulateFull(db, scanner, scanner, args, {})
    expect(verifyDigest).toHaveBeenCalledTimes(1)
  })

  it('throws when digest verification fails', async () => {
    const rows = [makeRow({ cohort: 'C2' })]
    const db = makeFakeDb({
      loadCohortRows: async () => rows,
      verifyDigest: async () => ({ populationMatches: false, branchMatches: true }),
    })
    const scanner = makeVerdictScanner(new Map())
    await expect(runSimulateFull(db, scanner, scanner, baseArgs(), {})).rejects.toThrow(
      /digest verification failed/
    )
  })

  // -------------------------------------------------------------------------
  // SMI-5879 review finding 1: a wrong --checkpoint-path pointing at another
  // generation's checkpoint must be refused loudly — never silently trusted,
  // even when the checkpoint file itself is syntactically well-formed.
  // -------------------------------------------------------------------------

  it('refuses to resume a checkpoint whose run_id does not match this invocation', async () => {
    const args = baseArgs()
    const seeded: Smi5879SimulateCheckpoint = {
      run_id: 'a-completely-different-generation',
      purpose: args.purpose,
      baseline_commit: args.baselineCommit,
      token_source: 'pat',
      cohorts: ['C1', 'C2', 'C3', 'C4'],
      clean_shutdown: true,
      row_results: {},
      sweep: { pass: 0, residual_history: [], non_decrease_streak: 0, hard_stopped: null },
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    writeCheckpoint(args.checkpointPath as string, seeded)
    const db = makeFakeDb()
    const scanner = makeVerdictScanner(new Map())
    await expect(runSimulateFull(db, scanner, scanner, args, {})).rejects.toThrow(
      /does not match this invocation.*run_id/s
    )
  })

  it('refuses to resume a checkpoint whose row_results reference a row id outside this generation', async () => {
    const rows: [SimSnapshotRow] = [makeRow({ cohort: 'C2', id: 'real-row-in-this-generation' })]
    const args = baseArgs()
    const seeded: Smi5879SimulateCheckpoint = {
      run_id: args.runId,
      purpose: args.purpose,
      baseline_commit: args.baselineCommit,
      token_source: 'pat',
      cohorts: ['C1', 'C2', 'C3', 'C4'],
      clean_shutdown: true,
      row_results: {
        'row-from-a-different-generation': {
          id: 'row-from-a-different-generation',
          cohort: 'C2',
          author: null,
          name: null,
          outcome: 'unchanged_clean',
        },
      },
      sweep: { pass: 0, residual_history: [], non_decrease_streak: 0, hard_stopped: null },
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    writeCheckpoint(args.checkpointPath as string, seeded)
    const db = makeFakeDb({ loadCohortRows: async () => rows })
    const scanner = makeVerdictScanner(new Map())
    // SMI-6015 Wave 1 (round-1 GPT-5.6-Sol review, High finding): error
    // wording broadened when assertCheckpointRowsBelongToGeneration gained
    // shard/cohort scope validation on top of the original generation-
    // membership check — the per-problem message for THIS case
    // ("not in this generation's row set") is unchanged, only the wrapping
    // summary sentence's wording changed.
    await expect(runSimulateFull(db, scanner, scanner, args, {})).rejects.toThrow(
      /row-from-a-different-generation \(not in this generation's row set\)/
    )
  })
})

// ---------------------------------------------------------------------------
// SMI-5879 review finding 2b: `checkpoint.sweep.pass`/`residual_history` must
// be recorded exactly ONCE per pass, using `runTier3Sweep`'s own return
// values as the source of truth — not independently incremented inside the
// per-pass callback AND then added again after the sweep returns.
// ---------------------------------------------------------------------------

describe('runSimulateFull — sweep pass accounting is not doubled (SMI-5879 review finding 2b)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smi5879-sim-sweep-acct-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    vi.useRealTimers()
  })

  it('report.sweep.passes_run and the persisted checkpoint pass count reflect the actual passes run exactly once', async () => {
    vi.useFakeTimers()
    // `default_branch resolution: 'transient'` resolves to 'unevaluable' with
    // ZERO network calls, and NEVER changes between passes (branchMap is
    // loaded once and reused) — so every sweep pass re-resolves to the SAME
    // 'unevaluable' outcome, hard-stopping on non-convergence after exactly
    // 2 real sweep passes, with none of the retry/backoff complexity a
    // network-fetch-based residual would need.
    const row = makeRow({ cohort: 'C2', repo_url: 'https://github.com/acme/transient-repo' })
    const branchMap: BranchMap = new Map([
      ['acme/transient-repo', { resolution: 'transient', default_branch: null }],
    ])
    const db = makeFakeDb({
      loadCohortRows: async () => [row],
      loadBranchMap: async () => branchMap,
    })
    const scanner = makeVerdictScanner(new Map())
    const args: CliArgs = {
      runId: 'run-sweep-acct',
      purpose: 'decision',
      apply: true,
      baselineCommit: 'deadbeef',
      checkpointPath: join(dir, 'checkpoint.json'),
      reportPath: join(dir, 'report.json'),
    }

    const runPromise = runSimulateFull(db, scanner, scanner, args, {})
    // Two sweep passes, each gated behind a SWEEP_COOLDOWN_MS sleep, plus
    // generous slack for heartbeat noise (HEARTBEAT_INTERVAL_MS) along the way.
    await vi.advanceTimersByTimeAsync(SWEEP_COOLDOWN_MS * 2 + HEARTBEAT_INTERVAL_MS * 5)
    const report = await runPromise

    expect(report.sweep.hard_stopped).toBe('non_convergence')
    // The pre-fix bug double-counted: the per-pass callback incremented
    // checkpoint.sweep.pass by 1 on each of the 2 real passes (-> 2), then
    // the final block added sweep.passesRun (2) AGAIN on top (-> 4).
    expect(report.sweep.passes_run).toBe(2)

    const checkpoint = readCheckpoint(args.checkpointPath as string)
    expect(checkpoint?.sweep.pass).toBe(2)
    expect(checkpoint?.sweep.residual_history).toEqual([1, 1])
  })
})

// ---------------------------------------------------------------------------
// SMI-5879 review finding 4: a heartbeat rejection must trigger the SAME
// fatal-abort path as a `null` (lost-claim) result, never an unhandled
// rejection; a slow in-flight heartbeat call must never overlap with a
// second concurrent call from the next tick.
// ---------------------------------------------------------------------------

describe('runSimulateFull — heartbeat (SMI-5879 review finding 4)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smi5879-sim-heartbeat-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    vi.useRealTimers()
  })

  function heartbeatArgs(): CliArgs {
    return {
      runId: 'run-heartbeat',
      purpose: 'decision',
      apply: true,
      baselineCommit: 'deadbeef',
      checkpointPath: join(dir, 'checkpoint.json'),
      reportPath: join(dir, 'report.json'),
    }
  }

  it('a rejected heartbeat call triggers the same fatal-abort path as a null result', async () => {
    vi.useFakeTimers()
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined as never) as typeof process.exit)

    let resolveDigest: (v: {
      populationMatches: boolean
      branchMatches: boolean
    }) => void = () => {}
    const digestPromise = new Promise<{ populationMatches: boolean; branchMatches: boolean }>(
      (resolve) => {
        resolveDigest = resolve
      }
    )
    const heartbeat = vi.fn().mockRejectedValueOnce(new Error('transient network failure'))
    const db = makeFakeDb({ verifyDigest: () => digestPromise, heartbeat })
    const scanner = makeVerdictScanner(new Map())
    const args = heartbeatArgs()

    const runPromise = runSimulateFull(db, scanner, scanner, args, {})
    // Drain the microtask chain (getRunSummary -> claimRun -> ... -> the
    // heartbeat's setTimeout registration -> the blocking verifyDigest await)
    // before advancing the fake heartbeat timer.
    await flushMicrotasks()

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)

    expect(heartbeat).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledWith(1)
    const checkpoint = readCheckpoint(args.checkpointPath as string)
    expect(checkpoint?.clean_shutdown).toBe(false)

    // Let the still-pending runSimulateFull promise settle so the test
    // doesn't leave a floating unhandled promise behind.
    resolveDigest({ populationMatches: true, branchMatches: true })
    await runPromise
    exitSpy.mockRestore()
  })

  it('a slow heartbeat call does not allow a second concurrent in-flight call, and normal ticking resumes once it settles', async () => {
    vi.useFakeTimers()
    let resolveDigest: (v: {
      populationMatches: boolean
      branchMatches: boolean
    }) => void = () => {}
    const digestPromise = new Promise<{ populationMatches: boolean; branchMatches: boolean }>(
      (resolve) => {
        resolveDigest = resolve
      }
    )
    let resolveFirstHeartbeat: (v: string | null) => void = () => {}
    const firstHeartbeatPromise = new Promise<string | null>((resolve) => {
      resolveFirstHeartbeat = resolve
    })
    const heartbeat = vi
      .fn()
      .mockReturnValueOnce(firstHeartbeatPromise)
      .mockResolvedValue(new Date().toISOString())
    const db = makeFakeDb({ verifyDigest: () => digestPromise, heartbeat })
    const scanner = makeVerdictScanner(new Map())
    const args = heartbeatArgs()

    const runPromise = runSimulateFull(db, scanner, scanner, args, {})
    await flushMicrotasks()

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
    expect(heartbeat).toHaveBeenCalledTimes(1) // first tick fired, still in flight

    // A second interval's worth of time passes while the first call is
    // STILL pending — must NOT fire a second, overlapping call.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
    expect(heartbeat).toHaveBeenCalledTimes(1)

    // Now let the first call settle, and confirm ticking resumes normally.
    resolveFirstHeartbeat(new Date().toISOString())
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
    expect(heartbeat).toHaveBeenCalledTimes(2)

    resolveDigest({ populationMatches: true, branchMatches: true })
    await runPromise
  })
})
