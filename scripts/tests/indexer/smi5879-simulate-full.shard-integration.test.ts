/**
 * SMI-6015 PAT-sharded fetch plan Wave 1 Step 2/claim-wiring:
 * `runSimulateFull` end-to-end with `--shard-index`/`--shard-count` —
 * row-selection filter coverage (Step 2's own test spec: 3 shards against a
 * fixed synthetic population, union of processed-row-id sets equals the
 * full population with zero overlap) and the mutually-exclusive claim-path
 * wiring (plan's Wave 0 Files note: a sharded dispatch calls the
 * shard-aware claim/heartbeat/release trio instead of the plain
 * single-holder ones).
 * @module scripts/tests/indexer/smi5879-simulate-full.shard-integration
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readCheckpoint } from '../../indexer/smi5879-simulate-full.checkpoint.ts'
import { HEARTBEAT_INTERVAL_MS } from '../../indexer/smi5879-simulate-full.helpers.ts'
import { runSimulateFull, type CliArgs } from '../../indexer/smi5879-simulate-full.ts'
import type { SimSnapshotRow } from '../../indexer/smi5879-simulate-full.types.ts'
import {
  makeRow,
  makeFakeDb,
  makeVerdictScanner,
  registerPrimary,
  contentsApiResponse,
  resetRowCounter,
  installFetchMock,
  restoreFetchMock,
  flushMicrotasks,
} from './smi5879-simulate-full.fixtures.ts'

beforeEach(() => {
  resetRowCounter()
  installFetchMock()
})

afterEach(() => {
  restoreFetchMock()
})

describe('runSimulateFull — SMI-6015 PAT-sharded fetch plan Wave 1', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smi5879-sim-shard-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function shardArgs(overrides: Partial<CliArgs> = {}): CliArgs {
    return {
      runId: 'run-shard',
      purpose: 'decision',
      apply: true,
      baselineCommit: 'deadbeef',
      checkpointPath: join(dir, 'checkpoint.json'),
      reportPath: join(dir, 'report.json'),
      ...overrides,
    }
  }

  // -------------------------------------------------------------------------
  // Wave 1 Step 2 test spec: 3 shards against a fixed synthetic population,
  // union of the 3 shards' processed-row-id sets equals the full population
  // with zero overlap.
  // -------------------------------------------------------------------------

  it('3 shards partition a fixed population with zero overlap and full coverage', async () => {
    const rows: SimSnapshotRow[] = Array.from({ length: 30 }, () => makeRow({ cohort: 'C2' }))
    for (const row of rows) {
      // Single-element response array is reusable across all 3 shard runs
      // below (installFetchMock's queue only shifts when length > 1).
      registerPrimary(row, [contentsApiResponse(`# ${row.id}`)])
    }
    const scanner = makeVerdictScanner(new Map())
    const shardIdSets: Set<string>[] = []

    for (let shardIndex = 0; shardIndex < 3; shardIndex++) {
      const db = makeFakeDb({ loadCohortRows: async () => rows })
      const args = shardArgs({
        checkpointPath: join(dir, `checkpoint-shard${shardIndex}.json`),
        reportPath: join(dir, `report-shard${shardIndex}.json`),
        shardIndex,
        shardCount: 3,
      })
      const report = await runSimulateFull(db, scanner, scanner, args, {})
      shardIdSets.push(new Set(report.rows.map((r) => r.id)))
    }

    // Zero overlap: no row id appears in more than one shard's set.
    for (let i = 0; i < shardIdSets.length; i++) {
      for (let j = i + 1; j < shardIdSets.length; j++) {
        const overlap = [...shardIdSets[i]].filter((id) => shardIdSets[j].has(id))
        expect(overlap).toEqual([])
      }
    }

    // Full coverage: the union of all 3 shards' processed rows equals the
    // full population.
    const union = new Set<string>()
    for (const set of shardIdSets) for (const id of set) union.add(id)
    expect(union).toEqual(new Set(rows.map((r) => r.id)))

    // Every shard actually got at least one row — a genuine 30-row/3-shard
    // partition test, not a degenerate case where one shard is empty.
    for (const set of shardIdSets) expect(set.size).toBeGreaterThan(0)
  })

  it("coverage[cohort].total stays the TRUE full-population value in a shard's own report — not just this shard's slice", async () => {
    const rows: SimSnapshotRow[] = Array.from({ length: 12 }, () => makeRow({ cohort: 'C2' }))
    for (const row of rows) registerPrimary(row, [contentsApiResponse(`# ${row.id}`)])
    const scanner = makeVerdictScanner(new Map())
    const db = makeFakeDb({ loadCohortRows: async () => rows })
    const args = shardArgs({ shardIndex: 0, shardCount: 3 })

    const report = await runSimulateFull(db, scanner, scanner, args, {})

    expect(report.coverage.C2.total).toBe(12) // full population, not this shard's ~4-row slice
    expect(report.coverage.C2.scanned).toBeLessThan(12) // this shard only scanned its own slice
    expect(report.coverage.C2.status).toBe('partial') // correctly reflects partial coverage from ONE shard alone
  })

  it('the checkpoint records this run as sharded (shard_index/shard_count persisted)', async () => {
    const rows = [makeRow({ cohort: 'C2' })]
    registerPrimary(rows[0], [contentsApiResponse('# a')])
    const scanner = makeVerdictScanner(new Map())
    const db = makeFakeDb({ loadCohortRows: async () => rows })
    const args = shardArgs({ shardIndex: 1, shardCount: 3 })

    await runSimulateFull(db, scanner, scanner, args, {})

    const checkpoint = readCheckpoint(args.checkpointPath as string)
    expect(checkpoint?.shard_index).toBe(1)
    expect(checkpoint?.shard_count).toBe(3)
  })

  it('an unsharded run never writes shard_index/shard_count to its checkpoint', async () => {
    const rows = [makeRow({ cohort: 'C2' })]
    registerPrimary(rows[0], [contentsApiResponse('# a')])
    const scanner = makeVerdictScanner(new Map())
    const db = makeFakeDb({ loadCohortRows: async () => rows })
    const args = shardArgs()

    await runSimulateFull(db, scanner, scanner, args, {})

    const checkpoint = readCheckpoint(args.checkpointPath as string)
    expect(checkpoint?.shard_index).toBeUndefined()
    expect(checkpoint?.shard_count).toBeUndefined()
  })

  it('refuses to resume a checkpoint written for a different shard', async () => {
    const rows = [makeRow({ cohort: 'C2' })]
    const scanner = makeVerdictScanner(new Map())
    const db = makeFakeDb({ loadCohortRows: async () => rows })
    const firstRunArgs = shardArgs({ shardIndex: 0, shardCount: 3 })
    registerPrimary(rows[0], [contentsApiResponse('# a')])
    await runSimulateFull(db, scanner, scanner, firstRunArgs, {})

    // Same checkpoint path, but a DIFFERENT shard index this time.
    const secondRunArgs = shardArgs({
      checkpointPath: firstRunArgs.checkpointPath,
      shardIndex: 1,
      shardCount: 3,
    })
    await expect(runSimulateFull(db, scanner, scanner, secondRunArgs, {})).rejects.toThrow(
      /does not match this invocation.*shard/s
    )
  })

  // -------------------------------------------------------------------------
  // Mutually-exclusive claim-path wiring (plan's Wave 0 Files note): a
  // sharded dispatch calls the shard-aware claim/heartbeat/release trio
  // instead of the plain single-holder ones — never both.
  // -------------------------------------------------------------------------

  describe('claim-path wiring', () => {
    it('a sharded dispatch calls claimRunShard/releaseRunShard, never the plain claimRun/releaseRun', async () => {
      const rows = [makeRow({ cohort: 'C2' })]
      registerPrimary(rows[0], [contentsApiResponse('# a')])
      const scanner = makeVerdictScanner(new Map())
      const calls: string[] = []
      const db = makeFakeDb({
        loadCohortRows: async () => rows,
        claimRun: async () => {
          calls.push('claimRun')
          return { claimed: true }
        },
        releaseRun: async () => {
          calls.push('releaseRun')
        },
        claimRunShard: async (_runId, shardIndex) => {
          calls.push(`claimRunShard:${shardIndex}`)
          return { claimed: true }
        },
        releaseRunShard: async (_runId, shardIndex) => {
          calls.push(`releaseRunShard:${shardIndex}`)
        },
      })
      const args = shardArgs({ shardIndex: 2, shardCount: 3 })

      await runSimulateFull(db, scanner, scanner, args, {})

      expect(calls).toContain('claimRunShard:2')
      expect(calls).toContain('releaseRunShard:2')
      expect(calls).not.toContain('claimRun')
      expect(calls).not.toContain('releaseRun')
    })

    it('an unsharded dispatch calls the plain claimRun/releaseRun, never the shard-aware trio', async () => {
      const rows = [makeRow({ cohort: 'C2' })]
      registerPrimary(rows[0], [contentsApiResponse('# a')])
      const scanner = makeVerdictScanner(new Map())
      const calls: string[] = []
      const db = makeFakeDb({
        loadCohortRows: async () => rows,
        claimRun: async () => {
          calls.push('claimRun')
          return { claimed: true }
        },
        releaseRun: async () => {
          calls.push('releaseRun')
        },
        claimRunShard: async () => {
          calls.push('claimRunShard')
          return { claimed: true }
        },
        releaseRunShard: async () => {
          calls.push('releaseRunShard')
        },
      })
      const args = shardArgs()

      await runSimulateFull(db, scanner, scanner, args, {})

      expect(calls).toContain('claimRun')
      expect(calls).toContain('releaseRun')
      expect(calls).not.toContain('claimRunShard')
      expect(calls).not.toContain('releaseRunShard')
    })

    it('a refused shard claim throws with the shard index in the message', async () => {
      const db = makeFakeDb({
        claimRunShard: async () => ({ claimed: false }),
      })
      const scanner = makeVerdictScanner(new Map())
      const args = shardArgs({ shardIndex: 1, shardCount: 3 })

      await expect(runSimulateFull(db, scanner, scanner, args, {})).rejects.toThrow(
        /claim of generation run-shard shard 1\/3 was refused/
      )
    })

    // -----------------------------------------------------------------------
    // Round-1 GPT-5.6-Sol review, Medium finding: the claim/release wiring
    // tests above never actually FIRE the heartbeat timer, so they cannot
    // prove heartbeat routing specifically — same fake-timer/blocking-digest
    // pattern as smi5879-simulate-full.test.ts's own heartbeat suite
    // (SMI-5879 review finding 4).
    // -----------------------------------------------------------------------

    afterEach(() => {
      vi.useRealTimers()
    })

    it('a sharded dispatch heartbeats via heartbeatShard, never the plain heartbeat', async () => {
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
      const heartbeat = vi.fn().mockResolvedValue(new Date().toISOString())
      const heartbeatShard = vi.fn().mockResolvedValue(new Date().toISOString())
      const db = makeFakeDb({ verifyDigest: () => digestPromise, heartbeat, heartbeatShard })
      const scanner = makeVerdictScanner(new Map())
      const args = shardArgs({ shardIndex: 2, shardCount: 3 })

      const runPromise = runSimulateFull(db, scanner, scanner, args, {})
      await flushMicrotasks()
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)

      expect(heartbeatShard).toHaveBeenCalledWith('run-shard', 2, expect.any(String))
      expect(heartbeat).not.toHaveBeenCalled()

      resolveDigest({ populationMatches: true, branchMatches: true })
      await runPromise
    })

    it('an unsharded dispatch heartbeats via the plain heartbeat, never heartbeatShard', async () => {
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
      const heartbeat = vi.fn().mockResolvedValue(new Date().toISOString())
      const heartbeatShard = vi.fn().mockResolvedValue(new Date().toISOString())
      const db = makeFakeDb({ verifyDigest: () => digestPromise, heartbeat, heartbeatShard })
      const scanner = makeVerdictScanner(new Map())
      const args = shardArgs()

      const runPromise = runSimulateFull(db, scanner, scanner, args, {})
      await flushMicrotasks()
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)

      expect(heartbeat).toHaveBeenCalledWith('run-shard', expect.any(String))
      expect(heartbeatShard).not.toHaveBeenCalled()

      resolveDigest({ populationMatches: true, branchMatches: true })
      await runPromise
    })

    it('a NULL heartbeatShard result is fatal, same as the unsharded path', async () => {
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
      const heartbeatShard = vi.fn().mockResolvedValue(null)
      const db = makeFakeDb({ verifyDigest: () => digestPromise, heartbeatShard })
      const scanner = makeVerdictScanner(new Map())
      const args = shardArgs({ shardIndex: 0, shardCount: 3 })

      const runPromise = runSimulateFull(db, scanner, scanner, args, {})
      await flushMicrotasks()
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)

      expect(exitSpy).toHaveBeenCalledWith(1)
      const checkpoint = readCheckpoint(args.checkpointPath as string)
      expect(checkpoint?.clean_shutdown).toBe(false)

      resolveDigest({ populationMatches: true, branchMatches: true })
      await runPromise
      exitSpy.mockRestore()
    })

    // -----------------------------------------------------------------------
    // PR #2525 review (GPT-5.6-Sol) High finding: same race as the unsharded
    // twin in smi5879-simulate-full.test.ts — an in-flight heartbeatShard
    // call that resolves null AFTER release must not abort a completed run.
    // -----------------------------------------------------------------------

    it('an in-flight heartbeatShard that resolves null AFTER the run has already completed and released must not abort the process', async () => {
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
      let resolveHeartbeatShard: (v: string | null) => void = () => {}
      const heartbeatShardPromise = new Promise<string | null>((resolve) => {
        resolveHeartbeatShard = resolve
      })
      const heartbeatShard = vi.fn().mockReturnValue(heartbeatShardPromise)
      const db = makeFakeDb({ verifyDigest: () => digestPromise, heartbeatShard })
      const scanner = makeVerdictScanner(new Map())
      const args = shardArgs({ shardIndex: 0, shardCount: 3 })

      const runPromise = runSimulateFull(db, scanner, scanner, args, {})
      await flushMicrotasks()
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
      expect(heartbeatShard).toHaveBeenCalledTimes(1) // tick fired, now in flight

      resolveDigest({ populationMatches: true, branchMatches: true })
      const report = await runPromise
      expect(report.report_kind).toBe('full_simulation')
      expect(exitSpy).not.toHaveBeenCalled()

      resolveHeartbeatShard(null)
      await flushMicrotasks()

      expect(exitSpy).not.toHaveBeenCalled()
      exitSpy.mockRestore()
    })
  })
})
