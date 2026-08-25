/**
 * SMI-6015 PAT-sharded fetch plan Wave 1 (round-1 GPT-5.6-Sol review, High
 * finding): `assertCheckpointRowsBelongToGeneration` extended to validate
 * every `row_results` entry against the invocation's declared shard/cohort
 * scope, not just generation membership. A structurally valid checkpoint
 * could otherwise declare `shard_index: 1` while its `row_results` (hand-
 * edited, corrupted, or produced by a future bug) actually contains
 * shard-0 or excluded-cohort rows — resume would silently accept them,
 * contaminating that shard's report and breaking the row-id-disjointness
 * invariant Wave 2's merge tool depends on.
 * @module scripts/tests/indexer/smi5879-simulate-full.checkpoint-row-scope
 */

import { describe, it, expect } from 'vitest'
import { assertCheckpointRowsBelongToGeneration } from '../../indexer/smi5879-simulate-full.checkpoint.ts'
import { shardOf } from '../../indexer/smi5879-simulate-full.shard.ts'
import type {
  SimSnapshotRow,
  SimRowResult,
  Smi5879SimulateCheckpoint,
} from '../../indexer/smi5879-simulate-full.types.ts'

function baseCheckpoint(rowResults: Record<string, SimRowResult>): Smi5879SimulateCheckpoint {
  return {
    run_id: 'run-1',
    purpose: 'decision',
    baseline_commit: 'abc123',
    token_source: 'pat',
    cohorts: ['C1', 'C2', 'C3', 'C4'],
    clean_shutdown: true,
    row_results: rowResults,
    sweep: { pass: 0, residual_history: [], non_decrease_streak: 0, hard_stopped: null },
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

function row(id: string, cohort: SimSnapshotRow['cohort'] = 'C2'): SimSnapshotRow {
  return {
    id,
    cohort,
    repo_url: `https://github.com/acme/${id}`,
    skill_path: null,
    author: 'acme',
    name: id,
    content_hash: null,
    snapshot_security_score: null,
    snapshot_quarantined: null,
  }
}

function result(
  id: string,
  cohort: SimRowResult['cohort'] = 'C2',
  overrides: Partial<Pick<SimRowResult, 'author' | 'name'>> = {}
): SimRowResult {
  // author/name default to MATCH row()'s own defaults ('acme'/id) — a
  // real processRow() output always copies these from the canonical row
  // (helpers.ts), so a mismatched default here would make every ordinary
  // valid-resume test in this file fail once author/name are cross-checked
  // (round-3 review Medium finding) — override explicitly to test a
  // genuine mismatch.
  return { id, cohort, author: 'acme', name: id, outcome: 'unchanged_clean', ...overrides }
}

describe('assertCheckpointRowsBelongToGeneration — shard/cohort scope', () => {
  it('accepts a checkpoint whose rows genuinely belong to this shard and cohort scope', () => {
    // Find a real row id that hashes to shard 0 of 3, so the test is a
    // genuine positive case rather than an accidental pass.
    let id = 'seed-0'
    for (let i = 0; shardOf(id, 3) !== 0; i++) id = `seed-${i}`
    const rows = [row(id)]
    const checkpoint = baseCheckpoint({ [id]: result(id) })

    expect(() =>
      assertCheckpointRowsBelongToGeneration(checkpoint, rows, 'path', {
        cohorts: ['C1', 'C2', 'C3', 'C4'],
        shardIndex: 0,
        shardCount: 3,
      })
    ).not.toThrow()
  })

  it('accepts an unsharded checkpoint with no shard scope supplied', () => {
    const rows = [row('row-1')]
    const checkpoint = baseCheckpoint({ 'row-1': result('row-1') })

    expect(() =>
      assertCheckpointRowsBelongToGeneration(checkpoint, rows, 'path', {
        cohorts: ['C1', 'C2', 'C3', 'C4'],
      })
    ).not.toThrow()
  })

  it('refuses a row_results entry belonging to a DIFFERENT shard than declared', () => {
    // Find two ids that hash to different shards of 3.
    let idInShard0 = 'seed-0'
    for (let i = 0; shardOf(idInShard0, 3) !== 0; i++) idInShard0 = `seed-${i}`
    let idInShard1 = 'seed-0'
    for (let i = 0; shardOf(idInShard1, 3) !== 1; i++) idInShard1 = `seed-${i}`

    const rows = [row(idInShard0), row(idInShard1)]
    // Checkpoint claims to be shard 0, but contains a shard-1 row's result —
    // the exact contamination scenario the fix closes.
    const checkpoint = baseCheckpoint({ [idInShard1]: result(idInShard1) })

    expect(() =>
      assertCheckpointRowsBelongToGeneration(checkpoint, rows, 'path', {
        cohorts: ['C1', 'C2', 'C3', 'C4'],
        shardIndex: 0,
        shardCount: 3,
      })
    ).toThrow(new RegExp(`${idInShard1}.*belongs to shard 1, not this shard 0`))
  })

  it('refuses a row_results entry outside the declared cohort scope', () => {
    const rows = [row('c4-row', 'C4')]
    const checkpoint = baseCheckpoint({ 'c4-row': result('c4-row', 'C4') })

    expect(() =>
      assertCheckpointRowsBelongToGeneration(checkpoint, rows, 'path', {
        cohorts: ['C1', 'C2', 'C3'], // C4 excluded
      })
    ).toThrow(/c4-row.*cohort C4 outside this run's cohort scope/)
  })

  it("refuses a row_results entry whose STORED result.cohort disagrees with the row's real (canonical) cohort — round-2 review High finding", () => {
    // A real C2 row, matching result.id, but the stored result claims a
    // DIFFERENT cohort (C4) than the canonical row actually has. This is
    // exactly the malformed-but-shape-valid entry that would otherwise
    // survive into report.rows/counts untouched, since those are built
    // from the stored results directly, not re-derived from the canonical
    // row set.
    const rows = [row('c2-row', 'C2')]
    const checkpoint = baseCheckpoint({ 'c2-row': result('c2-row', 'C4') })

    expect(() =>
      assertCheckpointRowsBelongToGeneration(checkpoint, rows, 'path', {
        cohorts: ['C1', 'C2', 'C3', 'C4'], // both C2 and C4 are in-scope — this must still fail
      })
    ).toThrow(/c2-row.*stored result\.cohort=C4 does not match this row's real cohort=C2/)
  })

  it("refuses a row_results entry whose STORED result.author/name disagrees with the row's real (canonical) values — round-3 review Medium finding", () => {
    // Same class of gap as cohort above: author/name are informational,
    // not gate-relevant, but processRow() always copies them from the
    // canonical row — a stored value that disagrees is still a malformed
    // entry that would otherwise misattribute a row in report.rows.
    const rows = [row('mismatch-row')] // row()'s real author='acme', name='mismatch-row'
    const checkpoint = baseCheckpoint({
      'mismatch-row': result('mismatch-row', 'C2', { author: 'someone-else' }),
    })

    expect(() =>
      assertCheckpointRowsBelongToGeneration(checkpoint, rows, 'path', {
        cohorts: ['C1', 'C2', 'C3', 'C4'],
      })
    ).toThrow(/does not match this row's real author\/name=acme\/mismatch-row/)
  })

  it("refuses a row_results entry whose key doesn't match its own stored result.id (corrupted entry)", () => {
    const rows = [row('row-1'), row('row-2')]
    // Stored under key "row-1" but the result object itself claims id "row-2".
    const checkpoint = baseCheckpoint({ 'row-1': result('row-2') })

    expect(() =>
      assertCheckpointRowsBelongToGeneration(checkpoint, rows, 'path', {
        cohorts: ['C1', 'C2', 'C3', 'C4'],
      })
    ).toThrow(/row-1.*does not match its own result\.id=row-2/)
  })

  it('reports multiple problems together, capped at 5 shown', () => {
    const rows = [row('c4-a', 'C4'), row('c4-b', 'C4'), row('c4-c', 'C4')]
    const checkpoint = baseCheckpoint({
      'c4-a': result('c4-a', 'C4'),
      'c4-b': result('c4-b', 'C4'),
      'c4-c': result('c4-c', 'C4'),
    })

    expect(() =>
      assertCheckpointRowsBelongToGeneration(checkpoint, rows, 'path', {
        cohorts: ['C1', 'C2', 'C3'],
      })
    ).toThrow(/3 row_results entries that don't belong/)
  })
})
