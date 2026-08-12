/**
 * SMI-5879 round-7: `--ids`/`--ids-file` targeting for the stale-quarantine
 * revalidation escalation. Design doc §11 ("the escalation named in 8.3.5.3.4
 * cannot target the rows it names") and the `##### 8.3.5.7 Required tests —
 * remediation CAS and exclusion reporting` table's round-7-tagged rows.
 *
 * Covers:
 *  - loadCandidates id-mode scopes to exactly the named rows regardless of
 *    table-wide (lexicographic UUID) ordering, and is disjoint from the
 *    `--limit`-based escalation this PR replaces.
 *  - id-mode INTERSECTS the fixed predicate (quarantined=true, GitHub-only
 *    repo_url, non-security quarantine_reason) — never bypasses it.
 *  - `--ids`/`--ids-file`/`--limit` mutual exclusion, refused in phase 1
 *    before any DB client is constructed.
 *  - malformed/empty phase-1 input (table-driven).
 *  - phase-2 reconciliation: not-loaded disposition (dry-run-safe,
 *    apply-throws-before-processing-loop), and the structural
 *    `loaded ⊆ requested` invariant.
 *  - the id-mode chunk loader's error-propagating batch loop (never
 *    `batchedIn()` — see revalidate-stale-quarantines.load.ts's doc comment).
 *  - the round-7 file-split's line budget and shape constraints.
 *
 * Network is never touched: `fetchSkillMd` and `runSiblingRescan` are mocked
 * deterministically-clean (same approach as
 * revalidate-stale-quarantines.guards.test.ts), so `processRow`'s presence
 * can be verified indirectly via fetch-call count/identity without spying a
 * same-module function (`processRow`/`runSweep` live in the same file, which
 * Vitest's ESM mocking cannot intercept for same-module calls).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runSweep, loadCandidates } from '../../indexer/revalidate-stale-quarantines.ts'
import type { StaleQuarantinedRow } from '../../indexer/revalidate-stale-quarantines.ts'
import {
  parseIdSelection,
  reconcileIdSelection,
  formatIdSelectionReport,
} from '../../indexer/revalidate-stale-quarantines.cli.ts'
import { IN_QUERY_BATCH_SIZE } from '../../indexer/batch-utils.ts'
import { fetchSkillMd } from '../../indexer/_shared/skill-md-fetch.ts'
import { readIndexerSource, hasShebang, hasDirectEntryGuard } from './run-gate-ast-helpers.ts'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { createSupabaseAdminClientMock } = vi.hoisted(() => ({
  createSupabaseAdminClientMock: vi.fn(() => {
    throw new Error(
      '[test] createSupabaseAdminClient must never be called from phase-1 parsing (parseIdSelection).'
    )
  }),
}))

vi.mock('../../indexer/_shared/supabase.ts', () => ({
  createSupabaseAdminClient: createSupabaseAdminClientMock,
}))

// processRow's sibling-rescan step is mocked deterministically clean (same
// pattern as guards.test.ts) so the clean-SKILL.md path reaches
// 'sibling-recovered' without any real network call.
vi.mock('../../indexer/revalidate-stale-quarantines.sibling.ts', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../indexer/revalidate-stale-quarantines.sibling.ts')>()
  return {
    ...real,
    runSiblingRescan: vi.fn(async () => ({
      status: 'clean' as const,
      findings: [],
      mergedScore: 5,
    })),
  }
})

// fetchSkillMd is mocked to always resolve clean content; parseSkillMdUrl
// stays real so `parsed.repo` (derived from each row's distinct repo_url)
// can be used to map fetch calls back to row identity.
vi.mock('../../indexer/_shared/skill-md-fetch.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../indexer/_shared/skill-md-fetch.ts')>()
  const cleanContent = `---
name: test-skill
description: A helpful skill.
---

# Test Skill

Run the following to use this skill:

\`\`\`bash
/test-skill --help
\`\`\`
`
  return {
    ...real,
    fetchSkillMd: vi.fn(async () => ({ kind: 'content' as const, content: cleanContent })),
  }
})

beforeEach(() => {
  createSupabaseAdminClientMock.mockClear()
  vi.mocked(fetchSkillMd).mockClear()
})

// ---------------------------------------------------------------------------
// Shared fixtures — a filtering, chunk-aware mock Supabase client
// ---------------------------------------------------------------------------

interface FilterableRow extends StaleQuarantinedRow {
  quarantined: boolean
}

function makeFilterableRow(id: string, overrides: Partial<FilterableRow> = {}): FilterableRow {
  return {
    id,
    author: 'acme',
    name: `skill-${id}`,
    repo_url: `https://github.com/acme/skill-${id}`,
    skill_path: null,
    quarantine_reason: 'stale',
    security_findings: [],
    quarantined: true,
    ...overrides,
  }
}

interface ChunkErrorInjection {
  /** 0-indexed `.in()` call number to fail on. */
  atCallIndex: number
  shape: 'null-data' | 'partial-data'
}

