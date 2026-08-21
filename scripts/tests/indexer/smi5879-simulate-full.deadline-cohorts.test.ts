/**
 * SMI-6015 Wave 1: smi5879-simulate-full — wall-clock deadline
 * (`--max-elapsed-minutes`) and cohort scoping (`--cohorts`) end-to-end
 * tests. Split out of `smi5879-simulate-full.test.ts` (grew past the
 * 500-line-per-file gate, `scripts/check-file-length.mjs`) — shared
 * fixtures live in `./smi5879-simulate-full.fixtures.ts`.
 * @module scripts/tests/indexer/smi5879-simulate-full.deadline-cohorts
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readCheckpoint, writeCheckpoint } from '../../indexer/smi5879-simulate-full.checkpoint.ts'
import { runSimulateFull, type CliArgs } from '../../indexer/smi5879-simulate-full.ts'
import type { Smi5879SimulateCheckpoint } from '../../indexer/smi5879-simulate-full.types.ts'
import {
  makeRow,
  makeFakeDb,
  makeVerdictScanner,
  registerPrimary,
  contentsApiResponse,
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

describe('runSimulateFull — SMI-6015 Wave 1 (deadline + cohorts)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smi5879-sim-wave1-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function wave1Args(overrides: Partial<CliArgs> = {}): CliArgs {
    return {
      runId: 'run-wave1',
      purpose: 'decision',
      apply: true,
      baselineCommit: 'deadbeef',
      checkpointPath: join(dir, 'checkpoint.json'),
      reportPath: join(dir, 'report.json'),
      ...overrides,
    }
  }

  it('stops the main pass before any row and writes a partial-coverage checkpoint when the deadline is already past', async () => {
    const rows = [makeRow({ cohort: 'C2' }), makeRow({ cohort: 'C2' })]
    registerPrimary(rows[0], [contentsApiResponse('# a')])
    registerPrimary(rows[1], [contentsApiResponse('# b')])
    const db = makeFakeDb({ loadCohortRows: async () => rows })
    const scanner = makeVerdictScanner(new Map())
    // A negative budget makes deadlineAtMs already in the past the instant
    // it's computed — deterministic, no fake-timer choreography needed.
    const args = wave1Args({ maxElapsedMinutes: -1 })

    const report = await runSimulateFull(db, scanner, scanner, args, {})

    expect(report.coverage.C2.status).toBe('partial')
    expect(report.coverage.C2.scanned).toBe(0)
    expect(report.rows).toHaveLength(0)
    const checkpoint = readCheckpoint(args.checkpointPath as string)
    // Graceful, expected stop — never treated as an abnormal/suspect state.
    expect(checkpoint?.clean_shutdown).toBe(true)
  })

  it('an excluded cohort reports partial with scanned:0, never a spurious full/total:0 (correctness guard-rail)', async () => {
    const included = makeRow({ cohort: 'C4', id: 'included-row' })
    const excluded = makeRow({ cohort: 'C2', id: 'excluded-row' })
    registerPrimary(included, [contentsApiResponse('# included')])
    const db = makeFakeDb({
      getRunSummary: async () => ({ purpose: 'rehearsal', status: 'sealed' }),
      loadCohortRows: async () => [included, excluded],
    })
    const scanner = makeVerdictScanner(new Map())
    const args = wave1Args({ purpose: 'rehearsal', cohorts: ['C4'] })

    const report = await runSimulateFull(db, scanner, scanner, args, {})

    expect(report.coverage.C4.status).toBe('full')
    expect(report.coverage.C4.scanned).toBe(1)
    // The excluded cohort's row was never fetched (no registerPrimary call
    // for it — an unregistered-URL fetch would have thrown and failed this
    // test), and its coverage reflects the REAL total, not a vacuous 'full'.
    expect(report.coverage.C2.status).toBe('partial')
    expect(report.coverage.C2.total).toBe(1)
    expect(report.coverage.C2.scanned).toBe(0)
    expect(report.rows).toHaveLength(1)
    expect(report.rows[0]?.id).toBe('included-row')
  })

  it('refuses to resume a checkpoint written with a different --cohorts scope', async () => {
    const rows = [makeRow({ cohort: 'C4', id: 'c4-row' })]
    const args = wave1Args({ purpose: 'rehearsal', cohorts: ['C4'] })
    const seeded: Smi5879SimulateCheckpoint = {
      run_id: args.runId,
      purpose: args.purpose,
      baseline_commit: args.baselineCommit,
      token_source: 'pat',
      cohorts: ['C2'], // different scope than this invocation's ['C4']
      clean_shutdown: true,
      row_results: {},
      sweep: { pass: 0, residual_history: [], non_decrease_streak: 0, hard_stopped: null },
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    writeCheckpoint(args.checkpointPath as string, seeded)
    const db = makeFakeDb({
      getRunSummary: async () => ({ purpose: 'rehearsal', status: 'sealed' }),
      loadCohortRows: async () => rows,
    })
    const scanner = makeVerdictScanner(new Map())
    await expect(runSimulateFull(db, scanner, scanner, args, {})).rejects.toThrow(
      /does not match this invocation.*cohorts/s
    )
  })
})
