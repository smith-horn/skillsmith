/**
 * SMI-5165/5166: Unit tests for the stale-quarantine re-validation sweep — CAS
 * guards, candidate pagination, and quarantined-flag regression pins.
 *
 * Covers:
 *  - CAS-skipped path (DB update returns 0 rows)
 *  - Error path (DB update returns an error)
 *  - loadCandidates pagination past the 1000-row PostgREST cap
 *  - Regression pins on the `.eq('quarantined', true)` CAS condition (E4: a
 *    Wave-1-shaped row with no `quarantined` field still takes the clear path;
 *    E9: a quarantined=false row's CAS UPDATE safely no-ops instead of being
 *    retagged or having last_seen_at bumped)
 *
 * Network and DB are fully mocked. The scanner is the real fixed edge scanner
 * (same approach as dequarantine-false-positives.test.ts) so no scanner mock is
 * needed — we control the content to steer the outcome.
 *
 * Split out of revalidate-stale-quarantines.test.ts (SMI-5865) to keep that file
 * under the 500-line CI gate. The outcome-branch tests (sibling-recovered,
 * kept-security, repo-gone, parse-failed) and the transient fetch-error path
 * live in revalidate-stale-quarantines.outcomes.test.ts.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest'
import { processRow, loadCandidates } from '../../indexer/revalidate-stale-quarantines.ts'
import type { StaleQuarantinedRow } from '../../indexer/revalidate-stale-quarantines.ts'

// SMI-5437 Wave 2: processRow now runs sibling re-scan on quarantined=true/undefined
// rows with clean SKILL.md before clearing. Existing processRow tests (SMI-5165/5166)
// test pre-sibling-scan paths; mock the sibling module so those tests aren't broken
// by sibling network calls and focus on the SKILL.md / CAS / audit paths they own.
const RECOVERY_FINDINGS = [{ type: 'suspicious_pattern', filePath: 'config.json' }]
vi.mock('../../indexer/revalidate-stale-quarantines.sibling.ts', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../indexer/revalidate-stale-quarantines.sibling.ts')>()
  return {
    ...real,
    runSiblingRescan: vi.fn(async () => ({
      status: 'clean',
      findings: RECOVERY_FINDINGS,
      mergedScore: 12,
    })),
    buildSiblingQuarantineReason: vi.fn(() => '[recheck-sibling] test-reason'),
    writeSiblingRequarantine: vi.fn(async () => 'ok'),
  }
})

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** A minimal stale-quarantined row pointing at a real-looking GitHub URL. */
function makeRow(overrides: Partial<StaleQuarantinedRow> = {}): StaleQuarantinedRow {
  return {
    id: 'skill-uuid-1',
    author: 'acme',
    name: 'my-skill',
    repo_url: 'https://github.com/acme/my-skill',
    skill_path: null,
    quarantine_reason: 'stale',
    security_findings: [],
    ...overrides,
  }
}

/** SKILL.md content that the fixed scanner passes (riskScore < 40). */
const CLEAN_CONTENT = `---
name: my-skill
description: A helpful skill.
---

# My Skill

Run the following to use this skill:

\`\`\`bash
/my-skill --help
\`\`\`
`

/** Encode content as the GitHub Contents API would return it. */
function encodeAsGitHubResponse(content: string): string {
  // GitHub wraps base64 in 60-char lines
  const b64 = Buffer.from(content, 'utf-8').toString('base64')
  return b64.match(/.{1,60}/g)?.join('\n') ?? b64
}

/** Stub a successful GitHub Contents API fetch returning `content`. */
function stubFetchOk(content: string): MockInstance {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({
      content: encodeAsGitHubResponse(content),
      encoding: 'base64',
    }),
  } as unknown as Response)
}

/** Stub a 404 GitHub Contents API fetch. */
function stubFetch404(): MockInstance {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
    ok: false,
    status: 404,
  } as unknown as Response)
}

// ---------------------------------------------------------------------------
// Mock Supabase builder
// ---------------------------------------------------------------------------

interface MockDbState {
  updateError: { message: string } | null
  updatedRows: { id: string }[]
  insertError: { message: string } | null
}

/**
 * Build a chainable Supabase mock. The builder is reused across `.from()`,
 * `.update()`, `.eq()`, `.select()`, `.insert()` calls.
 */
function makeDb(state: MockDbState) {
  const builder = {
    from: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    insert: vi.fn().mockResolvedValue({ error: state.insertError }),
    eq: vi.fn().mockReturnThis(),
    select: vi.fn().mockResolvedValue({
      data: state.updateError ? null : state.updatedRows,
      error: state.updateError,
    }),
  }
  // Make `.from()` return the builder so chaining works for both update and insert.
  builder.from.mockImplementation(() => builder)
  return builder
}

// ---------------------------------------------------------------------------
// Tests: CAS guards
// ---------------------------------------------------------------------------

describe('processRow — cas-skipped', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('returns cas-skipped when DB update returns 0 rows', async () => {
    stubFetchOk(CLEAN_CONTENT)
    const row = makeRow()
    const db = makeDb({ updateError: null, updatedRows: [], insertError: null })
    const result = await processRow(row, {}, true, db as never)
    expect(result.outcome).toBe('cas-skipped')
    expect(db.insert).not.toHaveBeenCalled()
  })
})

