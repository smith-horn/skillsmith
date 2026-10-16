/**
 * SMI-7121 Wave 1: the checkpoint carries the autochain's halt inputs
 * @module scripts/tests/indexer/backfill-checkpoint.counters
 *
 * Covers:
 *  - buildDispatchCounters: all four counters copied; ANY missing or malformed
 *    counter yields undefined (fail-closed), never a zero
 *  - buildResumedFrom: loaded checkpoint -> {run_id, path}; cold start -> null
 *  - writeCheckpoint: both fields reach metadata, and the persisted JSON keeps
 *    null (cold start) distinct from absent (pre-SMI-7121 row)
 *  - run.ts wiring: the single writeCheckpoint call passes both builders, fed by
 *    the checkpoint loadResumeCheckpoint returned (run.ts calls main() at import,
 *    so the wiring is asserted on its source)
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  buildDispatchCounters,
  buildResumedFrom,
} from '../../indexer/backfill-checkpoint.counters.ts'
import {
  writeCheckpoint,
  type BackfillCheckpointPayload,
} from '../../indexer/backfill-checkpoint.ts'

const SUB = { admitted: 221, no_default_branch: 3, license_filtered: 1 }
const CRAWL = { ranges_crawled: 7 }

describe('buildDispatchCounters', () => {
  it('copies all four counters from their sources', () => {
    expect(buildDispatchCounters(SUB, CRAWL)).toEqual({
      admitted: 221,
      no_default_branch: 3,
      license_filtered: 1,
      ranges_crawled: 7,
    })
  })

  it('keeps a genuine zero', () => {
    expect(
      buildDispatchCounters(
        { admitted: 0, no_default_branch: 0, license_filtered: 0 },
        {
          ranges_crawled: 0,
        }
      )
    ).toEqual({ admitted: 0, no_default_branch: 0, license_filtered: 0, ranges_crawled: 0 })
  })

  // Each row removes or corrupts exactly one counter; the result must be undefined,
  // because a halt reading a defaulted 0 would pass a run it should stop.
  const failClosed: Array<[string, Parameters<typeof buildDispatchCounters>]> = [
    ['no subdirectory_search', [undefined, CRAWL]],
    ['no crawl outcome', [SUB, undefined]],
    ['admitted missing', [{ no_default_branch: 3, license_filtered: 1 }, CRAWL]],
    ['no_default_branch missing', [{ admitted: 221, license_filtered: 1 }, CRAWL]],
    ['license_filtered missing', [{ admitted: 221, no_default_branch: 3 }, CRAWL]],
    ['ranges_crawled missing', [SUB, {}]],
    ['negative counter', [{ ...SUB, license_filtered: -1 }, CRAWL]],
    ['fractional counter', [{ ...SUB, no_default_branch: 2.5 }, CRAWL]],
    ['NaN counter', [{ ...SUB, admitted: Number.NaN }, CRAWL]],
    ['string counter', [{ ...SUB, admitted: '221' as unknown as number }, CRAWL]],
  ]
  for (const [name, args] of failClosed) {
    it(`returns undefined when ${name}`, () => {
      expect(buildDispatchCounters(...args)).toBeUndefined()
    })
  }
})

describe('buildResumedFrom', () => {
  it('records the loaded checkpoint run id and its cursor path', () => {
    expect(buildResumedFrom({ run_id: '38933409134', cursor: { path: '.gemini/skills' } })).toEqual(
      { run_id: '38933409134', path: '.gemini/skills' }
    )
  })

  it('keeps the broad-query empty path rather than dropping it', () => {
    expect(buildResumedFrom({ run_id: 'r1', cursor: { path: '' } })).toEqual({
      run_id: 'r1',
      path: '',
    })
  })

  it('returns null on a cold start', () => {
    expect(buildResumedFrom(null)).toBeNull()
  })
})

function captureInsert(): { supabase: SupabaseClient; rows: Record<string, unknown>[] } {
  const rows: Record<string, unknown>[] = []
  const supabase = {
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        rows.push(row)
        return Promise.resolve({ data: null, error: null })
      },
    }),
  } as unknown as SupabaseClient
  return { supabase, rows }
}

function payload(extra: Partial<BackfillCheckpointPayload>): BackfillCheckpointPayload {
  return {
    run_id: 'run-7121',
    cursor: { path: '.agents/skills', facet: '3584-4095', last_page: 2 },
    facets_completed: 1,
    facets_total: 9,
    cap_saturated: false,
    truncated_repo_count: 0,
    incomplete_results_ranges: 0,
    dry_run: false,
    ...extra,
  }
}

describe('writeCheckpoint persists the SMI-7121 fields', () => {
  it('writes dispatch_counters and resumed_from under metadata', async () => {
    const { supabase, rows } = captureInsert()
    const counters = buildDispatchCounters(SUB, CRAWL)
    const resumed = buildResumedFrom({ run_id: 'prev-1', cursor: { path: '.agents/skills' } })
    expect(
      await writeCheckpoint(
        supabase,
        payload({ dispatch_counters: counters, resumed_from: resumed })
      )
    ).toBe(true)
    const metadata = rows[0].metadata as Record<string, unknown>
    expect(metadata.dispatch_counters).toEqual(counters)
    expect(metadata.resumed_from).toEqual({ run_id: 'prev-1', path: '.agents/skills' })
  })

  it('serializes a cold start as resumed_from: null, distinct from a pre-SMI-7121 row', async () => {
    const cold = captureInsert()
    await writeCheckpoint(cold.supabase, payload({ resumed_from: null }))
    const old = captureInsert()
    await writeCheckpoint(old.supabase, payload({}))

    // What PostgREST sends is the JSON body, so compare the serialized metadata.
    const coldJson = JSON.parse(JSON.stringify(cold.rows[0].metadata)) as Record<string, unknown>
    const oldJson = JSON.parse(JSON.stringify(old.rows[0].metadata)) as Record<string, unknown>
    expect('resumed_from' in coldJson).toBe(true)
    expect(coldJson.resumed_from).toBeNull()
    expect('resumed_from' in oldJson).toBe(false)
    expect('dispatch_counters' in oldJson).toBe(false)
  })
})

describe('run.ts wiring (source)', () => {
  const src = readFileSync(join(__dirname, '../../indexer/run.ts'), 'utf8')

  it('has exactly one writeCheckpoint call, and it passes both builders', () => {
    const calls = src.match(/writeCheckpoint\(supabase, \{[\s\S]*?\n {4}\}\)/g) ?? []
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain(
      'dispatch_counters: buildDispatchCounters(result.subdirectory_search, bc)'
    )
    expect(calls[0]).toContain('resumed_from: buildResumedFrom(loadedCheckpoint)')
  })

  it('feeds resumed_from from the checkpoint loadResumeCheckpoint returned', () => {
    expect(src).toMatch(
      /const checkpoint = await loadResumeCheckpoint\([^)]*\)\n\s*loadedCheckpoint = checkpoint\n/
    )
    // Exactly one assignment, so nothing later overwrites what was actually loaded.
    expect(src.match(/loadedCheckpoint = /g)).toHaveLength(1)
  })
})
