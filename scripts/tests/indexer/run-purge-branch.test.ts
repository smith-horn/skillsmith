/**
 * SMI-5357: unit tests for the `purge` indexer run-type branch.
 *
 * The dispatch glue in run.ts can't be imported (its top-level main() self-
 * invokes), so the apply-gate + audit-row behaviour is verified here against the
 * extracted sibling module with runPurge / the audit writer / the Supabase
 * client all mocked. The purge's own delete/CSV logic is covered by
 * purge-dead-quarantines.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IndexerEnv } from '../../indexer/parse-env.ts'

const { runPurgeMock, writeAuditMock, createClientMock } = vi.hoisted(() => ({
  runPurgeMock: vi.fn(),
  writeAuditMock: vi.fn(),
  createClientMock: vi.fn(() => ({ __client: 'mock' })),
}))

vi.mock('../../indexer/purge-dead-quarantines.ts', () => ({
  runPurge: runPurgeMock,
}))
vi.mock('../../indexer/indexer-audit-log.ts', () => ({
  writeIndexerAuditLog: writeAuditMock,
}))
vi.mock('../../indexer/_shared/supabase.ts', () => ({
  createSupabaseAdminClient: createClientMock,
}))

import { runPurgeBranch } from '../../indexer/run-purge-branch.ts'

const sample = {
  total: 33,
  byCohort: { 'no-repo-url': 0, repository: 33 },
  deleted: 33,
  approvalsDeleted: 5,
}

/** Build a minimal IndexerEnv — the branch only reads PURGE_DRY_RUN. */
const envWith = (dryRun: boolean): IndexerEnv =>
  ({ PURGE_DRY_RUN: dryRun }) as unknown as IndexerEnv

describe('runPurgeBranch (SMI-5357)', () => {
  beforeEach(() => {
    runPurgeMock.mockReset().mockResolvedValue(sample)
    writeAuditMock.mockReset().mockResolvedValue(undefined)
    createClientMock.mockClear()
  })

  it('PURGE_DRY_RUN=true => runPurge apply:false (read-only failsafe)', async () => {
    const res = await runPurgeBranch(envWith(true), 'req-1')
    expect(runPurgeMock).toHaveBeenCalledTimes(1)
    expect(runPurgeMock).toHaveBeenCalledWith({ apply: false })
    expect(res).toEqual({ purge: sample, dryRun: true })
  })

  it('PURGE_DRY_RUN=false => runPurge apply:true (deliberate apply)', async () => {
    const res = await runPurgeBranch(envWith(false), 'req-2')
    expect(runPurgeMock).toHaveBeenCalledWith({ apply: true, limit: undefined })
    expect(res.dryRun).toBe(false)
  })

  it('PURGE_LIMIT is threaded to runPurge for a staged apply', async () => {
    await runPurgeBranch(
      { PURGE_DRY_RUN: false, PURGE_LIMIT: 100 } as unknown as IndexerEnv,
      'req-limit'
    )
    expect(runPurgeMock).toHaveBeenCalledWith({ apply: true, limit: 100 })
  })

  it('the gate is !PURGE_DRY_RUN, NOT the workflow dry_run input', async () => {
    // Even with DRY_RUN-ish noise on the env, only PURGE_DRY_RUN decides.
    await runPurgeBranch({ PURGE_DRY_RUN: true, DRY_RUN: false } as unknown as IndexerEnv, 'req-3')
    expect(runPurgeMock).toHaveBeenCalledWith({ apply: false })
  })

  it('writes a top-level indexer:run audit row carrying the purge counts', async () => {
    await runPurgeBranch(envWith(true), 'req-4')
    expect(writeAuditMock).toHaveBeenCalledTimes(1)
    const [, eventResult, params] = writeAuditMock.mock.calls[0]
    expect(eventResult).toBe('success')
    expect(params.runType).toBe('purge')
    expect(params.dryRun).toBe(true)
    expect(params.purge).toEqual(sample)
    expect(params.found).toBe(33)
    // Purge never quarantines; the quarantine counter stays 0.
    expect(params.quarantined).toBe(0)
    expect(params.cron_slot).toBeNull()
  })

  it('dry-run and apply both write the audit row (apply=false is still observable)', async () => {
    await runPurgeBranch(envWith(false), 'req-5')
    const [, eventResult, params] = writeAuditMock.mock.calls[0]
    expect(eventResult).toBe('success')
    expect(params.dryRun).toBe(false)
    expect(params.purge).toEqual(sample)
  })

  it('propagates a purge failure (run.ts records run_error + exits 1)', async () => {
    runPurgeMock.mockRejectedValue(new Error('export integrity check failed'))
    await expect(runPurgeBranch(envWith(false), 'req-6')).rejects.toThrow(
      /export integrity check failed/
    )
    // Audit log is NOT written when the purge itself throws.
    expect(writeAuditMock).not.toHaveBeenCalled()
  })
})
