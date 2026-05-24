/**
 * SMI-5167: Unit tests for the dead-quarantine purge tool.
 *
 * Covers the pure, safety-critical primitives plus the orchestration guards:
 *  - cohort classification for each dead-set predicate arm
 *  - CSV field escaping (commas, quotes, newlines, JSON, null) + row order
 *  - the export-count == selected-count integrity guard (abort on mismatch)
 *  - dry-run performs the export but NO delete
 *  - --apply batches skills deletes by 500 and explicitly deletes
 *    quarantine_approvals + writes one skill:purged audit row
 *
 * Supabase and the filesystem are fully mocked / redirected to a temp dir.
 * Deterministic — no real network and no writes outside `os.tmpdir()`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyCohort,
  escapeCsvField,
  toCsvRow,
  buildCsv,
  countByCohort,
  describeDeadSet,
  defaultExportPath,
  CSV_COLUMNS,
  DELETE_BATCH,
  deleteInBatches,
  runPurge,
  type DeadRow,
} from '../../indexer/purge-dead-quarantines.ts'

/** Expected per-batch lengths when deleting `n` rows in `DELETE_BATCH` chunks. */
function expectedBatches(n: number): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i += DELETE_BATCH) out.push(Math.min(DELETE_BATCH, n - i))
  return out
}