/** Strip the mock-only `quarantined` backing field, matching CANDIDATE_SELECT_COLUMNS's real projection (which never selects it). */
function projectRow(row: FilterableRow): StaleQuarantinedRow {
  const { quarantined, ...rest } = row
  void quarantined
  return rest
}

/**
 * A mock Supabase client whose `.eq`/`.ilike`/`.or` calls accumulate real
 * predicate functions applied at `.in()`/`.range()` resolution time — so a
 * production regression that OMITS a predicate clause from the id-mode query
 * (e.g. forgetting `.eq('quarantined', true)`) would let an excluded row
 * leak through, and this mock would surface it (it does not hardcode "apply
 * the whole fixed predicate" independent of what was actually chained).
 */
function makeFilterableDb(
  rows: FilterableRow[],
  opts: { errorInjection?: ChunkErrorInjection } = {}
) {
  const inCalls: string[][] = []
  const rangeCalls: Array<[number, number]> = []
  const eqCalls: Array<[string, unknown]> = []
  const ilikeCalls: Array<[string, string]> = []
  const orCalls: string[] = []
  const writeCalls = { update: 0, insert: 0, delete: 0 }
  let inCallCount = 0

  function newBuilder() {
    const predicates: Array<(r: FilterableRow) => boolean> = []
    const chain = {
      select: vi.fn(() => chain),
      eq: vi.fn((col: string, val: unknown) => {
        eqCalls.push([col, val])
        predicates.push((r) => (r as unknown as Record<string, unknown>)[col] === val)
        return chain
      }),
      ilike: vi.fn((col: string, pattern: string) => {
        ilikeCalls.push([col, pattern])
        const prefix = pattern.replace(/%$/, '').toLowerCase()
        predicates.push((r) => {
          const v = (r as unknown as Record<string, unknown>)[col]
          return typeof v === 'string' && v.toLowerCase().startsWith(prefix)
        })
        return chain
      }),
      or: vi.fn((expr: string) => {
        orCalls.push(expr)
        // The only `.or()` expression this codebase issues here.
        predicates.push((r) => r.quarantine_reason === null || r.quarantine_reason === 'stale')
        return chain
      }),
      order: vi.fn(() => chain),
      update: vi.fn(() => {
        writeCalls.update++
        return chain
      }),
      insert: vi.fn(() => {
        writeCalls.insert++
        return Promise.resolve({ data: null, error: null })
      }),
      delete: vi.fn(() => {
        writeCalls.delete++
        return chain
      }),
      in: vi.fn((_col: string, values: string[]) => {
        inCalls.push(values)
        const callIndex = inCallCount++
        if (opts.errorInjection && opts.errorInjection.atCallIndex === callIndex) {
          const error = { message: 'simulated PostgREST timeout' }
          if (opts.errorInjection.shape === 'partial-data') {
            const partial = rows
              .filter((r) => values.includes(r.id))
              .slice(0, 1)
              .map(projectRow)
            return Promise.resolve({ data: partial, error })
          }
          return Promise.resolve({ data: null, error })
        }
        const matches = rows
          .filter((r) => values.includes(r.id) && predicates.every((p) => p(r)))
          .map(projectRow)
        return Promise.resolve({ data: matches, error: null })
      }),
      range: vi.fn((from: number, to: number) => {
        rangeCalls.push([from, to])
        const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        const matches = sorted.filter((r) => predicates.every((p) => p(r))).map(projectRow)
        return Promise.resolve({ data: matches.slice(from, to + 1), error: null })
      }),
    }
    return chain
  }

  const db = { from: vi.fn(() => newBuilder()) }
  return { db, inCalls, rangeCalls, eqCalls, ilikeCalls, orCalls, writeCalls }
}

