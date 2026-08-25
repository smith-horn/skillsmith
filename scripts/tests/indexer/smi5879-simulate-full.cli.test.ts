/**
 * SMI-6015 Wave 1: smi5879-simulate-full.cli.ts — `parseArgs` tests,
 * including the new `--max-elapsed-minutes` and `--cohorts` flags added
 * this Wave (previously untested — extracted from smi5879-simulate-full.ts
 * as part of the same 500-line-budget split that added these flags).
 * @module scripts/tests/indexer/smi5879-simulate-full.cli
 */

import { describe, it, expect } from 'vitest'
import { parseArgs } from '../../indexer/smi5879-simulate-full.cli.ts'

const REQUIRED = ['--run-id=run-1', '--purpose=decision']

describe('parseArgs', () => {
  it('throws when --run-id is missing', () => {
    expect(() => parseArgs(['--purpose=decision'])).toThrow(/--run-id/)
  })

  it('throws when --purpose is missing or invalid', () => {
    expect(() => parseArgs(['--run-id=run-1'])).toThrow(/--purpose/)
    expect(() => parseArgs(['--run-id=run-1', '--purpose=bogus'])).toThrow(/--purpose/)
  })

  it('parses required fields with sensible defaults for everything else', () => {
    const args = parseArgs(REQUIRED)
    expect(args.runId).toBe('run-1')
    expect(args.purpose).toBe('decision')
    expect(args.apply).toBe(false)
    expect(args.checkpointPath).toBeUndefined()
    expect(args.reportPath).toBeUndefined()
    expect(args.maxElapsedMinutes).toBeUndefined()
    expect(args.cohorts).toBeUndefined()
  })

  it('--apply sets apply: true', () => {
    expect(parseArgs([...REQUIRED, '--apply']).apply).toBe(true)
  })

  // ---------------------------------------------------------------------
  // SMI-6015 Wave 1: --max-elapsed-minutes
  // ---------------------------------------------------------------------

  it('parses a valid --max-elapsed-minutes', () => {
    expect(parseArgs([...REQUIRED, '--max-elapsed-minutes=310']).maxElapsedMinutes).toBe(310)
  })

  it.each(['0', '-5', 'not-a-number', ''])('rejects an invalid --max-elapsed-minutes=%s', (bad) => {
    expect(() => parseArgs([...REQUIRED, `--max-elapsed-minutes=${bad}`])).toThrow(
      /--max-elapsed-minutes/
    )
  })

  // ---------------------------------------------------------------------
  // SMI-6015 Wave 1: --cohorts
  // ---------------------------------------------------------------------

  it('parses a valid single-cohort --cohorts with a non-decision purpose', () => {
    const args = parseArgs(['--run-id=run-1', '--purpose=rehearsal', '--cohorts=C4'])
    expect(args.cohorts).toEqual(['C4'])
  })

  it('parses a valid multi-cohort comma-list, trimming whitespace', () => {
    const args = parseArgs(['--run-id=run-1', '--purpose=rehearsal', '--cohorts=C2, C4'])
    expect(args.cohorts).toEqual(['C2', 'C4'])
  })

  it('rejects an invalid cohort name', () => {
    expect(() => parseArgs(['--run-id=run-1', '--purpose=rehearsal', '--cohorts=C4,C99'])).toThrow(
      /invalid cohort.*C99/
    )
  })

  it('an empty --cohorts= is treated as omitted (all four)', () => {
    const args = parseArgs(['--run-id=run-1', '--purpose=rehearsal', '--cohorts='])
    expect(args.cohorts).toBeUndefined()
  })

  // -----------------------------------------------------------------------
  // SMI-6015 Wave 1 plan-review Medium finding #10: --cohorts can never be
  // combined with --purpose=decision — G-2 requires all four cohorts fully
  // simulated in one decision-purpose report, so a cohort-scoped decision
  // dispatch could never satisfy the gate no matter what it found.
  // -----------------------------------------------------------------------

  it('rejects --cohorts combined with --purpose=decision', () => {
    expect(() => parseArgs([...REQUIRED, '--cohorts=C4'])).toThrow(
      /--cohorts.*cannot be combined with --purpose=decision/
    )
  })

  it('allows --cohorts with --purpose=window (not just rehearsal)', () => {
    const args = parseArgs(['--run-id=run-1', '--purpose=window', '--cohorts=C1,C2'])
    expect(args.cohorts).toEqual(['C1', 'C2'])
  })

  // ---------------------------------------------------------------------
  // SMI-6015 PAT-sharded fetch plan Wave 1: --shard-index/--shard-count
  // ---------------------------------------------------------------------

  it('parses a valid --shard-index/--shard-count pair', () => {
    const args = parseArgs([...REQUIRED, '--shard-index=1', '--shard-count=3'])
    expect(args.shardIndex).toBe(1)
    expect(args.shardCount).toBe(3)
  })

  it('rejects --shard-index without --shard-count', () => {
    expect(() => parseArgs([...REQUIRED, '--shard-index=0'])).toThrow(
      /--shard-index and --shard-count must both be present/
    )
  })

  it('rejects --shard-count without --shard-index', () => {
    expect(() => parseArgs([...REQUIRED, '--shard-count=3'])).toThrow(
      /--shard-index and --shard-count must both be present/
    )
  })

  it.each(['0', '-1', '1.5', 'not-a-number'])('rejects an invalid --shard-count=%s', (bad) => {
    expect(() => parseArgs([...REQUIRED, `--shard-index=0`, `--shard-count=${bad}`])).toThrow(
      /--shard-count/
    )
  })

  it.each(['-1', '3', '1.5', 'not-a-number'])(
    'rejects --shard-index=%s out of [0, shard-count) bounds',
    (bad) => {
      expect(() => parseArgs([...REQUIRED, `--shard-index=${bad}`, '--shard-count=3'])).toThrow(
        /--shard-index/
      )
    }
  )

  it('--shard-count=1 --shard-index=0 is a valid degenerate no-op single-shard run', () => {
    const args = parseArgs([...REQUIRED, '--shard-index=0', '--shard-count=1'])
    expect(args.shardIndex).toBe(0)
    expect(args.shardCount).toBe(1)
  })

  it('rejects --shard-count=1 with any --shard-index other than 0', () => {
    expect(() => parseArgs([...REQUIRED, '--shard-index=1', '--shard-count=1'])).toThrow(
      /--shard-index/
    )
  })

  // ---------------------------------------------------------------------
  // PR #2525 review (GPT-5.6-Sol) Low finding: the DB adapter casts
  // --shard-count to Postgres ::integer — a value that passes the
  // integer/positivity check here but exceeds that range would otherwise
  // fail opaquely at claim time instead of at parse time.
  // ---------------------------------------------------------------------

  it('rejects --shard-count above the Postgres integer range', () => {
    expect(() => parseArgs([...REQUIRED, '--shard-index=0', '--shard-count=2147483648'])).toThrow(
      /--shard-count/
    )
  })

  it('accepts --shard-count exactly at the Postgres integer max', () => {
    const args = parseArgs([...REQUIRED, '--shard-index=0', '--shard-count=2147483647'])
    expect(args.shardCount).toBe(2147483647)
  })

  it('--shard-index/--shard-count are undefined when omitted', () => {
    const args = parseArgs(REQUIRED)
    expect(args.shardIndex).toBeUndefined()
    expect(args.shardCount).toBeUndefined()
  })

  it('--shard-index/--shard-count compose with --cohorts (row-level, orthogonal to cohort scope)', () => {
    const args = parseArgs([
      '--run-id=run-1',
      '--purpose=rehearsal',
      '--cohorts=C4',
      '--shard-index=0',
      '--shard-count=3',
    ])
    expect(args.cohorts).toEqual(['C4'])
    expect(args.shardIndex).toBe(0)
    expect(args.shardCount).toBe(3)
  })
})
