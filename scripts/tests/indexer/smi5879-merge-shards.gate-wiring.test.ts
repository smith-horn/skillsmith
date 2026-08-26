/**
 * SMI-6015 PAT-sharded fetch, Wave 2 item 2: `smi5879-merge-shards.ts` test
 * suite (part 4) — the two tests that prove the merge tool's OUTPUT wires
 * correctly into the real gate evaluators (`evaluateG2`/`evaluateG3`,
 * `smi5879-gate-check.gates.ts`), not just that the merge tool's own
 * invariants hold in isolation:
 *
 *   1. a single shard's non-null `sweep.hard_stopped` survives the merge and
 *      makes `evaluateG2` return INCONCLUSIVE against the MERGED report —
 *      the plan's own explicit test-list item ("verify evaluateG2 then
 *      returns INCONCLUSIVE against the merged output, not a separate unit
 *      test of the gate itself — proves the wiring").
 *   2. Wave 2 Step 2's own end-to-end requirement: a 3-shard merge over a
 *      synthetic population produces a report that `evaluateG2`/`evaluateG3`
 *      accept IDENTICALLY to how they'd accept a genuine single-process,
 *      unsharded report over the SAME population — i.e. sharding is
 *      provably transparent to the gate.
 *
 * N=3 happy path and CLI parsing live in `smi5879-merge-shards.test.ts`;
 * row-level and population-binding hard-fail invariants live in
 * `smi5879-merge-shards.invariants.test.ts` /
 * `smi5879-merge-shards.population-binding.test.ts`. Shared fixtures in
 * `smi5879-merge-shards.fixtures.ts`.
 * @module scripts/tests/indexer/smi5879-merge-shards.gate-wiring
 *
 * Plan: docs/internal/implementation/smi-6015-pat-sharded-fetch-plan.md
 *       ("### 3. N-way checkpoint/report merge tool (new script)",
 *       "### Step 2: Merge-tool test suite")
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { evaluateG2, evaluateG3 } from '../../indexer/smi5879-gate-check.gates.ts'
import { loadSimulatorReport } from '../../indexer/smi5879-gate-check.io.ts'
import { runMergeShards } from '../../indexer/smi5879-merge-shards.ts'
import {
  MERGE_RUN_ID,
  buildThreeShardFixture,
  makeMergeShardsDb,
  makeScratchDir,
  makeSimulatorReportJson,
  mergeArgs,
  writeFixtureFile,
  writeShardReport,
} from './smi5879-merge-shards.fixtures.ts'

let scratchDirs: string[] = []

function scratch(): string {
  const dir = makeScratchDir()
  scratchDirs.push(dir)
  return dir
}

beforeEach(() => {
  scratchDirs = []
})

afterEach(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// sweep.hard_stopped propagation -> G-2 INCONCLUSIVE (proves the wiring)
// ---------------------------------------------------------------------------

describe('runMergeShards — sweep.hard_stopped propagation wired to G-2 (end-to-end)', () => {
  it('a non-null hard_stopped from one shard survives the merge, making evaluateG2 INCONCLUSIVE', async () => {
    const dir = scratch()
    const fixture = buildThreeShardFixture()

    const path0 = writeShardReport(dir, 0, fixture.shardRows[0], fixture.totals)
    const path1 = writeShardReport(dir, 1, fixture.shardRows[1], fixture.totals, {
      sweep: { passes_run: 5, hard_stopped: 'non_convergence' },
    })
    const path2 = writeShardReport(dir, 2, fixture.shardRows[2], fixture.totals)
    const db = makeMergeShardsDb(fixture.population)
    const args = mergeArgs([path0, path1, path2], join(dir, 'merged.json'))

    const report = await runMergeShards(db, args)

    // Merge-tool-level assertion: hard_stopped propagated, passes_run is the max().
    expect(report.sweep.hard_stopped).toBe('non_convergence')
    expect(report.sweep.passes_run).toBe(5)

    // Gate-level assertion: this is what actually matters — a real gate
    // evaluator, unmodified, rejects the merged report for the right reason.
    const gate = evaluateG2(report, MERGE_RUN_ID)
    expect(gate.outcome).toBe('INCONCLUSIVE')
    expect(gate.reason).toMatch(/hard-stopped \(non_convergence\)/)
  })
})

// ---------------------------------------------------------------------------
// Sharding is provably transparent to the gate
// ---------------------------------------------------------------------------

describe('sharding is provably transparent to the gate (end-to-end)', () => {
  it('a 3-shard merge and a genuine unsharded report over the SAME population evaluate identically', async () => {
    const dir = scratch()
    const fixture = buildThreeShardFixture()

    const shardPaths = fixture.shardRows.map((rows, i) =>
      writeShardReport(dir, i, rows, fixture.totals)
    )
    const db = makeMergeShardsDb(fixture.population)
    const mergedReport = await runMergeShards(db, mergeArgs(shardPaths, join(dir, 'merged.json')))

    // A genuine single-process, unsharded report over the IDENTICAL
    // population: one process's `rows` array is the full concatenation,
    // never split, so its own coverage totals equal what it actually
    // scanned — built independently of the merge tool's own code, straight
    // from `makeSimulatorReportJson`'s default `deriveCoverageFromRows`
    // behavior, then round-tripped through the SAME `loadSimulatorReport`
    // the gate itself uses.
    const unshardedPath = writeFixtureFile(
      dir,
      'unsharded.json',
      makeSimulatorReportJson({ run_id: MERGE_RUN_ID, rows: fixture.allReportRows })
    )
    const loadedUnsharded = loadSimulatorReport(unshardedPath, 'unsharded report')
    if (loadedUnsharded.status !== 'ok') {
      throw new Error(`test fixture itself is invalid: ${loadedUnsharded.reason}`)
    }
    const unshardedReport = loadedUnsharded.value

    const mergedG2 = evaluateG2(mergedReport, MERGE_RUN_ID)
    const unshardedG2 = evaluateG2(unshardedReport, MERGE_RUN_ID)
    expect(mergedG2.outcome).toBe('PASS')
    expect(unshardedG2.outcome).toBe('PASS')
    expect(mergedG2.outcome).toBe(unshardedG2.outcome)

    const mergedG3 = evaluateG3(mergedReport)
    const unshardedG3 = evaluateG3(unshardedReport)
    expect(mergedG3.outcome).toBe('PASS')
    expect(unshardedG3.outcome).toBe('PASS')
    expect(mergedG3.outcome).toBe(unshardedG3.outcome)

    // Not just "same verdict" — the same rows and the same derived
    // counts/coverage a gate actually reads, proving the merge changed
    // nothing observable to either gate.
    expect(mergedReport.rows.map((r) => r.id).sort()).toEqual(
      unshardedReport.rows.map((r) => r.id).sort()
    )
    expect(mergedReport.counts).toEqual(unshardedReport.counts)
    expect(mergedReport.coverage).toEqual(unshardedReport.coverage)
  })
})
