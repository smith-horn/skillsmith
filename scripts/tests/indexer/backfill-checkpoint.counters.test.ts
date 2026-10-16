/**
 * SMI-7121 Wave 1: the checkpoint carries the autochain's halt inputs
 * @module scripts/tests/indexer/backfill-checkpoint.counters
 *
 * Covers:
 *  - toSubdirectorySearchStats -> buildDispatchCounters: each counter travels from
 *    Phase 3b's camelCase result to its own snake_case checkpoint field
 *  - buildDispatchCounters: ANY missing, malformed or errored counter yields
 *    undefined (fail-closed), never a zero
 *  - buildResumedFrom: loaded checkpoint -> {run_id, path}; cold start -> null;
 *    a loaded row without a string path -> undefined (field omitted)
 *  - buildCheckpointPayload: the whole payload run.ts writes, including the
 *    pre-existing fields, and null (cold start) kept distinct from absent
 *  - writeCheckpoint: both fields reach the persisted JSON
 *  - run.ts: writes exactly the helper's payload, fed by the checkpoint it loaded
 *    (run.ts calls main() at import, so this one link is asserted on its source)
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  buildCheckpointPayload,
  buildDispatchCounters,
  buildResumedFrom,
} from '../../indexer/backfill-checkpoint.counters.ts'
import { writeCheckpoint, type BackfillCrawlOutcome } from '../../indexer/backfill-checkpoint.ts'
import { toSubdirectorySearchStats } from '../../indexer/subdirectory-search.ts'
import type { BackfillDispatchInputs } from '../../indexer/backfill-dispatch-inputs.ts'

const SUB = { admitted: 221, no_default_branch: 3, license_filtered: 1 }
const CRAWL = { ranges_crawled: 7 }

describe('Phase 3b result -> dispatch_counters', () => {
  it('carries each counter to its own field (distinct values, so a swap fails)', () => {
    const phase3b = {
      repos: [],
      totalFound: 0,
      retries: 0,
      licenseFiltered: 11,
      licenseFetchFailed: 0,
      admitted: 13,
      licenseNull: 0,
      noDefaultBranch: 17,
      incompleteResults: 0,
      searchMode: 'broad' as const,
      errors: [],
    } as unknown as Parameters<typeof toSubdirectorySearchStats>[0]
    expect(
      buildDispatchCounters(toSubdirectorySearchStats(phase3b), { ranges_crawled: 19 })
    ).toEqual({ admitted: 13, no_default_branch: 17, license_filtered: 11, ranges_crawled: 19 })
  })
})

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
        { ranges_crawled: 0 }
      )
    ).toEqual({ admitted: 0, no_default_branch: 0, license_filtered: 0, ranges_crawled: 0 })
  })

  // Each row removes or corrupts exactly one input; the result must be undefined,
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
    // A disabled/failed Phase 3b marker carries zeroed counters plus an error.
    ['Phase 3b recorded an error', [{ ...SUB, error: 'phase_failed' }, CRAWL]],
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

  it('omits the field when the loaded row has no string path', () => {
    expect(buildResumedFrom({ run_id: 'r1', cursor: {} })).toBeUndefined()
    expect(buildResumedFrom({ run_id: 'r1', cursor: { path: 7 } })).toBeUndefined()
  })
})

const CRAWL_OUTCOME = {
  cursor: { path: '.agents/skills', facet: '3584-4095', last_page: 2 },
  facets_completed: 4,
  facets_total: 9,
  cap_saturated: true,
  truncated_repo_count: 5,
  incomplete_results_ranges: 6,
  ranges_crawled: 7,
  done: false,
} as unknown as BackfillCrawlOutcome
const INPUTS = { pathPrefix: '.agents/skills' } as unknown as BackfillDispatchInputs

function build(overrides: Partial<Parameters<typeof buildCheckpointPayload>[0]> = {}) {
  return buildCheckpointPayload({
    runId: 'run-7121',
    crawl: CRAWL_OUTCOME,
    subdirectorySearch: SUB,
    dryRun: false,
    dispatchInputs: INPUTS,
    loaded: { run_id: 'prev-1', cursor: { path: '.agents/skills' } },
    ...overrides,
  })
}

describe('buildCheckpointPayload', () => {
  it('maps every field run.ts persists', () => {
    expect(build()).toEqual({
      run_id: 'run-7121',
      cursor: CRAWL_OUTCOME.cursor,
      facets_completed: 4,
      facets_total: 9,
      cap_saturated: true,
      truncated_repo_count: 5,
      incomplete_results_ranges: 6,
      dry_run: false,
      dispatch_inputs: INPUTS,
      dispatch_counters: {
        admitted: 221,
        no_default_branch: 3,
        license_filtered: 1,
        ranges_crawled: 7,
      },
      resumed_from: { run_id: 'prev-1', path: '.agents/skills' },
    })
  })

  it('keeps a cold start as resumed_from: null, and omits fields it could not build', () => {
    const cold = build({ loaded: null })
    expect('resumed_from' in cold).toBe(true)
    expect(cold.resumed_from).toBeNull()

    const incomplete = build({ subdirectorySearch: undefined, loaded: { run_id: 'x', cursor: {} } })
    expect('dispatch_counters' in incomplete).toBe(false)
    expect('resumed_from' in incomplete).toBe(false)
  })
})

describe('writeCheckpoint persists the SMI-7121 fields', () => {
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

  it('sends both fields in the JSON body, with null kept and absent dropped', async () => {
    const full = captureInsert()
    expect(await writeCheckpoint(full.supabase, build())).toBe(true)
    const cold = captureInsert()
    await writeCheckpoint(cold.supabase, build({ loaded: null, subdirectorySearch: undefined }))

    // What PostgREST sends is the JSON body, so compare the serialized metadata.
    const fullJson = JSON.parse(JSON.stringify(full.rows[0].metadata)) as Record<string, unknown>
    const coldJson = JSON.parse(JSON.stringify(cold.rows[0].metadata)) as Record<string, unknown>
    expect(fullJson.dispatch_counters).toEqual(build().dispatch_counters)
    expect(fullJson.resumed_from).toEqual({ run_id: 'prev-1', path: '.agents/skills' })
    expect(coldJson.resumed_from).toBeNull()
    expect('dispatch_counters' in coldJson).toBe(false)
  })
})

describe('run.ts writes the helper payload fed by the loaded checkpoint (source)', () => {
  const src = readFileSync(join(__dirname, '../../indexer/run.ts'), 'utf8')

  it('passes buildCheckpointPayload to its only writeCheckpoint call', () => {
    expect(src.match(/writeCheckpoint\(/g)).toHaveLength(1)
    expect(src).toMatch(/writeCheckpoint\(\s*supabase,\s*buildCheckpointPayload\(\{/)
    expect(src).toMatch(/buildCheckpointPayload\(\{[^}]*loaded: loadedCheckpoint,/)
  })

  it('records exactly what loadResumeCheckpoint returned', () => {
    expect(src).toMatch(
      /const checkpoint = await loadResumeCheckpoint\([^)]*\)\s*loadedCheckpoint = checkpoint\b/
    )
    expect(src.match(/loadedCheckpoint = /g)).toHaveLength(1)
  })
})
