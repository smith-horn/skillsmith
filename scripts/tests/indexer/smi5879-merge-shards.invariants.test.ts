/**
 * SMI-6015 PAT-sharded fetch, Wave 2 item 2: `smi5879-merge-shards.ts` test
 * suite (part 2) — the merge-rule table's hard-fail invariants
 * (`smi5879-merge-shards.merge-rules.ts`): row overlap, row gap, coverage-
 * total disagreement (shard-vs-shard AND all-shards-agree-but-wrong-vs-
 * reality), `sweep.hard_stopped` disagreement, identity-field mismatch, and
 * shard-report numeric sanity. N=3 happy path and CLI parsing live in
 * `smi5879-merge-shards.test.ts`; `loadVerifiedPopulation`/
 * `assertReportsBindToGeneration` precondition hard-fails live in
 * `smi5879-merge-shards.population-binding.test.ts`. Shared fixtures in
 * `smi5879-merge-shards.fixtures.ts`.
 * @module scripts/tests/indexer/smi5879-merge-shards.invariants
 *
 * Plan: docs/internal/implementation/smi-6015-pat-sharded-fetch-plan.md
 *       ("### 3. N-way checkpoint/report merge tool (new script)",
 *       "### Step 2: Merge-tool test suite")
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { runMergeShards } from '../../indexer/smi5879-merge-shards.ts'
import {
  buildThreeShardFixture,
  fixtureRow,
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

// ---------------------------------------------------------------------------
// Row overlap
// ---------------------------------------------------------------------------

describe('runMergeShards — row overlap (hard fail)', () => {
  it('throws naming both shard file paths when a row id appears in 2+ shard reports', async () => {
    const dir = scratch()
    const fixture = buildThreeShardFixture()
    const dupRow = fixture.shardRows[1][0] // 'row-c2-3', originally only in shard 1
    const dupId = dupRow['id'] as string

    const path0 = writeShardReport(dir, 0, [...fixture.shardRows[0], dupRow], fixture.totals)
    const path1 = writeShardReport(dir, 1, fixture.shardRows[1], fixture.totals)
    const path2 = writeShardReport(dir, 2, fixture.shardRows[2], fixture.totals)
    const db = makeMergeShardsDb(fixture.population)
    const args = mergeArgs([path0, path1, path2], join(dir, 'merged.json'))

    await expect(runMergeShards(db, args)).rejects.toThrow(
      new RegExp(`${dupId}.*in both.*shard0\\.json.*shard1\\.json`)
    )
  })
})

// ---------------------------------------------------------------------------
// Row gap — the exact-set-equality safety property
// ---------------------------------------------------------------------------

describe('runMergeShards — row gap (hard fail)', () => {
  it('throws when a row in the true population is absent from every shard report', async () => {
    const dir = scratch()
    const fixture = buildThreeShardFixture()
    // A population row NO shard's `rows` array mentions at all.
    const ghost = fixtureRow('row-ghost', 'C2')
    const population = [...fixture.population, ghost.population]

    const paths = fixture.shardRows.map((rows, i) => writeShardReport(dir, i, rows, fixture.totals))
    const db = makeMergeShardsDb(population)
    const args = mergeArgs(paths, join(dir, 'merged.json'))

    await expect(runMergeShards(db, args)).rejects.toThrow(
      /population row\(s\) reported by NO shard.*row-ghost/s
    )
  })
})

// ---------------------------------------------------------------------------
// coverage[cohort].total mismatch — shard vs. shard disagreement
// ---------------------------------------------------------------------------

describe('runMergeShards — mismatched coverage[cohort].total across shards (hard fail)', () => {
  it('throws when shard reports disagree with each other on the same cohort total', async () => {
    const dir = scratch()
    const fixture = buildThreeShardFixture()
    // Shard 1 alone claims a different C2 total than shards 0 and 2.
    const badTotals = { ...fixture.totals, C2: fixture.totals.C2 + 1 }

    const path0 = writeShardReport(dir, 0, fixture.shardRows[0], fixture.totals)
    const path1 = writeShardReport(dir, 1, fixture.shardRows[1], badTotals)
    const path2 = writeShardReport(dir, 2, fixture.shardRows[2], fixture.totals)
    const db = makeMergeShardsDb(fixture.population)
    const args = mergeArgs([path0, path1, path2], join(dir, 'merged.json'))

    await expect(runMergeShards(db, args)).rejects.toThrow(/disagree on coverage\.C2\.total/)
  })
})

// ---------------------------------------------------------------------------
// coverage[cohort].total mismatch — all shards agree, but wrong vs. reality
// (distinct from the shard-vs-shard case above: exercises
// assertCoverageTotalsMatchPopulation specifically)
// ---------------------------------------------------------------------------

describe('runMergeShards — population-total mismatch (all shards agree, all wrong)', () => {
  it('throws via assertCoverageTotalsMatchPopulation when every shard agrees on a WRONG cohort total', async () => {
    const dir = scratch()
    const fixture = buildThreeShardFixture()
    // Every shard reports the SAME total, but it's wrong: the real sealed
    // population has 3 C2 rows, every shard claims 4.
    const wrongTotals = { ...fixture.totals, C2: fixture.totals.C2 + 1 }

    const paths = fixture.shardRows.map((rows, i) => writeShardReport(dir, i, rows, wrongTotals))
    const db = makeMergeShardsDb(fixture.population) // unchanged — really 3 C2 rows
    const args = mergeArgs(paths, join(dir, 'merged.json'))

    await expect(runMergeShards(db, args)).rejects.toThrow(
      /shard-reported cohort total\(s\) do not match the digest-verified sealed population/
    )
  })
})

// ---------------------------------------------------------------------------
// sweep.hard_stopped disagreement
// ---------------------------------------------------------------------------

describe('runMergeShards — sweep.hard_stopped DISAGREEMENT across shards (hard fail)', () => {
  it('throws when two shards report DIFFERENT non-null hard_stopped reasons', async () => {
    const dir = scratch()
    const fixture = buildThreeShardFixture()

    const path0 = writeShardReport(dir, 0, fixture.shardRows[0], fixture.totals, {
      sweep: { passes_run: 2, hard_stopped: 'non_convergence' },
    })
    const path1 = writeShardReport(dir, 1, fixture.shardRows[1], fixture.totals, {
      sweep: { passes_run: 3, hard_stopped: 'max_passes' },
    })
    const path2 = writeShardReport(dir, 2, fixture.shardRows[2], fixture.totals)
    const db = makeMergeShardsDb(fixture.population)
    const args = mergeArgs([path0, path1, path2], join(dir, 'merged.json'))

    await expect(runMergeShards(db, args)).rejects.toThrow(/disagree on sweep\.hard_stopped/)
  })
})

// ---------------------------------------------------------------------------
// Identity field mismatch
// ---------------------------------------------------------------------------

describe('runMergeShards — identity field mismatch (hard fail)', () => {
  it('throws naming the field when shard reports disagree on baseline_commit', async () => {
    const dir = scratch()
    const fixture = buildThreeShardFixture()

    const path0 = writeShardReport(dir, 0, fixture.shardRows[0], fixture.totals)
    const path1 = writeShardReport(dir, 1, fixture.shardRows[1], fixture.totals, {
      baseline_commit: 'b'.repeat(40),
    })
    const path2 = writeShardReport(dir, 2, fixture.shardRows[2], fixture.totals)
    const db = makeMergeShardsDb(fixture.population)
    const args = mergeArgs([path0, path1, path2], join(dir, 'merged.json'))

    await expect(runMergeShards(db, args)).rejects.toThrow(
      /disagree on field\(s\).*baseline_commit/s
    )
  })
})

// ---------------------------------------------------------------------------
// Shard-report numeric sanity (defense in depth beyond loadSimulatorReport's
// bare `typeof n !== 'number'` check, which a negative/fractional/NaN value
// passes — assertShardReportNumericSanity, smi5879-merge-shards.merge-rules.ts)
// ---------------------------------------------------------------------------

describe('runMergeShards — shard-report numeric sanity (hard fail)', () => {
  it('throws when a shard report has a negative sweep.passes_run', async () => {
    const dir = scratch()
    const fixture = buildThreeShardFixture()

    const path0 = writeShardReport(dir, 0, fixture.shardRows[0], fixture.totals, {
      sweep: { passes_run: -1, hard_stopped: null },
    })
    const path1 = writeShardReport(dir, 1, fixture.shardRows[1], fixture.totals)
    const path2 = writeShardReport(dir, 2, fixture.shardRows[2], fixture.totals)
    const db = makeMergeShardsDb(fixture.population)
    const args = mergeArgs([path0, path1, path2], join(dir, 'merged.json'))

    await expect(runMergeShards(db, args)).rejects.toThrow(
      /sweep\.passes_run=-1, which is not a non-negative integer/
    )
  })
})

// ---------------------------------------------------------------------------
// Row-outcome coherence (Wave 2 adversarial review High finding): none of
// the checks above catch a row whose `outcome` label disagrees with its own
// prePortQuarantine/postPortQuarantine fields — this can pass id
// disjointness, population set-equality, and every coverage/count arithmetic
// check, because `counts` is recomputed from the SAME (already-wrong)
// `outcome` field the label itself carries.
// ---------------------------------------------------------------------------

describe('runMergeShards — row-outcome coherence (hard fail)', () => {
  it('throws when a verdict-delta outcome disagrees with its own prePortQuarantine/postPortQuarantine', async () => {
    const dir = scratch()
    const fixture = buildThreeShardFixture()
    // Real quarantine booleans say unchanged_quarantined (true/true), but the
    // row's own outcome label claims unchanged_clean — a genuine population
    // id, so id-disjointness and set-equality both pass; the label itself is
    // the only thing wrong.
    const tampered = fixtureRow('row-c2-1', 'C2', {
      outcome: 'unchanged_clean',
      prePortQuarantine: true,
      postPortQuarantine: true,
    })

    const path0 = writeShardReport(
      dir,
      0,
      [tampered.reportRow, fixture.shardRows[0][1]],
      fixture.totals
    )
    const path1 = writeShardReport(dir, 1, fixture.shardRows[1], fixture.totals)
    const path2 = writeShardReport(dir, 2, fixture.shardRows[2], fixture.totals)
    const db = makeMergeShardsDb(fixture.population)
    const args = mergeArgs([path0, path1, path2], join(dir, 'merged.json'))

    await expect(runMergeShards(db, args)).rejects.toThrow(
      /row-c2-1.*outcome=unchanged_clean.*prePortQuarantine=true.*postPortQuarantine=true.*implies unchanged_quarantined/s
    )
  })

  it('throws (via field-presence, which runs first) when a verdict-delta outcome is missing its prePortQuarantine/postPortQuarantine fields', async () => {
    const dir = scratch()
    const fixture = buildThreeShardFixture()
    const tampered = {
      ...fixtureRow('row-c2-1', 'C2', { outcome: 'newly_quarantined' }).reportRow,
    }
    delete tampered['prePortQuarantine']
    delete tampered['postPortQuarantine']

    const path0 = writeShardReport(dir, 0, [tampered, fixture.shardRows[0][1]], fixture.totals)
    const path1 = writeShardReport(dir, 1, fixture.shardRows[1], fixture.totals)
    const path2 = writeShardReport(dir, 2, fixture.shardRows[2], fixture.totals)
    const db = makeMergeShardsDb(fixture.population)
    const args = mergeArgs([path0, path1, path2], join(dir, 'merged.json'))

    await expect(runMergeShards(db, args)).rejects.toThrow(
      /row-c2-1.*outcome=newly_quarantined is a scored outcome, but has neither field/s
    )
  })

  it("throws (round-2 confirmation review finding) when a row mislabeled unfetchable still carries a real newly_quarantined row's quarantine fields", async () => {
    const dir = scratch()
    const fixture = buildThreeShardFixture()
    // The exact round-2 attack: a genuinely newly_quarantined row (pre=false,
    // post=true) relabeled `unfetchable` — the round-1 coherence check alone
    // would skip this entirely (unfetchable isn't in VERDICT_DELTA_OUTCOMES),
    // and it would also skip G-5's checkDeltaBound and G-1's review set.
    const tampered = fixtureRow('row-c2-1', 'C2', {
      outcome: 'unfetchable',
      prePortQuarantine: false,
      postPortQuarantine: true,
    })

    const path0 = writeShardReport(
      dir,
      0,
      [tampered.reportRow, fixture.shardRows[0][1]],
      fixture.totals
    )
    const path1 = writeShardReport(dir, 1, fixture.shardRows[1], fixture.totals)
    const path2 = writeShardReport(dir, 2, fixture.shardRows[2], fixture.totals)
    const db = makeMergeShardsDb(fixture.population)
    const args = mergeArgs([path0, path1, path2], join(dir, 'merged.json'))

    await expect(runMergeShards(db, args)).rejects.toThrow(
      /row-c2-1.*outcome=unfetchable is NOT a scored outcome, but carries/s
    )
  })

  it('does NOT flag a genuine unfetchable/unevaluable/content_drifted row with no quarantine fields at all', async () => {
    const dir = scratch()
    const fixture = buildThreeShardFixture()
    const genuine = {
      ...fixtureRow('row-c2-1', 'C2', { outcome: 'unfetchable' }).reportRow,
    }
    // Matches the real simulator's own shape for these three outcomes
    // (processRow's early-return sites never attach these fields at all).
    delete genuine['prePortQuarantine']
    delete genuine['postPortQuarantine']
    delete genuine['prePortRiskScore']
    delete genuine['postPortRiskScore']

    const path0 = writeShardReport(dir, 0, [genuine, fixture.shardRows[0][1]], fixture.totals)
    const path1 = writeShardReport(dir, 1, fixture.shardRows[1], fixture.totals)
    const path2 = writeShardReport(dir, 2, fixture.shardRows[2], fixture.totals)
    const db = makeMergeShardsDb(fixture.population)
    const args = mergeArgs([path0, path1, path2], join(dir, 'merged.json'))

    const report = await runMergeShards(db, args)
    expect(report.rows.find((r) => r.id === 'row-c2-1')?.outcome).toBe('unfetchable')
  })

  it('does NOT flag bundle_absent rows, whose outcome is deliberately overridden past what the quarantine booleans would classify to', async () => {
    const dir = scratch()
    const fixture = buildThreeShardFixture()
    // bundle_absent with prePortQuarantine/postPortQuarantine that would
    // classify to something else entirely (unchanged_clean) if this row's
    // outcome were a verdict-delta bucket — must NOT be flagged, since
    // bundle_absent is not in VERDICT_DELTA_OUTCOMES.
    const bundleAbsent = fixtureRow('row-c2-1', 'C2', {
      outcome: 'bundle_absent',
      prePortQuarantine: false,
      postPortQuarantine: false,
    })

    const path0 = writeShardReport(
      dir,
      0,
      [bundleAbsent.reportRow, fixture.shardRows[0][1]],
      fixture.totals
    )
    const path1 = writeShardReport(dir, 1, fixture.shardRows[1], fixture.totals)
    const path2 = writeShardReport(dir, 2, fixture.shardRows[2], fixture.totals)
    const db = makeMergeShardsDb(fixture.population)
    const args = mergeArgs([path0, path1, path2], join(dir, 'merged.json'))

    const report = await runMergeShards(db, args)
    expect(report.rows.find((r) => r.id === 'row-c2-1')?.outcome).toBe('bundle_absent')
  })
})
