/**
 * SMI-5879 Wave 3 item 3: smi5879-simulate-full — checkpoint I/O tests
 * (`checkpointPathFor`/`readCheckpoint`/`writeCheckpoint`/`isAbnormalResume`,
 * including SMI-5879 review findings 1 and 3's shape-validation/corruption
 * hard-refusals). Split out of the original `smi5879-simulate-full.test.ts`
 * (grew past the 500-line-per-file gate) — shared fixtures live in
 * `./smi5879-simulate-full.fixtures.ts`, which also documents the
 * suite-wide mocked-dependencies judgment call. This file doesn't need any
 * of those fixtures itself (pure filesystem round-trips against real temp
 * dirs, no `fetch`/DB mocking).
 * @module scripts/tests/indexer/smi5879-simulate-full.checkpoint
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  checkpointPathFor,
  readCheckpoint,
  writeCheckpoint,
  isAbnormalResume,
  assertCheckpointIdentity,
} from '../../indexer/smi5879-simulate-full.checkpoint.ts'
import type { Smi5879SimulateCheckpoint } from '../../indexer/smi5879-simulate-full.types.ts'

// ---------------------------------------------------------------------------
// Checkpoint I/O
// ---------------------------------------------------------------------------

describe('checkpoint I/O', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smi5879-sim-ckpt-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('readCheckpoint returns null when no file exists', () => {
    expect(readCheckpoint(join(dir, 'missing.json'))).toBeNull()
  })

  it('round-trips a checkpoint through write then read', () => {
    const path = join(dir, 'ckpt.json')
    const checkpoint: Smi5879SimulateCheckpoint = {
      run_id: 'run-1',
      purpose: 'decision',
      baseline_commit: 'abc123',
      token_source: 'pat',
      cohorts: ['C1', 'C2', 'C3', 'C4'],
      clean_shutdown: true,
      row_results: {},
      sweep: { pass: 0, residual_history: [], non_decrease_streak: 0, hard_stopped: null },
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    writeCheckpoint(path, checkpoint)
    const loaded = readCheckpoint(path)
    expect(loaded).toEqual(checkpoint)
  })

  it('isAbnormalResume is true only when clean_shutdown is explicitly false', () => {
    const base: Smi5879SimulateCheckpoint = {
      run_id: 'r',
      purpose: 'decision',
      baseline_commit: 'x',
      token_source: 'pat',
      cohorts: ['C1', 'C2', 'C3', 'C4'],
      clean_shutdown: true,
      row_results: {},
      sweep: { pass: 0, residual_history: [], non_decrease_streak: 0, hard_stopped: null },
      started_at: '',
      updated_at: '',
    }
    expect(isAbnormalResume(null)).toBe(false)
    expect(isAbnormalResume(base)).toBe(false)
    expect(isAbnormalResume({ ...base, clean_shutdown: false })).toBe(true)
  })

  it('checkpointPathFor is deterministic per run_id', () => {
    expect(checkpointPathFor('run-a')).toBe(checkpointPathFor('run-a'))
    expect(checkpointPathFor('run-a')).not.toBe(checkpointPathFor('run-b'))
  })

  // -------------------------------------------------------------------------
  // SMI-5879 review finding 1: `readCheckpoint` no longer does a bare
  // `JSON.parse(raw) as Smi5879SimulateCheckpoint` — it validates shape and
  // throws loudly on anything malformed rather than silently trusting the file.
  // -------------------------------------------------------------------------

  it('readCheckpoint rejects a checkpoint whose row_results contains an unrecognised outcome value', () => {
    const path = join(dir, 'bad-outcome.json')
    const raw = {
      run_id: 'run-1',
      purpose: 'decision',
      baseline_commit: 'abc123',
      token_source: 'pat',
      cohorts: ['C1', 'C2', 'C3', 'C4'],
      clean_shutdown: true,
      row_results: {
        'row-1': {
          id: 'row-1',
          cohort: 'C2',
          author: null,
          name: null,
          outcome: 'totally_not_a_real_outcome',
        },
      },
      sweep: { pass: 0, residual_history: [], non_decrease_streak: 0, hard_stopped: null },
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    writeFileSync(path, JSON.stringify(raw))
    expect(() => readCheckpoint(path)).toThrow(/outcome=totally_not_a_real_outcome/)
  })

  it('readCheckpoint rejects a checkpoint missing required top-level fields', () => {
    const path = join(dir, 'missing-fields.json')
    writeFileSync(path, JSON.stringify({ run_id: 'run-1' }))
    expect(() => readCheckpoint(path)).toThrow(/failed shape validation/)
  })

  // -------------------------------------------------------------------------
  // SMI-6015 Wave 1: `cohorts` is a new required field — shape validation
  // must reject a missing/empty/invalid value, not silently accept it.
  // -------------------------------------------------------------------------

  it.each([
    ['missing', undefined],
    ['empty array', []],
    ['containing an invalid cohort', ['C1', 'C99']],
    ['not an array', 'C1'],
  ])('readCheckpoint rejects a checkpoint with cohorts %s', (_label, cohorts) => {
    const path = join(dir, 'bad-cohorts.json')
    const raw: Record<string, unknown> = {
      run_id: 'run-1',
      purpose: 'decision',
      baseline_commit: 'abc123',
      token_source: 'pat',
      clean_shutdown: true,
      row_results: {},
      sweep: { pass: 0, residual_history: [], non_decrease_streak: 0, hard_stopped: null },
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    if (cohorts !== undefined) raw['cohorts'] = cohorts
    writeFileSync(path, JSON.stringify(raw))
    expect(() => readCheckpoint(path)).toThrow(/cohorts=/)
  })

  // -------------------------------------------------------------------------
  // SMI-5879 review finding 3: a corrupted checkpoint file is NOT the same
  // as "no checkpoint" (cold start) — it must fail loudly, since real
  // progress may have been lost, not be silently treated as absent.
  // -------------------------------------------------------------------------

  it('readCheckpoint throws loudly on a corrupted (non-JSON) checkpoint file rather than treating it as absent', () => {
    const path = join(dir, 'corrupt.json')
    writeFileSync(path, '{"run_id": "run-1", "row_results": {') // truncated mid-write
    expect(() => readCheckpoint(path)).toThrow(/is not valid JSON/)
    // Specifically NOT null — a corrupted file must never look like a cold start.
    expect(() => readCheckpoint(path)).not.toThrow(/^$/) // (guards against a swallowed/empty message)
  })

  it('writeCheckpoint replaces the target atomically (no truncated intermediate state observable)', () => {
    const path = join(dir, 'atomic.json')
    const checkpoint: Smi5879SimulateCheckpoint = {
      run_id: 'run-1',
      purpose: 'decision',
      baseline_commit: 'abc123',
      token_source: 'pat',
      cohorts: ['C1', 'C2', 'C3', 'C4'],
      clean_shutdown: true,
      row_results: {},
      sweep: { pass: 0, residual_history: [], non_decrease_streak: 0, hard_stopped: null },
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    writeCheckpoint(path, checkpoint)
    // A second write must fully replace the file, and never leave a stray
    // `.tmp-<pid>` sibling behind once the rename has completed.
    writeCheckpoint(path, { ...checkpoint, clean_shutdown: false })
    const loaded = readCheckpoint(path)
    expect(loaded?.clean_shutdown).toBe(false)
    expect(() => readCheckpoint(`${path}.tmp-${process.pid}`)).not.toThrow()
    expect(readCheckpoint(`${path}.tmp-${process.pid}`)).toBeNull()
  })

  // -------------------------------------------------------------------------
  // SMI-6015 Wave 1: assertCheckpointIdentity's cohorts comparison
  // -------------------------------------------------------------------------

  describe('assertCheckpointIdentity — cohorts', () => {
    function identityCheckpoint(
      cohorts: Smi5879SimulateCheckpoint['cohorts']
    ): Smi5879SimulateCheckpoint {
      return {
        run_id: 'run-1',
        purpose: 'decision',
        baseline_commit: 'abc123',
        token_source: 'pat',
        cohorts,
        clean_shutdown: true,
        row_results: {},
        sweep: { pass: 0, residual_history: [], non_decrease_streak: 0, hard_stopped: null },
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
    }

    it('treats the same cohorts in a different order as identical (not a mismatch)', () => {
      const checkpoint = identityCheckpoint(['C4', 'C2'])
      expect(() =>
        assertCheckpointIdentity(
          checkpoint,
          { runId: 'run-1', purpose: 'decision', tokenSource: 'pat', cohorts: ['C2', 'C4'] },
          'path'
        )
      ).not.toThrow()
    })

    it('refuses a genuinely different cohorts scope', () => {
      const checkpoint = identityCheckpoint(['C1', 'C2', 'C3', 'C4'])
      expect(() =>
        assertCheckpointIdentity(
          checkpoint,
          { runId: 'run-1', purpose: 'decision', tokenSource: 'pat', cohorts: ['C4'] },
          'path'
        )
      ).toThrow(/cohorts \(checkpoint=C1,C2,C3,C4, this run=C4\)/)
    })
  })
})
