/**
 * SMI-6015 PAT-sharded fetch, Wave 2 item 2: `smi5879-merge-shards.ts` test
 * suite (part 3) — `loadVerifiedPopulation`/`assertReportsBindToGeneration`
 * preconditions (`smi5879-merge-shards.population.ts`): an unsealed
 * generation, a failed digest re-verification, an empty sealed population,
 * and a shard-report/live-generation binding mismatch. These are not on the
 * plan's own minimum test list, but they are the exact "digest-verified,
 * sealed generation only" guardrails that module's doc comment calls
 * "deliberately no flag to skip" — an obvious gap to close, not a separate
 * unit test of `.population.ts` in isolation: every case here goes through
 * the real `runMergeShards` orchestration, proving the wiring. Row-level
 * invariants (overlap/gap/coverage/hard_stopped/identity) live in
 * `smi5879-merge-shards.invariants.test.ts`. Shared fixtures in
 * `smi5879-merge-shards.fixtures.ts`.
 * @module scripts/tests/indexer/smi5879-merge-shards.population-binding
 *
 * Plan: docs/internal/implementation/smi-6015-pat-sharded-fetch-plan.md
 *       ("### 3. N-way checkpoint/report merge tool (new script)")
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { runMergeShards } from '../../indexer/smi5879-merge-shards.ts'
import type { SimSnapshotRow } from '../../indexer/smi5879-simulate-full.types.ts'
import {
  buildThreeShardFixture,
  makeMergeShardsDb,
  makeScratchDir,
  mergeArgs,
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

/** Write the standard 3-shard fixture's reports and return ready-to-use args. */
function setUpThreeShards(dir: string): { paths: string[]; population: SimSnapshotRow[] } {
  const fixture = buildThreeShardFixture()
  const paths = fixture.shardRows.map((rows, i) => writeShardReport(dir, i, rows, fixture.totals))
  return { paths, population: fixture.population }
}

describe('runMergeShards — generation not sealed (hard fail)', () => {
  it('throws when the live generation is not "sealed"', async () => {
    const dir = scratch()
    const { paths, population } = setUpThreeShards(dir)
    const db = makeMergeShardsDb(population, {
      async getRunSummary() {
        return { purpose: 'decision', status: 'open' }
      },
    })
    const args = mergeArgs(paths, join(dir, 'merged.json'))

    await expect(runMergeShards(db, args)).rejects.toThrow(/is "open", not "sealed"/)
  })
})

describe('runMergeShards — digest re-verification failure (hard fail)', () => {
  it('throws when the population digest no longer matches its sealed-time value', async () => {
    const dir = scratch()
    const { paths, population } = setUpThreeShards(dir)
    const db = makeMergeShardsDb(population, {
      async verifyDigest() {
        return { populationMatches: false, branchMatches: true }
      },
    })
    const args = mergeArgs(paths, join(dir, 'merged.json'))

    await expect(runMergeShards(db, args)).rejects.toThrow(/digest verification failed/)
  })
})

describe('runMergeShards — empty sealed population (hard fail)', () => {
  it('throws rather than vacuously "proving" set equality for an empty population', async () => {
    const dir = scratch()
    const { paths } = setUpThreeShards(dir)
    const db = makeMergeShardsDb([]) // loadCohortRows returns zero rows
    const args = mergeArgs(paths, join(dir, 'merged.json'))

    await expect(runMergeShards(db, args)).rejects.toThrow(/sealed population.*is empty/)
  })
})

describe('runMergeShards — shard reports do not bind to the generation being merged (hard fail)', () => {
  it('throws when --run-id does not match the shard reports own run_id', async () => {
    const dir = scratch()
    const { paths, population } = setUpThreeShards(dir)
    const db = makeMergeShardsDb(population)
    const args = mergeArgs(paths, join(dir, 'merged.json'), 'a-completely-different-run-id')

    await expect(runMergeShards(db, args)).rejects.toThrow(
      /do not bind to the generation being merged/
    )
  })

  it('throws when the live generation summary purpose disagrees with the shard reports', async () => {
    const dir = scratch()
    const { paths, population } = setUpThreeShards(dir)
    const db = makeMergeShardsDb(population, {
      async getRunSummary() {
        return { purpose: 'rehearsal', status: 'sealed' }
      },
    })
    const args = mergeArgs(paths, join(dir, 'merged.json'))

    await expect(runMergeShards(db, args)).rejects.toThrow(
      /do not bind to the generation being merged.*purpose/s
    )
  })
})