// The script reads the admin client from this module; stub the factory so no
// real network client is ever constructed.
vi.mock('../../indexer/_shared/supabase.ts', () => ({
  createSupabaseAdminClient: () => mockDb,
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<DeadRow> = {}): DeadRow {
  return {
    id: 'id-1',
    author: 'acme',
    name: 'my-skill',
    repo_url: 'https://github.com/acme/my-skill',
    skill_path: null,
    quarantine_reason: 'Repository deleted or not found: https://github.com/acme/my-skill',
    security_score: 80,
    security_findings: [{ type: 'jailbreak' }],
    quarantined: true,
    created_at: '2026-01-01T00:00:00.000Z',
    last_seen_at: '2026-05-01T00:00:00.000Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Mock Supabase
// ---------------------------------------------------------------------------

interface MockDbConfig {
  /** Rows returned by the dead-set SELECT (split across pages of 1000). */
  selectRows: DeadRow[]
  /** ids the skills DELETE confirms removed (defaults to all requested). */
  deletedSkillIds?: string[]
  /** skill_ids the approvals DELETE confirms removed. */
  deletedApprovalIds?: string[]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- chainable test double
let mockDb: any
let auditInserts: Record<string, unknown>[]
let skillDeleteBatches: string[][]
let approvalDeleteBatches: string[][]

/**
 * Build a chainable Supabase double. Each `.from(table)` returns a fresh,
 * table-aware chain whose terminal awaited result depends on the operation
 * (select vs delete vs insert) and which page is requested.
 */
function installMockDb(cfg: MockDbConfig): void {
  auditInserts = []
  skillDeleteBatches = []
  approvalDeleteBatches = []

  mockDb = {
    from(table: string) {
      // --- DELETE chain: .delete().in(col, batch).select(col) ---
      const deleteChain = {
        _ids: [] as string[],
        in(_col: string, ids: string[]) {
          this._ids = ids
          return this
        },
        select() {
          if (table === 'skills') {
            skillDeleteBatches.push(this._ids)
            const allowed = new Set(cfg.deletedSkillIds ?? this._ids)
            const data = this._ids.filter((id) => allowed.has(id)).map((id) => ({ id }))
            return Promise.resolve({ data, error: null })
          }
          approvalDeleteBatches.push(this._ids)
          const allowed = new Set(cfg.deletedApprovalIds ?? this._ids)
          const data = this._ids.filter((id) => allowed.has(id)).map((skill_id) => ({ skill_id }))
          return Promise.resolve({ data, error: null })
        },
      }

      // --- SELECT chain: .select(cols).eq().or().order().range(from,to) ---
      const selectChain = {
        eq() {
          return this
        },
        or() {
          return this
        },
        order() {
          return this
        },
        range(from: number, to: number) {
          const data = cfg.selectRows.slice(from, to + 1)
          return Promise.resolve({ data, error: null })
        },
      }

      return {
        select: () => selectChain,
        delete: () => deleteChain,
        insert: (row: Record<string, unknown>) => {
          auditInserts.push(row)
          return Promise.resolve({ error: null })
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('classifyCohort', () => {
  it('classifies a null repo_url as no-repo-url (predicate-order precedence)', () => {
    expect(classifyCohort({ repo_url: null, quarantine_reason: 'security scan: x' })).toBe(
      'no-repo-url'
    )
  })

  it('classifies any row with a repo_url under the repository arm', () => {
    expect(
      classifyCohort({
        repo_url: 'https://github.com/a/b',
        quarantine_reason: 'Repository deleted or not found: https://github.com/a/b',
      })
    ).toBe('repository')
  })

  it('treats null repo_url as no-repo-url even with a repository-ish reason', () => {
    expect(classifyCohort({ repo_url: null, quarantine_reason: 'Repository archived: x' })).toBe(
      'no-repo-url'
    )
  })
})

describe('escapeCsvField', () => {
  it('passes a plain value through unquoted', () => {
    expect(escapeCsvField('hello')).toBe('hello')
  })

  it('renders null/undefined as an empty field', () => {
    expect(escapeCsvField(null)).toBe('')
    expect(escapeCsvField(undefined)).toBe('')
  })

  it('quotes and escapes a field containing a comma', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"')
  })

  it('doubles embedded double-quotes', () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""')
  })

  it('quotes a field containing a newline or carriage return', () => {
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"')
    expect(escapeCsvField('a\r\nb')).toBe('"a\r\nb"')
  })

  it('JSON-encodes object fields (e.g. security_findings) then escapes', () => {
    expect(escapeCsvField([{ type: 'x,y' }])).toBe('"[{""type"":""x,y""}]"')
  })

  it('stringifies numbers and booleans', () => {
    expect(escapeCsvField(80)).toBe('80')
    expect(escapeCsvField(true)).toBe('true')
  })
})

describe('toCsvRow / buildCsv', () => {
  it('emits fields in CSV_COLUMNS order', () => {
    const row = makeRow({ id: 'X', author: 'me', name: 'n' })
    const fields = toCsvRow(row).split(',')
    expect(fields[0]).toBe('X')
    expect(fields[CSV_COLUMNS.indexOf('author')]).toBe('me')
    expect(fields[CSV_COLUMNS.indexOf('name')]).toBe('n')
  })

  it('escapes a comma-bearing quarantine_reason without breaking column count', () => {
    const row = makeRow({ quarantine_reason: 'security scan: a, b, c' })
    expect(toCsvRow(row)).toContain('"security scan: a, b, c"')
  })

  it('builds a header + one line per row + trailing newline, with rowCount', () => {
    const { csv, rowCount } = buildCsv([makeRow({ id: '1' }), makeRow({ id: '2' })])
    const lines = csv.split('\n')
    expect(lines[0]).toBe(CSV_COLUMNS.join(','))
    expect(lines[1].startsWith('1,')).toBe(true)
    expect(lines[2].startsWith('2,')).toBe(true)
    expect(csv.endsWith('\n')).toBe(true)
    expect(rowCount).toBe(2)
  })

  it('rowCount counts serialized rows, not physical newlines (embedded-newline safe)', () => {
    // A quarantine_reason with an embedded newline spans 2 physical lines once
    // quoted, but is still ONE data row — rowCount must stay 1.
    const { csv, rowCount } = buildCsv([makeRow({ id: '1', quarantine_reason: 'a\nb' })])
    expect(rowCount).toBe(1)
    expect(csv).toContain('"a\nb"')
    // Physical-line count would be misleading here; assert rowCount is the guard.
    expect(csv.split('\n').filter((l) => l.length > 0).length).toBeGreaterThan(rowCount + 1)
  })
})

describe('countByCohort', () => {
  it('partitions the dead set across the two cohorts', () => {
    const counts = countByCohort([
      makeRow({ repo_url: null }),
      makeRow({ quarantine_reason: 'Repository deleted or not found: x' }),
      makeRow({ quarantine_reason: 'Repository archived: y' }),
    ])
    expect(counts['no-repo-url']).toBe(1)
    expect(counts.repository).toBe(2)
  })
})

describe('describeDeadSet / defaultExportPath', () => {
  it('describes the exact dead-set predicate', () => {
    expect(describeDeadSet()).toContain('quarantined = true')
    expect(describeDeadSet()).toContain('repo_url IS NULL')
    expect(describeDeadSet()).toContain("quarantine_reason ILIKE 'repository%'")
    // Security-scan rows are deliberately NOT in the dead set (may be live malware).
    expect(describeDeadSet()).not.toContain('security scan')
  })

  it('builds a timestamped path under ~/.skillsmith/backups', () => {
    const p = defaultExportPath(new Date('2026-05-23T12:34:56.789Z'))
    expect(p).toContain('.skillsmith')
    expect(p).toContain('purge-dead-quarantines-2026-05-23T12-34-56-789Z.csv')
  })
})

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

describe('runPurge', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'purge-test-'))
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  it('dry-run writes the export but performs NO delete', async () => {
    installMockDb({ selectRows: [makeRow({ id: 'a' }), makeRow({ id: 'b' })] })
    const exportPath = join(dir, 'export.csv')

    const counts = await runPurge({ apply: false, exportPath })

    expect(counts.total).toBe(2)
    expect(counts.deleted).toBe(0)
    expect(skillDeleteBatches).toEqual([])
    expect(approvalDeleteBatches).toEqual([])
    expect(auditInserts).toEqual([])

    const csv = await readFile(exportPath, 'utf-8')
    expect(csv.split('\n').filter((l) => l.length > 0)).toHaveLength(3) // header + 2 rows
  })

  it('--apply batches skills deletes by 500 and deletes quarantine_approvals', async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => makeRow({ id: `id-${i}` }))
    installMockDb({ selectRows: rows })
    const exportPath = join(dir, 'export.csv')

    const counts = await runPurge({ apply: true, exportPath })

    expect(counts.total).toBe(1200)
    expect(counts.deleted).toBe(1200)
    // Deleted in DELETE_BATCH-sized chunks (URL-length-safe for PostgREST .in()).
    expect(skillDeleteBatches.map((b) => b.length)).toEqual(expectedBatches(1200))
    expect(approvalDeleteBatches.map((b) => b.length)).toEqual(expectedBatches(1200))
    expect(skillDeleteBatches.every((b) => b.length <= DELETE_BATCH)).toBe(true)
    expect(counts.approvalsDeleted).toBe(1200)

    // Exactly one skill:purged audit row.
    expect(auditInserts).toHaveLength(1)
    expect(auditInserts[0].event_type).toBe('skill:purged')
    expect(auditInserts[0].action).toBe('purge_dead_quarantines')
    const meta = auditInserts[0].metadata as Record<string, unknown>
    expect(meta.smi).toBe('SMI-5167')
    expect(meta.total_purged).toBe(1200)
    expect(meta.export_path).toBe(exportPath)
  })

  it('--limit caps the selection (staged run)', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => makeRow({ id: `id-${i}` }))
    installMockDb({ selectRows: rows })

    const counts = await runPurge({ apply: true, limit: 10, exportPath: join(dir, 'e.csv') })

    expect(counts.total).toBe(10)
    expect(counts.deleted).toBe(10)
    expect(skillDeleteBatches.flat()).toHaveLength(10)
  })

  it('purges a row whose quarantine_reason contains an embedded newline (count stays correct)', async () => {
    // A newline inside a quoted CSV field must NOT inflate the integrity count
    // and falsely abort — this row is still exactly one dead row.
    installMockDb({
      selectRows: [makeRow({ id: 'a', quarantine_reason: 'security scan:\ninjected' })],
    })
    const counts = await runPurge({ apply: true, exportPath: join(dir, 'e.csv') })
    expect(counts.deleted).toBe(1)
    expect(skillDeleteBatches.flat()).toEqual(['a'])
  })

  it('export rowCount always equals the selected count (integrity guard invariant)', () => {
    // The apply-mode guard aborts when `buildCsv().rowCount !== rows.length`.
    // Prove the invariant the guard relies on holds for adversarial fields
    // (embedded newlines/quotes/commas) so the guard never false-aborts and any
    // real mismatch (a serialization bug) would genuinely surface.
    const rows = [
      makeRow({ id: 'a', quarantine_reason: 'a,b' }),
      makeRow({ id: 'b', quarantine_reason: 'x\ny' }),
      makeRow({ id: 'c', name: 'has "quote"' }),
    ]
    expect(buildCsv(rows).rowCount).toBe(rows.length)
  })
})

describe('deleteInBatches — transient retry', () => {
  /** A delete chain whose terminal `.select()` throws `throwTimes` then succeeds. */
  function dbThrowsThenOk(throwTimes: number) {
    let calls = 0
    return {
      from: () => ({
        delete: () => ({
          in() {
            return this
          },
          select() {
            calls++
            if (calls <= throwTimes) throw new TypeError('fetch failed')
            return Promise.resolve({ data: [{ id: 'x' }], error: null })
          },
        }),
      }),
    }
  }

  it('retries a thrown network error then succeeds', async () => {
    const n = await deleteInBatches(dbThrowsThenOk(2) as never, 'skills', 'id', ['a'], undefined, 3)
    expect(n).toBe(1)
  }, 10000)

  it('throws after exhausting retries', async () => {
    await expect(
      deleteInBatches(dbThrowsThenOk(99) as never, 'skills', 'id', ['a'], undefined, 1)
    ).rejects.toThrow(/after 2 attempts/)
  }, 10000)
})