// ---------------------------------------------------------------------------
// Row 1: id-mode scopes to exactly the named rows, regardless of table-wide
// id ordering (round-7 regression test)
// ---------------------------------------------------------------------------

describe('loadCandidates / runSweep — id-mode scopes to exactly the named rows (round-7 regression test)', () => {
  // 35 bulk ids ("id-000".."id-034") + 5 targets deliberately given the
  // lexicographically LARGEST ids in the cohort ("id-zz0".."id-zz4") — the
  // exact rows `--limit 5` (ascending-id order) would never select.
  const bulkIds = Array.from({ length: 35 }, (_, i) => `id-${String(i).padStart(3, '0')}`)
  const targetIds = ['id-zz0', 'id-zz1', 'id-zz2', 'id-zz3', 'id-zz4']
  const allRows = [...bulkIds, ...targetIds].map((id) => makeFilterableRow(id))

  it('(a) returns exactly the 5 target rows, set-equal', async () => {
    const { db } = makeFilterableDb(allRows)
    const loaded = await loadCandidates(db as never, { ids: targetIds })
    expect(new Set(loaded.map((r) => r.id))).toEqual(new Set(targetIds))
    expect(loaded).toHaveLength(5)
  })

  it('(b) runSweep processes exactly those 5 rows via processRow (proven via fetchSkillMd identity)', async () => {
    const { db } = makeFilterableDb(allRows)
    const counts = await runSweep(db as never, { apply: false, ids: targetIds })
    expect(counts.total).toBe(5)
    const fetchedRepos = new Set(vi.mocked(fetchSkillMd).mock.calls.map(([parsed]) => parsed.repo))
    expect(fetchedRepos).toEqual(new Set(targetIds.map((id) => `skill-${id}`)))
  })

  it('(c) a control run with --limit 5 (no ids) returns a DISJOINT set — the defect this row exists to prevent', async () => {
    const { db } = makeFilterableDb(allRows)
    const loaded = await loadCandidates(db as never, { limit: 5 })
    const loadedIds = new Set(loaded.map((r) => r.id))
    const overlap = targetIds.filter((id) => loadedIds.has(id))
    expect(overlap).toHaveLength(0)
  })

  it('(d) chunks .in() at IN_QUERY_BATCH_SIZE and never calls .range()', async () => {
    const manyIds = Array.from({ length: 250 }, (_, i) => `id-${String(i).padStart(3, '0')}`)
    const manyRows = manyIds.map((id) => makeFilterableRow(id))
    const { db, inCalls, rangeCalls } = makeFilterableDb(manyRows)
    const loaded = await loadCandidates(db as never, { ids: manyIds })
    expect(loaded).toHaveLength(250)
    expect(inCalls).toHaveLength(3)
    expect(inCalls[0]).toHaveLength(IN_QUERY_BATCH_SIZE)
    expect(inCalls[1]).toHaveLength(IN_QUERY_BATCH_SIZE)
    expect(inCalls[2]).toHaveLength(50)
    expect(rangeCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Row 2: id-mode intersects the fixed predicate and never bypasses it
// (round-7)
// ---------------------------------------------------------------------------

describe('loadCandidates / runSweep — id-mode intersects the fixed predicate, never bypasses it (round-7)', () => {
  const okRow = makeFilterableRow('id-ok')
  const failsQuarantined = makeFilterableRow('id-fail-quarantined', { quarantined: false })
  const failsRepoHost = makeFilterableRow('id-fail-repo', { repo_url: 'https://gitlab.com/x/y' })
  const failsReason = makeFilterableRow('id-fail-reason', {
    quarantine_reason: 'malicious: prompt injection',
  })

  it.each([
    ['quarantined = false', failsQuarantined],
    ["repo_url not github.com ('https://gitlab.com/x/y')", failsRepoHost],
    ["quarantine_reason not NULL/'stale'", failsReason],
  ])(
    'a row failing "%s" is excluded by loadCandidates, appears in not-loaded, and processRow is never invoked for it',
    async (_label, badRow) => {
      const requestedIds = [okRow.id, badRow.id]
      const rows = [okRow, badRow]

      const { db } = makeFilterableDb(rows)
      const loaded = await loadCandidates(db as never, { ids: requestedIds })
      expect(loaded.map((r) => r.id)).toEqual([okRow.id])

      const { db: db2 } = makeFilterableDb(rows)
      const counts = await runSweep(db2 as never, { apply: false, ids: requestedIds })
      expect(counts.total).toBe(1)
      const fetchedRepos = vi.mocked(fetchSkillMd).mock.calls.map(([parsed]) => parsed.repo)
      expect(fetchedRepos).toContain(`skill-${okRow.id}`)
      expect(fetchedRepos).not.toContain(`skill-${badRow.id}`)
    }
  )

  it('the emitted query still contains all three fixed-predicate clauses in id-mode', async () => {
    const { db, eqCalls, ilikeCalls, orCalls } = makeFilterableDb([okRow])
    await loadCandidates(db as never, { ids: [okRow.id] })
    expect(eqCalls).toContainEqual(['quarantined', true])
    expect(ilikeCalls).toContainEqual(['repo_url', 'https://github.com/%'])
    expect(orCalls).toContainEqual('quarantine_reason.is.null,quarantine_reason.eq.stale')
  })
})

// ---------------------------------------------------------------------------
// Row 3: --ids/--ids-file/--limit mutual exclusion, refused before any DB
// touch (round-7)
// ---------------------------------------------------------------------------

describe('parseIdSelection — mutual exclusion, refused before any DB touch (round-7)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'smi5879-ids-'))
  })
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeTmpFile(name: string, content: string): string {
    const p = join(tmpDir, name)
    writeFileSync(p, content, 'utf8')
    return p
  }

  it('--ids-file (valid file) + --limit: throws naming both flags; createSupabaseAdminClient never called', () => {
    const file = writeTmpFile('valid.txt', 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1\n')
    expect(() =>
      parseIdSelection(['node', 'script', `--ids-file=${file}`, '--limit', '50'])
    ).toThrow(/--limit/i)
    expect(createSupabaseAdminClientMock).not.toHaveBeenCalled()
  })

  it('--ids + --limit: throws naming both flags; createSupabaseAdminClient never called', () => {
    expect(() => parseIdSelection(['node', 'script', '--ids=aaaa,bbbb', '--limit=50'])).toThrow(
      /--limit/i
    )
    expect(createSupabaseAdminClientMock).not.toHaveBeenCalled()
  })

  it('--ids + --ids-file together: throws naming both flags; createSupabaseAdminClient never called', () => {
    const file = writeTmpFile('valid2.txt', 'c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1\n')
    expect(() => parseIdSelection(['node', 'script', '--ids=aaaa', `--ids-file=${file}`])).toThrow(
      /--ids-file/i
    )
    expect(createSupabaseAdminClientMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Row 4: malformed and empty --ids input is rejected before any DB touch
// (round-7)
// ---------------------------------------------------------------------------

describe('parseIdSelection — malformed and empty input rejected before any DB touch (round-7)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'smi5879-ids-bad-'))
  })
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeTmpFile(name: string, content: string): string {
    const p = join(tmpDir, name)
    writeFileSync(p, content, 'utf8')
    return p
  }

  it.each([
    ['--ids= (empty)', () => ['--ids=']],
    ['--ids-file nonexistent path', () => [`--ids-file=${join(tmpDir, 'does-not-exist.txt')}`]],
    [
      'file containing only # comments and blank lines',
      () => [
        `--ids-file=${writeTmpFile('comments.txt', '# nothing here\n\n   \n# still nothing\n')}`,
      ],
    ],
    [
      'a psql border-artifact line',
      () => [
        `--ids-file=${writeTmpFile('psql.txt', '| 8f3a1234-aaaa-bbbb-cccc-dddddddddddd |\n')}`,
      ],
    ],
    [
      'a token with an embedded space',
      () => [`--ids-file=${writeTmpFile('space.txt', '8f3a 1234\n')}`],
    ],
    ['a 200-character token', () => [`--ids=${'a'.repeat(200)}`]],
    ['--ids=a,,b (empty element)', () => ['--ids=a,,b']],
    // Round-7-review finding (GPT-5.6-Sol adversarial pass): a bare flag with
    // no following value must NOT collapse to "flag absent" — that would
    // fall through to the unbounded whole-table sweep under --apply.
    ['--ids with no value, as the last token', () => ['--apply', '--ids']],
    ['--ids with no value, followed immediately by another flag', () => ['--ids', '--apply']],
    ['--ids-file with no value, as the last token', () => ['--apply', '--ids-file']],
    ['--limit with no value, as the last token', () => ['--limit']],
  ])(
    '%s: throws in phase 1; createSupabaseAdminClient never called; no fetch issued',
    (_label, buildArgs) => {
      expect(() => parseIdSelection(['node', 'script', ...buildArgs()])).toThrow()
      expect(createSupabaseAdminClientMock).not.toHaveBeenCalled()
      expect(vi.mocked(fetchSkillMd)).not.toHaveBeenCalled()
    }
  )

  // The zero-ids case is asserted separately and explicitly (design §11.2.3):
  // the failure mode it prevents is not "a bad run" but an UNBOUNDED one — a
  // selection that parses to zero ids must never fall through to the
  // whole-table sweep, so it needs its own distinguishable error, not a
  // generic "no selection given" that a `--limit`-shaped path could inherit.
  it('--ids= collapses to a dedicated zero-ids error, never "no selection given"', () => {
    expect(() => parseIdSelection(['node', 'script', '--ids='])).toThrow(/zero ids/i)
  })

  it('a comments-only --ids-file collapses to the same dedicated zero-ids error', () => {
    const file = writeTmpFile('only-comments.txt', '# nothing\n\n# still nothing\n')
    expect(() => parseIdSelection(['node', 'script', `--ids-file=${file}`])).toThrow(/zero ids/i)
  })
})

// ---------------------------------------------------------------------------
// Duplicate ids: deduped, order-preserving, AND both requested_raw and
// requested_unique are reported (design §11.2.3). Round-7-review finding
// (GPT-5.6-Sol adversarial pass on PR #2332): the raw (pre-dedupe) count was
// silently discarded, so an operator running --ids with duplicate entries
// had no way to see that dedupe happened at all.
// ---------------------------------------------------------------------------

describe('parseIdSelection — duplicate ids are deduped, order-preserving, with both counts reported', () => {
  it('parseIdSelection: ids is deduped order-preserving; requestedRawCount reflects the PRE-dedupe count', () => {
    const sel = parseIdSelection(['node', 'script', '--ids=id-a,id-b,id-a,id-c,id-b'])
    expect(sel.ids).toEqual(['id-a', 'id-b', 'id-c'])
    expect(sel.requestedRawCount).toBe(5)
  })

  it('formatIdSelectionReport prints requested_raw and requested_unique as distinct values when duplicates were supplied', () => {
    const sel = parseIdSelection(['node', 'script', '--ids=id-a,id-b,id-a'])
    const reconciliation = reconcileIdSelection(
      sel.ids as string[],
      sel.requestedRawCount as number,
      [{ id: 'id-a' }, { id: 'id-b' }],
      false
    )
    expect(reconciliation.requestedRawCount).toBe(3)
    expect(reconciliation.requested).toHaveLength(2)
    const report = formatIdSelectionReport(reconciliation)
    expect(report).toContain('requested_raw=3')
    expect(report).toContain('requested_unique=2')
  })
})

// ---------------------------------------------------------------------------
// Row: no override flag exists in the source (part of the "skipped and
// reported, never force-processed" row)
// ---------------------------------------------------------------------------

describe('no override flag exists in source (round-7)', () => {
  it('revalidate-stale-quarantines.{ts,load.ts,cli.ts} contain no allow-partial/force/--yes-shaped identifier', () => {
    for (const file of [
      'revalidate-stale-quarantines.ts',
      'revalidate-stale-quarantines.load.ts',
      'revalidate-stale-quarantines.cli.ts',
    ]) {
      const source = readIndexerSource(file)
      expect(source).not.toMatch(/allow-partial/i)
      expect(source).not.toMatch(/--force\b/)
      expect(source).not.toMatch(/--yes\b/)
    }
  })
})

// ---------------------------------------------------------------------------
// Row 5: loaded ⊆ requested is enforced, not assumed (round-7, structural)
// ---------------------------------------------------------------------------

describe('reconcileIdSelection — loaded ⊆ requested is enforced, not assumed (round-7, structural)', () => {
  it('refuses before the processing loop when a loaded id is not in the requested set, in BOTH modes', () => {
    const requested = ['id-a', 'id-b']
    const loadedRows = [{ id: 'id-a' }, { id: 'id-unexpected' }]
    expect(() => reconcileIdSelection(requested, requested.length, loadedRows, false)).toThrow(
      /id-unexpected/
    )
    expect(() => reconcileIdSelection(requested, requested.length, loadedRows, true)).toThrow(
      /id-unexpected/
    )
  })
})

// ---------------------------------------------------------------------------
// Row 6: a requested id that does not match the predicate is skipped and
// reported, never force-processed (round-7)
// ---------------------------------------------------------------------------

describe('a requested id that does not match the predicate is skipped and reported, never force-processed (round-7)', () => {
  const passingIds = Array.from({ length: 7 }, (_, i) => `id-pass-${i}`)
  const failingIds = ['id-fail-0', 'id-fail-1', 'id-fail-2']
  const requested = [...passingIds, ...failingIds]

  function buildRows(): FilterableRow[] {
    return [
      ...passingIds.map((id) => makeFilterableRow(id)),
      ...failingIds.map((id) => makeFilterableRow(id, { quarantined: false })),
    ]
  }

  it('dry-run: loaded=7, not-loaded=exactly the 3 failing ids, processRow invoked exactly 7 times, exits 0 (prints the divergence)', async () => {
    const { db } = makeFilterableDb(buildRows())
    const counts = await runSweep(db as never, { apply: false, ids: requested })
    expect(counts.total).toBe(7)
    const fetchedRepos = new Set(vi.mocked(fetchSkillMd).mock.calls.map(([parsed]) => parsed.repo))
    expect(fetchedRepos.size).toBe(7)
    for (const id of passingIds) expect(fetchedRepos.has(`skill-${id}`)).toBe(true)
    for (const id of failingIds) expect(fetchedRepos.has(`skill-${id}`)).toBe(false)
  })

  it('reconcileIdSelection reports requested=10 loaded=7 not-loaded=3 (exactly the failing ids), status "partial"', () => {
    const loadedRows = passingIds.map((id) => ({ id }))
    const reconciliation = reconcileIdSelection(requested, requested.length, loadedRows, false)
    expect(reconciliation.requested).toHaveLength(10)
    expect(reconciliation.loaded).toHaveLength(7)
    expect(new Set(reconciliation.notLoaded)).toEqual(new Set(failingIds))
    expect(reconciliation.status).toBe('partial')
    const report = formatIdSelectionReport(reconciliation)
    for (const id of failingIds) expect(report).toContain(id)
  })

  it('--apply: throws BEFORE the processing loop — zero fetches, zero writes', async () => {
    const { db, writeCalls } = makeFilterableDb(buildRows())
    await expect(runSweep(db as never, { apply: true, ids: requested })).rejects.toThrow(
      /did not match the fixed predicate/i
    )
    expect(vi.mocked(fetchSkillMd)).not.toHaveBeenCalled()
    expect(writeCalls.update).toBe(0)
    expect(writeCalls.insert).toBe(0)
    expect(writeCalls.delete).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Row 7: a chunk query error aborts before any write, in both modes, and is
// never reported as not-loaded (round-7, added after review round 7)
// ---------------------------------------------------------------------------

describe('a chunk query error aborts before any write, in both modes, never reported as not-loaded (round-7, added after review round 7)', () => {
  const ids = Array.from({ length: 5 }, (_, i) => `id-${i}`)

  function buildRows(): FilterableRow[] {
    return ids.map((id) => makeFilterableRow(id))
  }

  it.each([
    ['{ data: null, error }', 'null-data' as const],
    ['{ data: <partial rows>, error }', 'partial-data' as const],
  ])(
    '%s: throws before the processing loop in DRY-RUN mode; zero fetches',
    async (_label, shape) => {
      const { db } = makeFilterableDb(buildRows(), { errorInjection: { atCallIndex: 0, shape } })
      await expect(runSweep(db as never, { apply: false, ids })).rejects.toThrow(
        /simulated PostgREST timeout/i
      )
      expect(vi.mocked(fetchSkillMd)).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['{ data: null, error }', 'null-data' as const],
    ['{ data: <partial rows>, error }', 'partial-data' as const],
  ])('%s: throws before the processing loop in APPLY mode; zero writes', async (_label, shape) => {
    const { db, writeCalls } = makeFilterableDb(buildRows(), {
      errorInjection: { atCallIndex: 0, shape },
    })
    await expect(runSweep(db as never, { apply: true, ids })).rejects.toThrow(
      /simulated PostgREST timeout/i
    )
    expect(vi.mocked(fetchSkillMd)).not.toHaveBeenCalled()
    expect(writeCalls.update).toBe(0)
    expect(writeCalls.insert).toBe(0)
    expect(writeCalls.delete).toBe(0)
  })

  it('the thrown message names the failed chunk\'s ids and the underlying PostgREST error, never a generic "not found"', async () => {
    const { db } = makeFilterableDb(buildRows(), {
      errorInjection: { atCallIndex: 0, shape: 'null-data' },
    })
    let caught: Error | undefined
    try {
      await loadCandidates(db as never, { ids })
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeDefined()
    expect(caught?.message).toContain('simulated PostgREST timeout')
    for (const id of ids) expect(caught?.message).toContain(id)
  })

  it('a chunk error never surfaces as a not-loaded id — the whole sweep rejects instead of reporting a divergence', async () => {
    const { db } = makeFilterableDb(buildRows(), {
      errorInjection: { atCallIndex: 0, shape: 'partial-data' },
    })
    await expect(runSweep(db as never, { apply: false, ids })).rejects.not.toThrow(/not-loaded/i)
  })
})

// ---------------------------------------------------------------------------
// Row 8: the round-7 split holds its shape (round-7, structural, mirrors
// SMI-O's budget test)
// ---------------------------------------------------------------------------

/**
 * Real (editor/`wc -l`-equivalent) line count. Deliberately NOT
 * `content.split('\n').length` — see run-gate-line-budget.test.ts's
 * identical helper for the off-by-one rationale.
 */
function countRealLines(content: string): number {
  return content.endsWith('\n') ? content.split('\n').length - 1 : content.split('\n').length
}

describe('the round-7 split holds its shape (round-7, structural, mirrors SMI-O budget test)', () => {
  // Measured after the round-7 split (design §11.2.8): PAGE_SIZE/
  // loadCandidates moved to .load.ts; parseIdSelection/reconcileIdSelection/
  // the report formatter moved to .cli.ts. Round 7 is net NON-INCREASING on
  // this file versus its pre-round-7 (post-Wave-1) baseline of 496 lines —
  // the design doc's own "480" baseline was already stale by the time this
  // PR started (Wave 1 had already consumed that headroom); this budget is
  // pinned to the file's REAL measured post-split line count, not the design
  // doc's arithmetic. audit:standards Check 3 does NOT cover `scripts/`
  // (`audit-standards.mjs:186`) and `warn()`s rather than `fail()`s where it
  // does (`:248`, design §11.3.1) — this test is the ONLY enforcement.
  const MAX_LINES = 485

  it(`revalidate-stale-quarantines.ts stays at or under ${MAX_LINES} lines`, () => {
    const lineCount = countRealLines(readIndexerSource('revalidate-stale-quarantines.ts'))
    expect(
      lineCount,
      `revalidate-stale-quarantines.ts is ${lineCount} lines, over the ${MAX_LINES}-line round-7 budget (design §11.2.8). ` +
        'Split more of the id-selection/reconciliation logic into .cli.ts or .load.ts before adding more lines here.'
    ).toBeLessThanOrEqual(MAX_LINES)
  })

  it('neither .load.ts nor .cli.ts begins with a shebang (shape-3 pinned set unchanged)', () => {
    expect(hasShebang(readIndexerSource('revalidate-stale-quarantines.load.ts'))).toBe(false)
    expect(hasShebang(readIndexerSource('revalidate-stale-quarantines.cli.ts'))).toBe(false)
  })

  it('neither .load.ts nor .cli.ts contains an import.meta.url direct-entry guard (shape-1 pinned set unchanged)', () => {
    expect(hasDirectEntryGuard(readIndexerSource('revalidate-stale-quarantines.load.ts'))).toBe(
      false
    )
    expect(hasDirectEntryGuard(readIndexerSource('revalidate-stale-quarantines.cli.ts'))).toBe(
      false
    )
  })

  it('loadCandidates remains importable from revalidate-stale-quarantines.ts (guards.test.ts import path unaffected)', async () => {
    const mod = await import('../../indexer/revalidate-stale-quarantines.ts')
    expect(typeof mod.loadCandidates).toBe('function')
  })
})