describe('processRow — error', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('returns error when DB update fails', async () => {
    stubFetchOk(CLEAN_CONTENT)
    const row = makeRow()
    const db = makeDb({
      updateError: { message: 'connection timeout' },
      updatedRows: [],
      insertError: null,
    })
    const result = await processRow(row, {}, true, db as never)
    expect(result.outcome).toBe('error')
    expect(db.insert).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Tests: candidate pagination
// ---------------------------------------------------------------------------

describe('loadCandidates — pagination', () => {
  /** A select-only db double whose `.range(from,to)` slices a fixed row array. */
  function makeSelectDb(rows: StaleQuarantinedRow[]) {
    return {
      from: () => ({
        select: () => ({
          eq() {
            return this
          },
          ilike() {
            return this
          },
          or() {
            return this
          },
          order() {
            return this
          },
          range(from: number, to: number) {
            return Promise.resolve({ data: rows.slice(from, to + 1), error: null })
          },
        }),
      }),
    }
  }

  it('pages past the 1000-row cap to load the full candidate set', async () => {
    const rows = Array.from({ length: 1074 }, (_, i) => makeRow({ id: `id-${i}` }))
    const loaded = await loadCandidates(makeSelectDb(rows) as never)
    expect(loaded).toHaveLength(1074)
    expect(loaded[1073].id).toBe('id-1073')
  })

  it('respects an explicit limit without over-fetching', async () => {
    const rows = Array.from({ length: 1074 }, (_, i) => makeRow({ id: `id-${i}` }))
    const loaded = await loadCandidates(makeSelectDb(rows) as never, 10)
    expect(loaded).toHaveLength(10)
  })
})

// ---------------------------------------------------------------------------
// SMI-5166 E4: regression pin for the strict `=== false` prevention guard.
//
// processRow now branches on `row.quarantined === false` to take the prevention
// (live-touched) path. A Wave-1 `loadCandidates` row carries NO `quarantined`
// field (the select list omits it → undefined), and `undefined === false` is
// false, so such a row MUST take the existing quarantined=true clear path. This
// pins that contract so a future select-list change can't silently reroute the
// Wave-1 sweep into the prevention branch (which would no-op its CAS against
// `.eq('quarantined', false)` and leave genuinely-quarantined rows stuck).
// ---------------------------------------------------------------------------

// SMI-5437 Wave 2: E4 pin updated — quarantined=undefined rows now go through sibling
// rescan (mocked clean above) and return 'sibling-recovered', not 'cleared'. The core
// invariant (must NOT take the live-touched path) and the CAS guard remain.
describe('processRow — E4 strict ===false guard (Wave-1 cohort still clears)', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('a loadCandidates-shaped row (no quarantined field) sibling-recovers, not live-touched', async () => {
    stubFetchOk(CLEAN_CONTENT)
    // Shape a row exactly like loadCandidates returns: no `quarantined` and no
    // `last_seen_at` keys at all (both undefined).
    const row: StaleQuarantinedRow = {
      id: 'wave1-uuid',
      author: 'acme',
      name: 'wave1-skill',
      repo_url: 'https://github.com/acme/wave1-skill',
      skill_path: null,
      quarantine_reason: 'stale',
      security_findings: [],
    }
    expect(row.quarantined).toBeUndefined()
    expect(row.last_seen_at).toBeUndefined()

    const db = makeDb({ updateError: null, updatedRows: [{ id: row.id }], insertError: null })
    const result = await processRow(row, {}, true, db as never)

    // MUST be the sibling-recovered path (sibling rescan ran, found clean), NOT live-touched.
    expect(result.outcome).toBe('sibling-recovered')
    // The clear CAS is gated on `.eq('quarantined', true)`, never on `false`.
    const eqCalls = db.eq.mock.calls as [string, unknown][]
    expect(eqCalls.some(([col, val]) => col === 'quarantined' && val === true)).toBe(true)
    expect(eqCalls.some(([col, val]) => col === 'quarantined' && val === false)).toBe(false)
    // A clear flips quarantined=false in the payload.
    const updateArg = db.update.mock.calls[0][0]
    expect(updateArg.quarantined).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// SMI-5166 E9: retagUnreachable is now CAS-gated on `.eq('quarantined', true)`.
//
// The recurring recheck's candidate set includes quarantined=false rows. A
// quarantined=false row whose GitHub repo 404s must NOT be re-tagged
// `quarantine:repo_gone` and must NOT have last_seen_at bumped — that would keep
// a dead repo artificially alive (E8); maintenance ages it out at 7 days. The
// CAS UPDATE no-ops for such a row (0 rows affected), and the audit insert is
// gated on rows-affected so a no-op write emits no misleading audit row. The
// contrast: a quarantined=true 404 row DOES retag + audit (the CAS hits).
// ---------------------------------------------------------------------------

describe('processRow — E9 retagUnreachable CAS safety (quarantined=false 404)', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('does NOT audit or bump last_seen_at when a quarantined=false repo 404s', async () => {
    stubFetch404()
    const row = makeRow({ quarantined: false })
    // CAS no-ops: the `.eq('quarantined', true)` guard matches no row, so the
    // conditional UPDATE returns 0 rows.
    const db = makeDb({ updateError: null, updatedRows: [], insertError: null })
    const result = await processRow(row, {}, true, db as never)

    expect(result.outcome).toBe('repo-gone')
    // The CAS UPDATE is attempted (gated on quarantined=true) ...
    const eqCalls = db.eq.mock.calls as [string, unknown][]
    expect(eqCalls.some(([col, val]) => col === 'quarantined' && val === true)).toBe(true)
    // ... but no audit row is written because it affected 0 rows.
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('DOES retag + audit when a quarantined=true repo 404s (CAS hits)', async () => {
    stubFetch404()
    const row = makeRow({ quarantined: true })
    const db = makeDb({ updateError: null, updatedRows: [{ id: row.id }], insertError: null })
    const result = await processRow(row, {}, true, db as never)

    expect(result.outcome).toBe('repo-gone')
    expect(db.update).toHaveBeenCalledOnce()
    expect(db.insert).toHaveBeenCalledOnce()
    expect(db.insert.mock.calls[0][0].event_type).toBe('quarantine:repo_gone')
  })
})
