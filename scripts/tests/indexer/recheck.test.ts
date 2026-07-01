/**
 * SMI-5166: Unit tests for the durable indexer stale-recheck.
 *
 * These tests are the SAFETY CONTRACT for the recheck. They prove the invariants
 * that keep a live-but-undiscovered GitHub skill out of permanent stale
 * quarantine:
 *
 *   - loadRecheckCandidates serves PREVENTION (pass 1) before SELF-HEAL (pass 2)
 *     under cap saturation, and never issues pass 2 once the cap is filled (E2).
 *   - An aging live row (quarantined === false) gets a CAS-gated last_seen_at
 *     touch — the write that beats the 7-day maintenance gate (prevention).
 *   - The CAS guard no-ops if the row was quarantined between load and write,
 *     yielding `cas-skipped` and NOT a stale last_seen_at (E1 race).
 *   - A quarantined=true clean row is cleared via the `.eq('quarantined', true)`
 *     CAS path (self-heal).
 *   - A throttled run (fetch_error_rate > 0.1) is audited 'partial' with the rate
 *     persisted (E3 prevention outage).
 *   - Inputs are clamped (threshold->6, batch->10, cap->5000) (E7).
 *   - The killswitch writes exactly one audit row and loads no candidates (P3).
 *   - A normal run writes exactly one `indexer:run` audit row of run_type
 *     'recheck' with a populated counters object.
 *
 * GitHub fetch is stubbed on globalThis.fetch; the Supabase client is a
 * hand-rolled chainable mock (same approach as
 * revalidate-stale-quarantines.test.ts), both housed in recheck.test-helpers.ts.
 * The real processRow / loadRecheckCandidates run against these doubles so the
 * tests exercise the true integrated behavior, not a re-implementation.
 * writeIndexerAuditLog is mocked to assert the audit row shape without a DB.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runRecheck, loadRecheckCandidates } from '../../indexer/recheck.ts'
import {
  makeRow,
  makeLoadDb,
  makeRunDb,
  stubFetchCleanAlways,
  stubFetchMaliciousAlways,
  stubFetchMaliciousSkillMdCleanSiblings,
  stubFetchCleanSkillMdMaliciousSiblings,
  stubFetchCleanSkillMdTransientSiblings,
  stubFetchTransientAlways,
  isRawGithubUrl,
  BASE_OPTS,
} from './recheck.test-helpers.ts'

// writeIndexerAuditLog is mocked so we can assert the audit row shape directly
// (eventResult + the recheck counters object + run_type) without a DB double.
const writeIndexerAuditLog = vi.fn(async () => undefined)
vi.mock('../../indexer/indexer-audit-log.ts', () => ({
  writeIndexerAuditLog: (...args: unknown[]) => writeIndexerAuditLog(...args),
}))

// buildGitHubHeaders has no required env; let it run real (returns base headers).

// ---------------------------------------------------------------------------
// TASK 1.1 — loadRecheckCandidates two-pass priority (E2)
// ---------------------------------------------------------------------------

describe('loadRecheckCandidates — two-pass preventive priority (E2)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns ALL pass-1 (prevention) rows before any pass-2 (self-heal) row', async () => {
    const pass1 = Array.from({ length: 4 }, (_, i) =>
      makeRow({ id: `p1-${i}`, quarantined: false })
    )
    const pass2 = Array.from({ length: 4 }, (_, i) =>
      makeRow({ id: `p2-${i}`, quarantined: true, quarantine_reason: 'stale' })
    )
    const handle = makeLoadDb(pass1, pass2)
    // cap (6) < N+M (8): pass1 fills 4, pass2 supplies the remaining 2.
    const rows = await loadRecheckCandidates(handle.db, { thresholdDays: 5, cap: 6 })

    expect(rows).toHaveLength(6)
    // The first 4 are ALL pass-1 ids; no pass-2 id appears before a pass-1 id.
    expect(rows.slice(0, 4).map((r) => r.id)).toEqual(['p1-0', 'p1-1', 'p1-2', 'p1-3'])
    expect(rows.slice(4).map((r) => r.id)).toEqual(['p2-0', 'p2-1'])
  })

  it('does NOT issue the pass-2 query when pass-1 alone fills the cap', async () => {
    const pass1 = Array.from({ length: 5 }, (_, i) =>
      makeRow({ id: `p1-${i}`, quarantined: false })
    )
    const pass2 = [makeRow({ id: 'p2-0', quarantined: true })]
    const handle = makeLoadDb(pass1, pass2)
    const rows = await loadRecheckCandidates(handle.db, { thresholdDays: 5, cap: 5 })

    expect(rows).toHaveLength(5)
    expect(rows.every((r) => r.id.startsWith('p1-'))).toBe(true)
    // The pass-2 discriminator (`.or(...)`) must never run — remaining <= 0.
    expect(handle.pass2Issued).toBe(0)
  })

  it('both passes filter last_seen_at < cutoff, github repo_url, and order ascending', async () => {
    const pass1 = [makeRow({ id: 'p1-0', quarantined: false })]
    const pass2 = [makeRow({ id: 'p2-0', quarantined: true, quarantine_reason: 'stale' })]
    const handle = makeLoadDb(pass1, pass2)
    await loadRecheckCandidates(handle.db, { thresholdDays: 5, cap: 10 })

    // Both passes filter on last_seen_at < <ISO cutoff>.
    expect(handle.ltCalls).toHaveLength(2)
    for (const [col, val] of handle.ltCalls) {
      expect(col).toBe('last_seen_at')
      expect(typeof val).toBe('string')
      // ISO 8601 cutoff, roughly thresholdDays ago.
      expect(() => new Date(val as string).toISOString()).not.toThrow()
    }
    // Both passes filter the GitHub repo_url prefix.
    expect(handle.ilikeCalls).toHaveLength(2)
    for (const [col, val] of handle.ilikeCalls) {
      expect(col).toBe('repo_url')
      expect(val).toBe('https://github.com/%')
    }
    // Both passes order last_seen_at ascending (oldest = most urgent first).
    expect(handle.orderCalls).toHaveLength(2)
    for (const [col, opts] of handle.orderCalls) {
      expect(col).toBe('last_seen_at')
      expect(opts).toEqual({ ascending: true })
    }
    // Pass 1 is `quarantined = false`; pass 2 is `quarantined = true`.
    expect(handle.eqCalls).toContainEqual(['quarantined', false])
    expect(handle.eqCalls).toContainEqual(['quarantined', true])
  })
})

// ---------------------------------------------------------------------------
// TASK 1.2 — PREVENTION invariant (CAS-gated last_seen_at touch)
// ---------------------------------------------------------------------------

describe('runRecheck — prevention invariant (live row, CAS touch)', () => {
  beforeEach(() => {
    writeIndexerAuditLog.mockClear()
    delete process.env.RECHECK_ENABLED
  })
  afterEach(() => vi.restoreAllMocks())

  it('CAS-touches last_seen_at on .eq(quarantined,false) and counts live_touched', async () => {
    stubFetchCleanAlways()
    const row = makeRow({ id: 'live-1', quarantined: false })
    // CAS hits: the conditional UPDATE returns the row id.
    const handle = makeRunDb({
      pass1: [row],
      pass2: [],
      casReturns: [{ id: row.id }],
      casError: null,
    })

    const result = await runRecheck({ supabase: handle.db, ...BASE_OPTS })

    expect(result.recheck.live_touched).toBe(1)
    expect(result.recheck.cleared).toBe(0)
    // The prevention write must set last_seen_at and nothing else.
    expect(handle.updatePayloads).toHaveLength(1)
    expect(Object.keys(handle.updatePayloads[0])).toEqual(['last_seen_at'])
    expect(typeof handle.updatePayloads[0].last_seen_at).toBe('string')
    // CAS guard MUST be `.eq('quarantined', false)` (prevention path), plus the id.
    expect(handle.eqCalls).toContainEqual(['id', row.id])
    expect(handle.eqCalls).toContainEqual(['quarantined', false])
    // A pure liveness touch emits NO audit row (silent, like the indexer touch).
    expect(handle.auditInserts).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// TASK 1.3 — E1 race: row quarantined between load and write
// ---------------------------------------------------------------------------

describe('runRecheck — E1 race (CAS no-op when row quarantined mid-run)', () => {
  beforeEach(() => {
    writeIndexerAuditLog.mockClear()
    delete process.env.RECHECK_ENABLED
  })
  afterEach(() => vi.restoreAllMocks())

  it('yields cas-skipped (not live_touched) and applies no effective last_seen_at', async () => {
    stubFetchCleanAlways()
    const row = makeRow({ id: 'raced-1', quarantined: false })
    // The CAS `.eq('quarantined', false).select('id')` returns 0 rows: the row
    // was quarantined between load and write, so the conditional UPDATE no-ops.
    const handle = makeRunDb({
      pass1: [row],
      pass2: [],
      casReturns: [],
      casError: null,
    })

    const result = await runRecheck({ supabase: handle.db, ...BASE_OPTS })

    expect(result.recheck.cas_skipped).toBe(1)
    expect(result.recheck.live_touched).toBe(0)
    expect(result.recheck.cleared).toBe(0)
    // The write was attempted (CAS) but affected 0 rows — last_seen_at is NOT
    // effectively applied; the row keeps its old timestamp and is picked up as
    // quarantined=true stale next run (self-heal). No audit row for a no-op.
    expect(handle.auditInserts).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// TASK 1.4 — self-heal: quarantined=true clean row cleared via .eq(quarantined,true)
// ---------------------------------------------------------------------------

describe('runRecheck — self-heal (quarantined clean row cleared)', () => {
  beforeEach(() => {
    writeIndexerAuditLog.mockClear()
    delete process.env.RECHECK_ENABLED
  })
  afterEach(() => vi.restoreAllMocks())

  it('clears a quarantined=true stale clean row via the .eq(quarantined,true) CAS', async () => {
    stubFetchCleanAlways()
    const row = makeRow({ id: 'heal-1', quarantined: true, quarantine_reason: 'stale' })
    const handle = makeRunDb({
      pass1: [],
      pass2: [row],
      casReturns: [{ id: row.id }],
      casError: null,
    })

    const result = await runRecheck({ supabase: handle.db, ...BASE_OPTS })

    expect(result.recheck.cleared).toBe(1)
    expect(result.recheck.live_touched).toBe(0)
    // The clear payload flips quarantined=false and the CAS guards quarantined=true.
    expect(handle.updatePayloads).toHaveLength(1)
    expect(handle.updatePayloads[0].quarantined).toBe(false)
    expect(handle.updatePayloads[0].quarantine_reason).toBeNull()
    expect(handle.eqCalls).toContainEqual(['quarantined', true])
    // A clear is a state transition → audited.
    expect(handle.auditInserts).toHaveLength(1)
    expect(handle.auditInserts[0].event_type).toBe('quarantine:cleared')
  })
})

// ---------------------------------------------------------------------------
// SMI-5377 retro: the run-level `requarantined` counter aggregation (the switch
// case + assembly into RecheckAuditCounters) was unit-tested only at processRow
// level by the sibling requarantine test — never end-to-end through runRecheck.
// A typo (`keptSecurity++` under `case 'requarantined'`) would compile, pass all
// other tests, and silently undercount re-quarantines in the audit metadata —
// the same invisible-success class SMI-5377 fixed. This pins the run-level path.

describe('runRecheck — re-quarantine (clean LIVE row turned malicious, SMI-5377)', () => {
  beforeEach(() => {
    writeIndexerAuditLog.mockClear()
    delete process.env.RECHECK_ENABLED
  })
  afterEach(() => vi.restoreAllMocks())

  it('counts requarantined (not kept_security/live_touched) and audits quarantine:requarantined', async () => {
    stubFetchMaliciousAlways()
    // A LIVE (quarantined=false) row enters via the pass-1 prevention cohort;
    // its upstream content has turned malicious.
    const row = makeRow({ id: 'req-1', quarantined: false, quarantine_reason: null })
    const handle = makeRunDb({
      pass1: [row],
      pass2: [],
      casReturns: [{ id: row.id }],
      casError: null,
    })

    const result = await runRecheck({ supabase: handle.db, ...BASE_OPTS })

    // The run-level aggregation increments requarantined, NOT kept_security/live_touched.
    expect(result.recheck.requarantined).toBe(1)
    expect(result.recheck.kept_security).toBe(0)
    expect(result.recheck.live_touched).toBe(0)
    // The re-quarantine payload flips quarantined=true with a reason.
    expect(handle.updatePayloads).toHaveLength(1)
    expect(handle.updatePayloads[0].quarantined).toBe(true)
    expect(handle.updatePayloads[0].quarantine_reason).toBeTruthy()
    // A live→malicious transition is the distinct requarantined audit event.
    expect(handle.auditInserts).toHaveLength(1)
    expect(handle.auditInserts[0].event_type).toBe('quarantine:requarantined')
  })
})

// ---------------------------------------------------------------------------
// TASK 1.5 — E3 throttle: fetch error rate > 0.1 → audited 'partial'
// ---------------------------------------------------------------------------

describe('runRecheck — E3 throttle (prevention outage)', () => {
  beforeEach(() => {
    writeIndexerAuditLog.mockClear()
    delete process.env.RECHECK_ENABLED
  })
  afterEach(() => vi.restoreAllMocks())

  it('audits eventResult=partial with fetch_error_rate > 0.1 and warns', async () => {
    // All transient → fetch_error_rate = 1.0 (> 0.1). 403 retries take a moment;
    // keep the candidate set small to stay within the test timeout.
    stubFetchTransientAlways(403)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const rows = Array.from({ length: 3 }, (_, i) => makeRow({ id: `t-${i}`, quarantined: false }))
    const handle = makeRunDb({ pass1: rows, pass2: [], casReturns: [], casError: null })

    const result = await runRecheck({ supabase: handle.db, ...BASE_OPTS, batch: 3 })

    expect(result.recheck.fetch_error).toBe(3)
    expect(result.recheck.fetch_error_rate).toBeGreaterThan(0.1)
    // Exactly one audit row, written 'partial'.
    expect(writeIndexerAuditLog).toHaveBeenCalledTimes(1)
    const [, eventResult, params] = writeIndexerAuditLog.mock.calls[0] as [
      unknown,
      string,
      { recheck: { fetch_error_rate: number } },
    ]
    expect(eventResult).toBe('partial')
    expect(params.recheck.fetch_error_rate).toBeGreaterThan(0.1)
    // The throttle warning fired.
    expect(warnSpy).toHaveBeenCalled()
  }, 30000)
})

// ---------------------------------------------------------------------------
// TASK 1.6 — E7 clamps
// ---------------------------------------------------------------------------

describe('runRecheck — input clamps (E7)', () => {
  beforeEach(() => {
    writeIndexerAuditLog.mockClear()
    delete process.env.RECHECK_ENABLED
  })
  afterEach(() => vi.restoreAllMocks())

  it('clamps thresholdDays 9->6, batch 99->10, cap 99999->5000 and warns on each', async () => {
    stubFetchCleanAlways()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // A single clean live row so the run completes quickly; the clamp warnings
    // and the cutoff derived from the clamped threshold are what we assert.
    const row = makeRow({ id: 'clamp-1', quarantined: false })
    const handle = makeRunDb({
      pass1: [row],
      pass2: [],
      casReturns: [{ id: row.id }],
      casError: null,
    })

    const before = Date.now()
    await runRecheck({
      supabase: handle.db,
      requestId: 'req-clamp',
      apply: true,
      thresholdDays: 9,
      batch: 99,
      cap: 99999,
    })
    const after = Date.now()

    // Three clamp warnings (threshold, cap, batch).
    const clampWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes('clamped'))
    expect(clampWarns.length).toBe(3)
    expect(clampWarns.some((c) => /thresholdDays clamped 9 -> 6/.test(String(c[0])))).toBe(true)
    expect(clampWarns.some((c) => /cap clamped 99999 -> 5000/.test(String(c[0])))).toBe(true)
    expect(clampWarns.some((c) => /batch clamped 99 -> 10/.test(String(c[0])))).toBe(true)

    // The cutoff used reflects the CLAMPED thresholdDays (6), not the raw 9.
    // Both passes (pass-1 returned 1 row < cap, so pass-2 also ran) share one
    // cutoff derived from the clamped threshold — assert it on every lt call.
    expect(handle.ltCalls.length).toBeGreaterThanOrEqual(1)
    const sixDaysMs = 6 * 86_400_000
    for (const [, val] of handle.ltCalls) {
      const cutoffMs = new Date(val as string).getTime()
      expect(cutoffMs).toBeGreaterThanOrEqual(before - sixDaysMs - 5_000)
      expect(cutoffMs).toBeLessThanOrEqual(after - sixDaysMs + 5_000)
    }
  })
})

// ---------------------------------------------------------------------------
// TASK 1.7 — P3 killswitch
// ---------------------------------------------------------------------------

describe('runRecheck — killswitch (P3)', () => {
  let prevEnabled: string | undefined
  beforeEach(() => {
    writeIndexerAuditLog.mockClear()
    prevEnabled = process.env.RECHECK_ENABLED
  })
  afterEach(() => {
    if (prevEnabled === undefined) delete process.env.RECHECK_ENABLED
    else process.env.RECHECK_ENABLED = prevEnabled
    vi.restoreAllMocks()
  })

  it('writes one audit row with killswitch_engaged=true, loads no candidates, returns skipped', async () => {
    process.env.RECHECK_ENABLED = 'false'
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const handle = makeRunDb({ pass1: [makeRow()], pass2: [], casReturns: [], casError: null })

    const result = await runRecheck({ supabase: handle.db, ...BASE_OPTS })

    expect(result.skipped).toBe(true)
    expect(result.recheck.killswitch_engaged).toBe(true)
    expect(result.recheck.candidate_count).toBe(0)
    // No candidate load → no PostgREST range query was issued (no order/lt calls).
    expect(handle.ltCalls).toHaveLength(0)
    expect(handle.orderCalls).toHaveLength(0)
    // No GitHub fetch and no skills write.
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(handle.updatePayloads).toHaveLength(0)
    // Exactly one audit row, killswitch_engaged true.
    expect(writeIndexerAuditLog).toHaveBeenCalledTimes(1)
    const [, , params] = writeIndexerAuditLog.mock.calls[0] as [
      unknown,
      string,
      { recheck: { killswitch_engaged: boolean }; runType: string },
    ]
    expect(params.recheck.killswitch_engaged).toBe(true)
    expect(params.runType).toBe('recheck')
  })
})

// ---------------------------------------------------------------------------
// TASK 1.8 — audit shape (exactly one indexer:run recheck row)
// ---------------------------------------------------------------------------

describe('runRecheck — audit shape', () => {
  beforeEach(() => {
    writeIndexerAuditLog.mockClear()
    delete process.env.RECHECK_ENABLED
  })
  afterEach(() => vi.restoreAllMocks())

  it('writes exactly one recheck audit row with run_type recheck and populated counters', async () => {
    stubFetchCleanAlways()
    const live = makeRow({ id: 'a-live', quarantined: false })
    const heal = makeRow({ id: 'a-heal', quarantined: true, quarantine_reason: 'stale' })
    const handle = makeRunDb({
      pass1: [live],
      pass2: [heal],
      casReturns: [{ id: 'cas' }],
      casError: null,
    })

    const result = await runRecheck({ supabase: handle.db, ...BASE_OPTS })

    // Exactly one audit row.
    expect(writeIndexerAuditLog).toHaveBeenCalledTimes(1)
    const [, eventResult, params] = writeIndexerAuditLog.mock.calls[0] as [
      unknown,
      string,
      {
        runType: string
        recheck: { candidate_count: number; live_touched: number; cleared: number }
        meta: { run_type: string }
      },
    ]
    expect(eventResult).toBe('success')
    // run_type 'recheck' on both the typed param and the nested meta envelope.
    expect(params.runType).toBe('recheck')
    expect(params.meta.run_type).toBe('recheck')
    // Populated counters object reflecting both cohorts.
    expect(params.recheck.candidate_count).toBe(2)
    expect(params.recheck.live_touched).toBe(1)
    expect(params.recheck.cleared).toBe(1)
    // Result payload mirrors the counters and is not skipped.
    expect(result.skipped).toBe(false)
    expect(result.recheck.candidate_count).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// SMI-5437 Wave 2 — sibling re-scan outcomes through runRecheck
// ---------------------------------------------------------------------------

describe('runRecheck — SMI-5437 sibling re-scan: quarantined row with malicious sibling', () => {
  beforeEach(() => {
    writeIndexerAuditLog.mockClear()
    delete process.env.RECHECK_ENABLED
  })
  afterEach(() => vi.restoreAllMocks())

  it('increments both requarantined AND sibling_requarantined; writes sibling requarantine audit', async () => {
    // SKILL.md is clean; sibling (package.json etc.) is malicious.
    stubFetchCleanSkillMdMaliciousSiblings()
    const row = makeRow({ id: 'sib-req-1', quarantined: true, quarantine_reason: 'stale' })
    const handle = makeRunDb({
      pass1: [],
      pass2: [row],
      casReturns: [{ id: row.id }],
      casError: null,
    })

    const result = await runRecheck({ supabase: handle.db, ...BASE_OPTS })

    // Additive: both requarantined and sibling_requarantined increment.
    expect(result.recheck.requarantined).toBe(1)
    expect(result.recheck.sibling_requarantined).toBe(1)
    expect(result.recheck.cleared).toBe(0)
    expect(result.recheck.sibling_recovered).toBe(0)
    // Sibling requarantine is audited with 'quarantine:requarantined' event.
    const sibAudit = handle.auditInserts.find(
      (a) => (a as { event_type: string }).event_type === 'quarantine:requarantined'
    )
    expect(sibAudit).toBeDefined()
    expect((sibAudit as { metadata: { sweep: string } }).metadata.sweep).toBe('recheck-sibling')
  })
})

describe('runRecheck — SMI-5437 sibling re-scan: quarantined row with clean sibling', () => {
  beforeEach(() => {
    writeIndexerAuditLog.mockClear()
    delete process.env.RECHECK_ENABLED
  })
  afterEach(() => vi.restoreAllMocks())

  it('increments both cleared AND sibling_recovered; writes quarantine:cleared audit', async () => {
    // SKILL.md clean; siblings clean → skill is unquarantined.
    stubFetchCleanAlways()
    const row = makeRow({ id: 'sib-rec-1', quarantined: true, quarantine_reason: 'stale' })
    const handle = makeRunDb({
      pass1: [],
      pass2: [row],
      casReturns: [{ id: row.id }],
      casError: null,
    })

    const result = await runRecheck({ supabase: handle.db, ...BASE_OPTS })

    // Additive: both cleared and sibling_recovered increment.
    expect(result.recheck.cleared).toBe(1)
    expect(result.recheck.sibling_recovered).toBe(1)
    expect(result.recheck.requarantined).toBe(0)
    expect(result.recheck.sibling_requarantined).toBe(0)
    // The clear write sets quarantined=false with the SMI-5437 audit sweep tag.
    expect(handle.auditInserts).toHaveLength(1)
    expect(handle.auditInserts[0].event_type).toBe('quarantine:cleared')
    expect((handle.auditInserts[0] as { metadata: { sweep: string } }).metadata.sweep).toBe(
      'recheck-sibling'
    )
  })
})

describe('runRecheck — SMI-5437 sibling re-scan: transient sibling fetch → stay quarantined (fail-closed)', () => {
  beforeEach(() => {
    writeIndexerAuditLog.mockClear()
    delete process.env.RECHECK_ENABLED
  })
  afterEach(() => vi.restoreAllMocks())

  it('increments fetch_error; does NOT write a skills update (quarantine unchanged)', async () => {
    // SKILL.md clean, but sibling fetch is 403 transient → runSiblingRescan returns 'unknown'.
    stubFetchCleanSkillMdTransientSiblings(403)
    const row = makeRow({ id: 'sib-trans-1', quarantined: true, quarantine_reason: 'stale' })
    const handle = makeRunDb({
      pass1: [],
      pass2: [row],
      casReturns: [],
      casError: null,
    })

    const result = await runRecheck({ supabase: handle.db, ...BASE_OPTS })

    // Transient sibling fetch → fetch-error outcome, no DB change.
    expect(result.recheck.fetch_error).toBe(1)
    expect(result.recheck.cleared).toBe(0)
    expect(result.recheck.sibling_recovered).toBe(0)
    expect(result.recheck.sibling_requarantined).toBe(0)
    // CRITICAL: no skills UPDATE must have been issued (quarantine column unchanged).
    expect(handle.updatePayloads).toHaveLength(0)
    expect(handle.auditInserts).toHaveLength(0)
  })
})

describe('runRecheck — SMI-5437 sibling re-scan: live rows (quarantined=false) skip sibling rescan', () => {
  beforeEach(() => {
    writeIndexerAuditLog.mockClear()
    delete process.env.RECHECK_ENABLED
  })
  afterEach(() => vi.restoreAllMocks())

  it('live row with malicious sibling still gets live-touched (sibling rescan is quarantine-review-only)', async () => {
    // Per plan step 4: quarantined===false rows exit at the CAS touch, before sibling rescan.
    // A malicious sibling stub should NOT trigger sibling_requarantined on a live row.
    stubFetchCleanSkillMdMaliciousSiblings()
    const row = makeRow({ id: 'live-sib-1', quarantined: false })
    const handle = makeRunDb({
      pass1: [row],
      pass2: [],
      casReturns: [{ id: row.id }],
      casError: null,
    })

    const result = await runRecheck({ supabase: handle.db, ...BASE_OPTS })

    // Live row: exits at the CAS touch — sibling rescan never runs.
    expect(result.recheck.live_touched).toBe(1)
    expect(result.recheck.sibling_requarantined).toBe(0)
    expect(result.recheck.sibling_recovered).toBe(0)
    // Only one write: the last_seen_at CAS touch.
    expect(handle.updatePayloads).toHaveLength(1)
    expect(Object.keys(handle.updatePayloads[0])).toEqual(['last_seen_at'])
  })
})

describe('runRecheck — SMI-5437 sibling re-scan: SKILL.md malicious → sibling rescan not invoked', () => {
  beforeEach(() => {
    writeIndexerAuditLog.mockClear()
    delete process.env.RECHECK_ENABLED
  })
  afterEach(() => vi.restoreAllMocks())

  it('quarantined=true row with malicious SKILL.md counts kept_security without invoking sibling scan', async () => {
    // SKILL.md is malicious → shouldQuarantine(scan) = true → processRow returns 'kept-security'
    // before reaching the sibling rescan block. Sibling fetch should never be called.
    stubFetchMaliciousSkillMdCleanSiblings()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const row = makeRow({ id: 'kept-1', quarantined: true, quarantine_reason: 'security scan' })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const handle = makeRunDb({
      pass1: [],
      pass2: [row],
      casReturns: [{ id: row.id }],
      casError: null,
    })

    const result = await runRecheck({ supabase: handle.db, ...BASE_OPTS })

    expect(result.recheck.kept_security).toBe(1)
    expect(result.recheck.sibling_requarantined).toBe(0)
    expect(result.recheck.sibling_recovered).toBe(0)
    // Only the SKILL.md fetch (api.github.com) should have fired; NO raw.githubusercontent.com.
    const rawCalls = fetchSpy.mock.calls.filter((c) => isRawGithubUrl(c[0]))
    expect(rawCalls).toHaveLength(0)
    warnSpy.mockRestore()
  })
})
