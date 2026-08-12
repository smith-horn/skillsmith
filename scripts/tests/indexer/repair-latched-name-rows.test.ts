/**
 * SMI-5930 Wave 2: unit tests for scripts/indexer/repair-latched-name-rows.ts.
 *
 * Covers:
 *  - batching (planBatches: fixed-size slices, ordered, remainder batch)
 *  - dry-run vs apply: dry-run NEVER calls nullContentHashForIds; apply does
 *  - statement-timeout halve-and-retry (mirrors
 *    batch-upsert-timeout-retry.test.ts's assertions on upsertChunkWithRetry,
 *    adapted to this script's own updateBatchWithRetry)
 *  - dry-run console output is BOUNDED (first/last N ids only, never the
 *    full candidate list)
 *  - the unlatched-ids log file is written incrementally, one line per
 *    successful batch, only in apply mode
 *
 * No real Postgres/psql: `RepairDbDeps` is a plain object the tests inject
 * directly, mirroring the `Smi5879SimulateFullDbDeps` fake-injection
 * convention (scripts/tests/indexer/smi5879-simulate-full.test.ts) rather
 * than mocking `node:child_process` — the module under test never touches
 * `createRepairDbDeps`/`smi5879-census.pg.ts` in these tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  planBatches,
  sampleIdsForDryRun,
  updateBatchWithRetry,
  runRepair,
  appendBatchLog,
  defaultLogPath,
  DEFAULT_BATCH_SIZE,
  MIN_BATCH_SIZE,
  MAX_BATCH_SIZE,
  MAX_TIMEOUT_SPLIT_DEPTH,
  LATCHED_ROW_PREDICATE,
  buildFetchCandidateIdsSql,
  buildNullContentHashSql,
  assertJoinableId,
  type RepairDbDeps,
} from '../../indexer/repair-latched-name-rows.ts'

const STATEMENT_TIMEOUT_ERROR = new Error('canceling statement due to statement timeout')

function makeIds(n: number, prefix = 'id'): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(5, '0')}`)
}

/** A fake RepairDbDeps whose nullContentHashForIds always succeeds, echoing back the ids given. */
function alwaysSucceedsDb(candidateIds: string[]): {
  db: RepairDbDeps
  calls: string[][]
} {
  const calls: string[][] = []
  const db: RepairDbDeps = {
    fetchCandidateIds: async () => candidateIds,
    nullContentHashForIds: async (ids) => {
      calls.push([...ids])
      return [...ids]
    },
  }
  return { db, calls }
}

// ---------------------------------------------------------------------------
// planBatches
// ---------------------------------------------------------------------------

describe('planBatches', () => {
  it('slices an id list into fixed-size batches ordered as given', () => {
    const ids = makeIds(10)
    const batches = planBatches(ids, 3)
    expect(batches).toEqual([ids.slice(0, 3), ids.slice(3, 6), ids.slice(6, 9), ids.slice(9, 10)])
  })

  it('returns a single batch when batchSize >= total', () => {
    const ids = makeIds(5)
    expect(planBatches(ids, 500)).toEqual([ids])
  })

  it('returns no batches for an empty candidate list', () => {
    expect(planBatches([], 500)).toEqual([])
  })

  it('produces the expected batch count for the plan-specified 500-1000 range on ~42,487 rows', () => {
    const ids = makeIds(42487)
    const at500 = planBatches(ids, 500)
    const at1000 = planBatches(ids, 1000)
    expect(at500).toHaveLength(Math.ceil(42487 / 500))
    expect(at1000).toHaveLength(Math.ceil(42487 / 1000))
    // Every id appears exactly once across all batches, in order.
    expect(at500.flat()).toEqual(ids)
    expect(at1000.flat()).toEqual(ids)
  })

  it('throws on a non-positive or non-integer batch size', () => {
    expect(() => planBatches(makeIds(3), 0)).toThrow(/positive integer/)
    expect(() => planBatches(makeIds(3), -5)).toThrow(/positive integer/)
    expect(() => planBatches(makeIds(3), 1.5)).toThrow(/positive integer/)
  })
})

// ---------------------------------------------------------------------------
// sampleIdsForDryRun
// ---------------------------------------------------------------------------

