/**
 * SMI-6015 PAT-sharded fetch, Wave 2 item 2: `smi5879-merge-shards.ts` test
 * suite (part 1) — CLI arg parsing and the N=3 happy path. Invariant hard-
 * fail cases live in `smi5879-merge-shards.invariants.test.ts`;
 * `loadVerifiedPopulation`/`assertReportsBindToGeneration` precondition
 * hard-fails live in `smi5879-merge-shards.population-binding.test.ts`; the
 * `sweep.hard_stopped` -> G-2 wiring and the end-to-end
 * sharding-is-transparent-to-the-gate proof live in
 * `smi5879-merge-shards.gate-wiring.test.ts`. Shared fixtures in
 * `smi5879-merge-shards.fixtures.ts`.
 * @module scripts/tests/indexer/smi5879-merge-shards
 *
 * Plan: docs/internal/implementation/smi-6015-pat-sharded-fetch-plan.md
 *       ("### 3. N-way checkpoint/report merge tool (new script)",
 *       "### Step 2: Merge-tool test suite")
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { loadSimulatorReport } from '../../indexer/smi5879-gate-check.io.ts'
import { parseArgs, runMergeShards, writeMergedReport } from '../../indexer/smi5879-merge-shards.ts'
import {
  MERGE_RUN_ID,
  buildThreeShardFixture,
  fixtureRow,
  makeMergeShardsDb,
  makeScratchDir,
  mergeArgs,
  totalsFor,
  writeShardReport,
  type FixtureRowPair,
} from './smi5879-merge-shards.fixtures.ts'

// ---------------------------------------------------------------------------
// Scratch-dir lifecycle — matches `makeScratchDir()`'s own convention
// (`smi5879-gate-check.fixtures.ts`) of one `mkdtempSync` per test, cleaned
// up here rather than left for the OS temp-dir reaper.
// ---------------------------------------------------------------------------

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
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('parses --run-id/--reports/--output into MergeShardsCliArgs', () => {
    const args = parseArgs(['--run-id=run-1', '--reports=a.json,b.json', '--output=out.json'])
    expect(args).toEqual({
      runId: 'run-1',
      reportPaths: ['a.json', 'b.json'],
      outputPath: 'out.json',
    })
  })

  it('requires --run-id', () => {
    expect(() => parseArgs(['--reports=a.json', '--output=out.json'])).toThrow(/--run-id/)
  })

  it('requires --reports', () => {
    expect(() => parseArgs(['--run-id=run-1', '--output=out.json'])).toThrow(/--reports/)
  })

  it('rejects an empty --reports value', () => {
    expect(() => parseArgs(['--run-id=run-1', '--reports=', '--output=out.json'])).toThrow(
      /--reports/
    )
  })

  it('requires --output', () => {
    expect(() => parseArgs(['--run-id=run-1', '--reports=a.json'])).toThrow(/--output/)
  })

  it('rejects the exact same --reports path listed twice (SMI-6015 Wave 2 CLI safeguard)', () => {
    expect(() =>
      parseArgs(['--run-id=run-1', '--reports=shard0.json,shard0.json', '--output=out.json'])
    ).toThrow(/resolve to the same file/)
  })

  it('rejects two different spellings of the same file passed as separate --reports entries', () => {
    // `./shard0.json` and `shard0.json` resolve to the identical absolute
    // path from the same cwd — the exact "confusing downstream overlap
    // error" scenario `parseArgs`'s own doc comment names.
    expect(() =>
      parseArgs(['--run-id=run-1', '--reports=./shard0.json,shard0.json', '--output=out.json'])
    ).toThrow(/resolve to the same file/)
  })
})

// ---------------------------------------------------------------------------
// N=3 happy path
// ---------------------------------------------------------------------------

describe('runMergeShards — N=3 happy path', () => {
  it('merges 3 disjoint shard reports covering the whole population into one report', async () => {
    const dir = scratch()
    const fixture = buildThreeShardFixture()
    const paths = fixture.shardRows.map((rows, i) => writeShardReport(dir, i, rows, fixture.totals))
    const db = makeMergeShardsDb(fixture.population)
    const args = mergeArgs(paths, join(dir, 'merged.json'))

    const report = await runMergeShards(db, args)

    expect(report.report_kind).toBe('full_simulation')
    expect(report.run_id).toBe(MERGE_RUN_ID)
    expect(report.purpose).toBe('decision')
    expect(report.status).toBe('sealed')
    expect(report.token_source).toBe('pat')
    expect(report.estimated_completion_at).toBeNull()

    // rows: concatenated, set-equal to the whole population, zero duplicates.
    expect(report.rows).toHaveLength(6)
    expect(report.rows.map((r) => r.id).sort()).toEqual(fixture.population.map((r) => r.id).sort())

    // coverage: total identical to the true per-cohort population count,
    // scanned summed across shards, status recomputed as 'full' since every
    // row was accounted for and none is unevaluable.
    expect(report.coverage.C2).toEqual({
      status: 'full',
      scanned: 3,
      total: 3,
      unevaluable: 0,
      unfetchable: 0,
      primaryNotFound: 0,
    })
    expect(report.coverage.C3).toEqual({
      status: 'full',
      scanned: 3,
      total: 3,
      unevaluable: 0,
      unfetchable: 0,
      primaryNotFound: 0,
    })
    expect(report.coverage.C1).toEqual({
      status: 'full',
      scanned: 0,
      total: 0,
      unevaluable: 0,
      unfetchable: 0,
      primaryNotFound: 0,
    })
    expect(report.coverage.C4).toEqual({
      status: 'full',
      scanned: 0,
      total: 0,
      unevaluable: 0,
      unfetchable: 0,
      primaryNotFound: 0,
    })

    // counts: recomputed from the merged rows, sum(counts) === rows.length.
    expect(report.counts.unchanged_clean).toBe(6)
    const countsSum = Object.values(report.counts).reduce((a, b) => a + b, 0)
    expect(countsSum).toBe(report.rows.length)

    // sweep: no shard hard-stopped, passes_run is the max across shards
    // (every shard defaults to `makeSimulatorReportJson`'s passes_run: 1).
    expect(report.sweep).toEqual({ passes_run: 1, hard_stopped: null })
  })

  it('SMI-6442: primaryNotFound sums correctly across shards and stays coverage-neutral', async () => {
    const dir = scratch()
    // primary_not_found is NOT a scored outcome (no primary content was ever
    // fetched successfully) — the real simulator never attaches
    // quarantine/risk-score fields to it, so build these rows by hand rather
    // than via fixtureRow, which always attaches them.
    const pnf1 = fixtureRow('row-pnf-1', 'C2')
    const pnf2 = fixtureRow('row-pnf-2', 'C2')
    const c2c = fixtureRow('row-pnf-3', 'C2')
    const asPrimaryNotFound = (row: FixtureRowPair): FixtureRowPair => ({
      population: row.population,
      reportRow: {
        id: row.reportRow['id'],
        cohort: row.reportRow['cohort'],
        author: row.reportRow['author'],
        name: row.reportRow['name'],
        outcome: 'primary_not_found',
        reason: 'primary SKILL.md not found at this path/ref (404)',
      },
    })
    const c2a = asPrimaryNotFound(pnf1)
    const c2b = asPrimaryNotFound(pnf2)
    const population = [c2a.population, c2b.population, c2c.population]
    const totals = totalsFor(population)
    // Split across two shards so the merge tool must SUM, not just pass through.
    const path0 = writeShardReport(dir, 0, [c2a.reportRow], totals)
    const path1 = writeShardReport(dir, 1, [c2b.reportRow, c2c.reportRow], totals)
    const db = makeMergeShardsDb(population)
    const args = mergeArgs([path0, path1], join(dir, 'merged.json'))

    const report = await runMergeShards(db, args)

    expect(report.coverage.C2).toEqual({
      status: 'full',
      scanned: 3,
      total: 3,
      unevaluable: 0,
      unfetchable: 0,
      primaryNotFound: 2,
    })
    expect(report.counts.primary_not_found).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// writeMergedReport
// ---------------------------------------------------------------------------

describe('writeMergedReport', () => {
  it("writes a merged report that round-trips through the gate's own loadSimulatorReport as ok", async () => {
    const dir = scratch()
    const fixture = buildThreeShardFixture()
    const paths = fixture.shardRows.map((rows, i) => writeShardReport(dir, i, rows, fixture.totals))
    const db = makeMergeShardsDb(fixture.population)
    const outputPath = join(dir, 'merged.json')
    const args = mergeArgs(paths, outputPath)
    const report = await runMergeShards(db, args)

    writeMergedReport(outputPath, report)

    const reloaded = loadSimulatorReport(outputPath, 'merged report')
    expect(reloaded.status).toBe('ok')
    if (reloaded.status === 'ok') {
      expect(reloaded.value.run_id).toBe(MERGE_RUN_ID)
      expect(reloaded.value.rows).toHaveLength(6)
    }
  })
})
