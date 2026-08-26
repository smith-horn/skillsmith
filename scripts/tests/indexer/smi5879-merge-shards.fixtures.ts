/**
 * SMI-6015 PAT-sharded fetch, Wave 2 item 2 (plan
 * `docs/internal/implementation/smi-6015-pat-sharded-fetch-plan.md`, "###
 * Step 2: Merge-tool test suite"): shared fixtures for the
 * smi5879-merge-shards.ts / .merge-rules.ts / .population.ts test suite,
 * split across smi5879-merge-shards.test.ts / .invariants.test.ts /
 * .population-binding.test.ts / .gate-wiring.test.ts (CLAUDE.md's
 * <500-line-per-file convention — the same shape the sibling
 * smi5879-gate-check.ts suite already uses around its own
 * smi5879-gate-check.fixtures.ts).
 * @module scripts/tests/indexer/smi5879-merge-shards.fixtures
 *
 * Every builder here produces a MATCHED population row + shard-report row
 * pair for the same id/cohort/author/name —
 * `assertMergedRowsMatchPopulation` (`smi5879-merge-shards.population.ts`)
 * compares those exact fields between a shard-reported row and its
 * canonical population row, so a fixture that hand-built the two separately
 * would risk an accidental field drift the real tests never intend to
 * exercise.
 *
 * Reuses, not reinvents, the two existing SMI-5879 fixture modules:
 * `makeRow`/`makeFakeDb` (`smi5879-simulate-full.fixtures.ts`) for the
 * population-row shape and the fake `Smi5879SimulateFullDbDeps` this tool's
 * own `Smi5879MergeShardsDbDeps` is a structural `Pick` of (so `makeFakeDb`'s
 * return value satisfies it directly, per that module's own module doc);
 * `makeSimRow`/`makeCoverage`/`makeSimulatorReportJson`/`writeFixtureFile`/
 * `makeScratchDir`/`SAMPLE_COMMIT` (`smi5879-gate-check.fixtures.ts`) for the
 * shard-report JSON shape `loadSimulatorReport` validates.
 */

import {
  makeCoverage,
  makeSimRow,
  makeSimulatorReportJson,
  makeScratchDir,
  writeFixtureFile,
  SAMPLE_COMMIT,
} from './smi5879-gate-check.fixtures.ts'
import { makeFakeDb, makeRow } from './smi5879-simulate-full.fixtures.ts'
import type {
  MergeShardsCliArgs,
  Smi5879MergeShardsDbDeps,
} from '../../indexer/smi5879-merge-shards.ts'
import { ALL_SIMULATED_COHORTS } from '../../indexer/smi5879-simulate-full.types.ts'
import type { SimSnapshotRow, SimulatedCohort } from '../../indexer/smi5879-simulate-full.types.ts'

export { makeScratchDir, writeFixtureFile, makeSimulatorReportJson, SAMPLE_COMMIT }

export const MERGE_RUN_ID = 'smi5879-merge-test-run'

// ---------------------------------------------------------------------------
// One id's canonical population row + its matching shard-reported row
// ---------------------------------------------------------------------------

export interface FixtureRowPair {
  population: SimSnapshotRow
  reportRow: Record<string, unknown>
}

export function fixtureRow(
  id: string,
  cohort: SimulatedCohort = 'C2',
  overrides: { outcome?: string } = {}
): FixtureRowPair {
  return {
    population: makeRow({ id, cohort, author: 'acme', name: id }),
    reportRow: makeSimRow({
      id,
      cohort,
      author: 'acme',
      name: id,
      outcome: overrides.outcome ?? 'unchanged_clean',
    }),
  }
}

export function totalsFor(population: readonly SimSnapshotRow[]): Record<SimulatedCohort, number> {
  const totals: Record<SimulatedCohort, number> = { C1: 0, C2: 0, C3: 0, C4: 0 }
  for (const row of population) totals[row.cohort] += 1
  return totals
}

/**
 * Build one shard's `coverage` object. `scanned`/`unevaluable`/`unfetchable`
 * are ALWAYS derived from THAT shard's own `reportRows` — `loadSimulatorReport`
 * cross-validates every report individually via
 * `validateSimulatorReportConsistency` (`coverage[cohort].scanned` must equal
 * the actual cohort-row count in THAT SAME report), so a fixture that got
 * this wrong would fail to load long before the merge tool's own logic ran.
 * `total` is taken from `totals` — the authoritative per-cohort population
 * count, identical across every shard's own coverage object unless a test
 * deliberately passes a mismatched `totals` for one shard (the whole point of
 * the coverage-total-mismatch and population-total-mismatch invariant tests).
 */
