/**
 * SMI-5356: unit tests for the `dequarantine` indexer run-type branch.
 *
 * The dispatch glue in run.ts can't be imported (its top-level main() self-
 * invokes), so the apply-gate + audit-row behaviour is verified here against the
 * extracted sibling module with runSweep / the audit writer / the Supabase
 * client all mocked. The sweep's own clear/keep logic is covered by
 * dequarantine-false-positives.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IndexerEnv } from '../../indexer/parse-env.ts'

const { runSweepMock, writeAuditMock, createClientMock } = vi.hoisted(() => ({
  runSweepMock: vi.fn(),
  writeAuditMock: vi.fn(),
  createClientMock: vi.fn(() => ({ __client: 'mock' })),
}))

vi.mock('../../indexer/dequarantine-false-positives.ts', () => ({
  runSweep: runSweepMock,
}))
vi.mock('../../indexer/indexer-audit-log.ts', () => ({
  writeIndexerAuditLog: writeAuditMock,
}))
vi.mock('../../indexer/_shared/supabase.ts', () => ({
  createSupabaseAdminClient: createClientMock,
}))

import { runDequarantineBranch } from '../../indexer/run-dequarantine-branch.ts'

const sample = {
  total: 33,
  cleared: 33,
  kept: 0,
  fetchFailed: 0,
  parseFailed: 0,
  casSkipped: 0,
  errors: 0,
}

/** Build a minimal IndexerEnv — the branch only reads DEQUARANTINE_DRY_RUN. */
const envWith = (dryRun: boolean): IndexerEnv =>
  ({ DEQUARANTINE_DRY_RUN: dryRun }) as unknown as IndexerEnv

describe('runDequarantineBranch (SMI-5356)', () => {
  beforeEach(() => {
    runSweepMock.mockReset().mockResolvedValue(sample)
    writeAuditMock.mockReset().mockResolvedValue(undefined)
    createClientMock.mockClear()
  })

  it('DEQUARANTINE_DRY_RUN=true => runSweep apply:false (read-only failsafe)', async () => {
    const res = await runDequarantineBranch(envWith(true), 'req-1')
    expect(runSweepMock).toHaveBeenCalledTimes(1)
    expect(runSweepMock).toHaveBeenCalledWith({ apply: false })
    expect(res).toEqual({ dequarantine: sample, dryRun: true })
  })

  it('DEQUARANTINE_DRY_RUN=false => runSweep apply:true (deliberate apply)', async () => {
    const res = await runDequarantineBranch(envWith(false), 'req-2')
    expect(runSweepMock).toHaveBeenCalledWith({ apply: true })
    expect(res.dryRun).toBe(false)
  })

  it('the gate is !DEQUARANTINE_DRY_RUN, NOT the workflow dry_run input', async () => {
    // Even with DRY_RUN-ish noise on the env, only DEQUARANTINE_DRY_RUN decides.
    await runDequarantineBranch(
      { DEQUARANTINE_DRY_RUN: true, DRY_RUN: false } as unknown as IndexerEnv,
      'req-3'
    )
    expect(runSweepMock).toHaveBeenCalledWith({ apply: false })
  })

  it('writes a top-level indexer:run audit row carrying the sweep counts', async () => {
    await runDequarantineBranch(envWith(true), 'req-4')
    expect(writeAuditMock).toHaveBeenCalledTimes(1)
    const [, eventResult, params] = writeAuditMock.mock.calls[0]
    expect(eventResult).toBe('success')
    expect(params.runType).toBe('dequarantine')
    expect(params.dryRun).toBe(true)
    expect(params.dequarantine).toEqual(sample)
    expect(params.found).toBe(33)
    // The sweep clears — it never quarantines — so the quarantine counter is 0.
    expect(params.quarantined).toBe(0)
    expect(params.cron_slot).toBeNull()
  })

  it('logs a partial result when the sweep reports row errors', async () => {
    runSweepMock.mockResolvedValue({ ...sample, errors: 2 })
    await runDequarantineBranch(envWith(false), 'req-5')
    const [, eventResult, params] = writeAuditMock.mock.calls.at(-1)!
    expect(eventResult).toBe('partial')
    expect(params.failed).toBe(2)
  })

  it('propagates a sweep failure (run.ts records run_error + exits 1)', async () => {
    runSweepMock.mockRejectedValue(new Error('load failed'))
    await expect(runDequarantineBranch(envWith(true), 'req-6')).rejects.toThrow(/load failed/)
    expect(writeAuditMock).not.toHaveBeenCalled()
  })
})