describe('sampleIdsForDryRun', () => {
  it('returns the first N and last N ids for a list longer than 2N', () => {
    const ids = makeIds(100)
    const sample = sampleIdsForDryRun(ids, 10)
    expect(sample.first).toEqual(ids.slice(0, 10))
    expect(sample.last).toEqual(ids.slice(-10))
    // Bounded: never more than 2*N ids total in the sample.
    expect(sample.first.length + sample.last.length).toBeLessThanOrEqual(20)
  })

  it('omits `last` when the whole list already fits in `first` (no overlap/duplication)', () => {
    const ids = makeIds(7)
    const sample = sampleIdsForDryRun(ids, 10)
    expect(sample.first).toEqual(ids)
    expect(sample.last).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// updateBatchWithRetry — statement-timeout halve-and-retry
// (mirrors batch-upsert-timeout-retry.test.ts's exact assertions, adapted
//  from upsertChunkWithRetry's chunk-of-payload shape to this script's
//  batch-of-id shape)
// ---------------------------------------------------------------------------

describe('updateBatchWithRetry — statement-timeout halve-and-retry (mirrors upsertChunkWithRetry)', () => {
  it('halves and retries a timing-out batch until every id succeeds', async () => {
    const calls: number[] = []
    const db: RepairDbDeps = {
      fetchCandidateIds: async () => [],
      nullContentHashForIds: async (ids) => {
        calls.push(ids.length)
        if (ids.length > 1) throw STATEMENT_TIMEOUT_ERROR
        return [...ids]
      },
    }

    const ids = makeIds(4)
    const result = await updateBatchWithRetry(db, ids)

    // Same halving sequence as the upsertChunkWithRetry regression test:
    // 4 (fail) -> [0,1] half: 2 (fail) -> 1,1 (succeed) -> [2,3] half: 2
    // (fail) -> 1,1 (succeed). 7 calls total.
    expect(calls).toEqual([4, 2, 1, 1, 2, 1, 1])
    expect(result.updatedIds.sort()).toEqual([...ids].sort())
    expect(result.errors).toEqual([])
  })

  it('isolates a single pathologically oversized id instead of discarding the whole batch', async () => {
    const ids = makeIds(4)
    const badId = ids[3]
    const db: RepairDbDeps = {
      fetchCandidateIds: async () => [],
      nullContentHashForIds: async (batch) => {
        if (batch.length > 1) throw STATEMENT_TIMEOUT_ERROR
        if (batch[0] === badId) throw STATEMENT_TIMEOUT_ERROR
        return [...batch]
      },
    }

    const result = await updateBatchWithRetry(db, ids)

    expect(result.updatedIds.sort()).toEqual(ids.filter((id) => id !== badId).sort())
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('1 row(s)')
    expect(result.errors[0]).toContain('statement timeout')
  })

  it('bounds retry recursion under a systemic (every-call) timeout via MAX_TIMEOUT_SPLIT_DEPTH', async () => {
    let calls = 0
    const db: RepairDbDeps = {
      fetchCandidateIds: async () => [],
      nullContentHashForIds: async () => {
        calls++
        throw STATEMENT_TIMEOUT_ERROR
      },
    }

    const ids = makeIds(512)
    const result = await updateBatchWithRetry(db, ids)

    // MAX_TIMEOUT_SPLIT_DEPTH=8: 512 halved 8 times bottoms out at 256
    // depth-8 leaf batches of 2 ids each — sum(2^0..2^8) = 511 total attempts.
    expect(MAX_TIMEOUT_SPLIT_DEPTH).toBe(8)
    expect(calls).toBe(511)
    expect(result.updatedIds).toEqual([])
    expect(result.errors).toHaveLength(256)
    for (const message of result.errors) {
      expect(message).toContain('2 row(s)')
    }
  })

  it('records a non-timeout error without retrying (not a timeout, so no halving)', async () => {
    let calls = 0
    const db: RepairDbDeps = {
      fetchCandidateIds: async () => [],
      nullContentHashForIds: async () => {
        calls++
        throw new Error('connection reset by peer')
      },
    }

    const ids = makeIds(4)
    const result = await updateBatchWithRetry(db, ids)

    expect(calls).toBe(1)
    expect(result.updatedIds).toEqual([])
    expect(result.errors).toEqual([`Batch update failed (4 row(s)): connection reset by peer`])
  })

  // Code-review pass ("no defect found") explicitly requested these two
  // edge cases as regression coverage, not because a bug was found.
  it('regression: an odd-length batch splits into disjoint, exhaustive halves with no dropped/duplicated id', async () => {
    const seen: string[] = []
    const db: RepairDbDeps = {
      fetchCandidateIds: async () => [],
      nullContentHashForIds: async (ids) => {
        if (ids.length > 1) throw STATEMENT_TIMEOUT_ERROR
        seen.push(...ids)
        return [...ids]
      },
    }

    const ids = makeIds(7) // odd length
    const result = await updateBatchWithRetry(db, ids)

    expect(result.updatedIds.sort()).toEqual([...ids].sort())
    expect(seen.sort()).toEqual([...ids].sort())
    expect(new Set(seen).size).toBe(7) // no duplicate processing across halves
  })

  it('regression: a batch already at MAX_TIMEOUT_SPLIT_DEPTH records a complete failed leaf, does not loop or drop it', async () => {
    let calls = 0
    const db: RepairDbDeps = {
      fetchCandidateIds: async () => [],
      nullContentHashForIds: async () => {
        calls++
        throw STATEMENT_TIMEOUT_ERROR
      },
    }

    const ids = makeIds(2)
    const result = await updateBatchWithRetry(db, ids, MAX_TIMEOUT_SPLIT_DEPTH)

    // Already at the cap — must not attempt to split further (ids.length > 1
    // is true, but depth < MAX_TIMEOUT_SPLIT_DEPTH is false), so exactly one
    // call, recording the whole 2-id leaf as a single failed batch.
    expect(calls).toBe(1)
    expect(result.updatedIds).toEqual([])
    expect(result.errors).toEqual([
      `Batch update failed (2 row(s)): canceling statement due to statement timeout`,
    ])
  })
})

// ---------------------------------------------------------------------------
// assertJoinableId / buildNullContentHashSql predicate re-check
// (code-review findings: HIGH — UPDATE must re-check the full predicate, not
// just id membership; MEDIUM — a comma inside an id would corrupt the
// comma-joined id list)
// ---------------------------------------------------------------------------

describe('assertJoinableId (code-review finding, MEDIUM)', () => {
  it('passes through an id with no comma unchanged', () => {
    expect(assertJoinableId('abc-123-def')).toBe('abc-123-def')
  })

  it('throws on an id containing a comma, rather than silently corrupting the batch', () => {
    expect(() => assertJoinableId('abc,123')).toThrow(/comma/)
  })
})

describe('buildNullContentHashSql (code-review finding, HIGH)', () => {
  it('re-checks LATCHED_ROW_PREDICATE in the UPDATE, not just id membership', () => {
    const sql = buildNullContentHashSql()
    expect(sql).toContain('id = ANY(string_to_array(')
    expect(sql).toContain(LATCHED_ROW_PREDICATE)
  })
})

// ---------------------------------------------------------------------------
// runRepair — dry-run vs apply
// ---------------------------------------------------------------------------

describe('runRepair — dry-run vs apply', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('dry-run NEVER calls nullContentHashForIds — touches nothing', async () => {
    const candidateIds = makeIds(2500)
    const { db, calls } = alwaysSucceedsDb(candidateIds)

    const result = await runRepair(db, { apply: false, batchSize: 500 })

    expect(calls).toEqual([])
    expect(result.updatedIds).toEqual([])
    expect(result.errors).toEqual([])
    expect(result.totalCandidates).toBe(2500)
    expect(result.batchCount).toBe(5)
    expect(result.logPath).toBeUndefined()
  })

  it('apply calls nullContentHashForIds once per batch and returns every unlatched id', async () => {
    const candidateIds = makeIds(1200)
    const { db, calls } = alwaysSucceedsDb(candidateIds)

    const result = await runRepair(db, { apply: true, batchSize: 500, logPath: '/dev/null' })

    expect(calls.map((c) => c.length)).toEqual([500, 500, 200])
    expect(result.updatedIds.sort()).toEqual([...candidateIds].sort())
    expect(result.errors).toEqual([])
  })

  it('rejects a batch size outside the plan-specified 500-1000 range', async () => {
    const { db } = alwaysSucceedsDb(makeIds(10))
    await expect(runRepair(db, { apply: false, batchSize: 100 })).rejects.toThrow(
      /--batch-size must be between 500 and 1000/
    )
    await expect(runRepair(db, { apply: false, batchSize: 5000 })).rejects.toThrow(
      /--batch-size must be between 500 and 1000/
    )
  })

  it('uses the documented default batch size when none is given', async () => {
    expect(DEFAULT_BATCH_SIZE).toBeGreaterThanOrEqual(MIN_BATCH_SIZE)
    expect(DEFAULT_BATCH_SIZE).toBeLessThanOrEqual(MAX_BATCH_SIZE)
    const { db, calls } = alwaysSucceedsDb(makeIds(DEFAULT_BATCH_SIZE + 1))
    await runRepair(db, { apply: true, logPath: '/dev/null' })
    expect(calls[0]).toHaveLength(DEFAULT_BATCH_SIZE)
    expect(calls[1]).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Dry-run console output is bounded
// ---------------------------------------------------------------------------

describe('runRepair — dry-run output is bounded', () => {
  it('never prints the full candidate id list, only a first/last-10 sample', async () => {
    const candidateIds = makeIds(2500, 'sample')
    const { db } = alwaysSucceedsDb(candidateIds)

    const logLines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      logLines.push(String(msg))
    })

    await runRepair(db, { apply: false, batchSize: 500 })
    vi.restoreAllMocks()

    const output = logLines.join('\n')

    // A middle-of-the-pack id must never appear — proof the full list isn't dumped.
    expect(output).not.toContain('sample-01250')
    // The first 10 and last 10 ids ARE expected (the bounded preview).
    for (let i = 0; i < 10; i++) {
      expect(output).toContain(`sample-${String(i).padStart(5, '0')}`)
    }
    for (let i = 2490; i < 2500; i++) {
      expect(output).toContain(`sample-${String(i).padStart(5, '0')}`)
    }
    // Total output size stays small regardless of candidate-set size (a full
    // 2500-id dump would run well past this).
    expect(output.length).toBeLessThan(4000)
  })
})

// ---------------------------------------------------------------------------
// Unlatched-ids log file
// ---------------------------------------------------------------------------

describe('appendBatchLog / runRepair log integration', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'repair-latched-name-rows-test-'))
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  it('appendBatchLog writes one JSONL line per call, creating parent dirs as needed', async () => {
    const logPath = join(dir, 'nested', 'unlatched.jsonl')

    await appendBatchLog(logPath, {
      batchIndex: 0,
      batchCount: 2,
      unlatchedAt: '2026-08-11T00:00:00.000Z',
      ids: ['a', 'b'],
    })
    await appendBatchLog(logPath, {
      batchIndex: 1,
      batchCount: 2,
      unlatchedAt: '2026-08-11T00:00:01.000Z',
      ids: ['c'],
    })

    const content = await readFile(logPath, 'utf-8')
    const lines = content.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toEqual({
      batchIndex: 0,
      batchCount: 2,
      unlatchedAt: '2026-08-11T00:00:00.000Z',
      ids: ['a', 'b'],
    })
    expect(JSON.parse(lines[1]).ids).toEqual(['c'])
  })

  it('runRepair --apply records every unlatched id to the log, split across batches', async () => {
    const candidateIds = makeIds(1200)
    const { db } = alwaysSucceedsDb(candidateIds)
    const logPath = join(dir, 'unlatched.jsonl')

    const result = await runRepair(db, { apply: true, batchSize: 500, logPath })

    expect(result.logPath).toBe(logPath)
    const content = await readFile(logPath, 'utf-8')
    const lines = content
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { ids: string[] })
    const loggedIds = lines.flatMap((l) => l.ids)
    expect(loggedIds.sort()).toEqual([...candidateIds].sort())
  })

  it('runRepair dry-run writes NO log file at all', async () => {
    const candidateIds = makeIds(50)
    const { db } = alwaysSucceedsDb(candidateIds)
    const logPath = join(dir, 'should-not-exist.jsonl')

    await runRepair(db, { apply: false, batchSize: 500, logPath })

    await expect(readFile(logPath, 'utf-8')).rejects.toThrow()
  })

  it('defaultLogPath builds a timestamped path under ~/.skillsmith/backups', () => {
    const p = defaultLogPath(new Date('2026-05-23T12:34:56.789Z'))
    expect(p).toContain('.skillsmith')
    expect(p).toContain('backups')
    expect(p).toContain('repair-latched-name-rows-2026-05-23')
    expect(p.endsWith('.jsonl')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// SQL builders (predicate single-source-of-truth, no AND TRUE)
// ---------------------------------------------------------------------------

describe('SQL builders', () => {
  it('the fetch query uses the exact latched-row predicate with no AND TRUE', () => {
    const sql = buildFetchCandidateIdsSql()
    expect(sql).toContain(LATCHED_ROW_PREDICATE)
    expect(sql).toContain('ORDER BY id')
    expect(sql).not.toMatch(/AND\s+TRUE/i)
  })

  it('the update query nulls content_hash for an explicit id list and returns ids', () => {
    const sql = buildNullContentHashSql()
    expect(sql).toContain('SET content_hash = NULL')
    expect(sql).toContain("id = ANY(string_to_array(:'ids', ','))")
    expect(sql).toContain('RETURNING id')
    expect(sql).not.toMatch(/AND\s+TRUE/i)
  })

  it('the predicate checks discovery_path, name/repo-derived-name, content_hash, and security_score', () => {
    expect(LATCHED_ROW_PREDICATE).toContain("discovery_path LIKE 'subdirectory_search%'")
    expect(LATCHED_ROW_PREDICATE).toContain('lower(name) = lower(split_part(')
    expect(LATCHED_ROW_PREDICATE).toContain('content_hash IS NOT NULL')
    expect(LATCHED_ROW_PREDICATE).toContain('security_score IS NOT NULL')
  })
})

// CLI arg-parsing tests (isFlagLikeToken/parseLogPathArg/parseBatchSizeArg)
// and the runRepair partial-failure-exit-status tests live in
// repair-latched-name-rows.cli.test.ts (split to stay under 500 lines).