export function coverageForShard(
  reportRows: readonly Record<string, unknown>[],
  totals: Record<SimulatedCohort, number>
): Record<string, unknown> {
  const coverage: Record<string, unknown> = {}
  for (const cohort of ALL_SIMULATED_COHORTS) {
    const cohortRows = reportRows.filter((r) => r['cohort'] === cohort)
    const unevaluable = cohortRows.filter((r) => r['outcome'] === 'unevaluable').length
    const unfetchable = cohortRows.filter((r) => r['outcome'] === 'unfetchable').length
    const total = totals[cohort]
    coverage[cohort] = makeCoverage({
      scanned: cohortRows.length,
      total,
      unevaluable,
      unfetchable,
      status: cohortRows.length === total && unevaluable === 0 ? 'full' : 'partial',
    })
  }
  return coverage
}

/**
 * Assemble one shard's full report JSON — `coverage` always explicit (see
 * {@link coverageForShard}'s doc).
 */
export function shardReportJson(
  reportRows: readonly Record<string, unknown>[],
  totals: Record<SimulatedCohort, number>,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return makeSimulatorReportJson({
    run_id: MERGE_RUN_ID,
    rows: reportRows,
    coverage: coverageForShard(reportRows, totals),
    ...overrides,
  })
}

/**
 * {@link shardReportJson} + {@link writeFixtureFile} in one call — keeps
 * every test file's per-shard call sites short.
 */
export function writeShardReport(
  dir: string,
  index: number,
  reportRows: readonly Record<string, unknown>[],
  totals: Record<SimulatedCohort, number>,
  overrides: Record<string, unknown> = {}
): string {
  return writeFixtureFile(dir, `shard${index}.json`, shardReportJson(reportRows, totals, overrides))
}

export function makeMergeShardsDb(
  population: readonly SimSnapshotRow[],
  overrides: Partial<Smi5879MergeShardsDbDeps> = {}
): Smi5879MergeShardsDbDeps {
  return makeFakeDb({
    async getRunSummary() {
      return { purpose: 'decision', status: 'sealed' }
    },
    async verifyDigest() {
      return { populationMatches: true, branchMatches: true }
    },
    async loadCohortRows() {
      return [...population]
    },
    ...overrides,
  })
}

export function mergeArgs(
  reportPaths: readonly string[],
  outputPath: string,
  runId: string = MERGE_RUN_ID
): MergeShardsCliArgs {
  return { runId, reportPaths: [...reportPaths], outputPath }
}

// ---------------------------------------------------------------------------
// A clean, 3-shard, 6-row, 2-cohort (C2/C3) disjoint population — the base
// fixture the happy-path and gate-wiring tests build on, and the seed most
// invariant tests mutate exactly ONE thing away from.
// ---------------------------------------------------------------------------

type ShardRowPair = [Record<string, unknown>, Record<string, unknown>]

export interface ThreeShardFixture {
  population: SimSnapshotRow[]
  allReportRows: Record<string, unknown>[]
  /**
   * Each shard's own 2 rows, as a fixed-length pair — tuple-typed so
   * `shardRows[i][j]` never needs an `undefined` guard.
   */
  shardRows: [ShardRowPair, ShardRowPair, ShardRowPair]
  totals: Record<SimulatedCohort, number>
}

export function buildThreeShardFixture(): ThreeShardFixture {
  const c2a = fixtureRow('row-c2-1', 'C2')
  const c2b = fixtureRow('row-c2-2', 'C2')
  const c2c = fixtureRow('row-c2-3', 'C2')
  const c3a = fixtureRow('row-c3-1', 'C3')
  const c3b = fixtureRow('row-c3-2', 'C3')
  const c3c = fixtureRow('row-c3-3', 'C3')
  const all = [c2a, c2b, c2c, c3a, c3b, c3c]
  const population = all.map((p) => p.population)
  const allReportRows = all.map((p) => p.reportRow)
  const totals = totalsFor(population)
  const shardRows: ThreeShardFixture['shardRows'] = [
    [c2a.reportRow, c2b.reportRow],
    [c2c.reportRow, c3a.reportRow],
    [c3b.reportRow, c3c.reportRow],
  ]
  return { population, allReportRows, shardRows, totals }
}
