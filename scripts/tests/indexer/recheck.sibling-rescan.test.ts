/**
 * SMI-5437/SMI-5445: Unit tests for recheck's sibling re-scan outcomes.
 *
 * Split from recheck.test.ts (SMI-5849) to keep both files under the
 * repo's 500-line CI gate — this file is the sibling-rescan-specific half;
 * recheck.test.ts keeps the base prevention/self-heal/throttle/audit-shape
 * contract tests. Same mock doubles and setup as recheck.test.ts (see that
 * file's header for the full safety-contract description).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runRecheck, loadRecheckCandidates } from '../../indexer/recheck.ts'
import {
  makeRow,
  makeLoadDb,
  makeRunDb,
  stubFetchCleanAlways,
  stubFetchMaliciousSkillMdCleanSiblings,
  stubFetchCleanSkillMdMaliciousSiblings,
  stubFetchCleanSkillMdTransientSiblings,
  isRawGithubUrl,
  BASE_OPTS,
  CLEAN_CONTENT,
} from './recheck.test-helpers.ts'
import {
  generateContentHash,
  scanSkillContent,
  MAX_MULTILINE_ITERATIONS_PER_PATTERN,
  type EdgeScanResult,
} from '../../indexer/_shared/security-scanner-edge.ts'
import { newRateLimitTelemetry } from '../../indexer/_shared/rate-limit.ts'
import { runSiblingRescan } from '../../indexer/revalidate-stale-quarantines.sibling.ts'

// writeIndexerAuditLog is mocked so we can assert the audit row shape directly
// (eventResult + the recheck counters object + run_type) without a DB double.
const writeIndexerAuditLog = vi.fn(async () => undefined)
vi.mock('../../indexer/indexer-audit-log.ts', () => ({
  writeIndexerAuditLog: (...args: unknown[]) => writeIndexerAuditLog(...args),
}))

// ---------------------------------------------------------------------------
// SMI-6020 (design §2.7 T2.19-T2.20): runSiblingRescan truncation fail-closed
// ---------------------------------------------------------------------------

describe('runSiblingRescan — SMI-6020 truncation fail-closed', () => {
  afterEach(() => vi.restoreAllMocks())

  // T2.19
  it('returns unknown (not malicious, not clean) when the root scan truncated, and never fetches siblings', async () => {
    const truncatedRoot: EdgeScanResult = {
      passed: true,
      riskScore: 0,
      findings: [],
      contentHash: '0'.repeat(64),
      scannedAt: '2026-08-11T00:00:00.000Z',
      scanDurationMs: 0,
      multilineTruncated: true,
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await runSiblingRescan(
      'acme',
      'my-skill',
      'main',
      '',
      newRateLimitTelemetry(),
      truncatedRoot
    )

    expect(result).toEqual({ status: 'unknown', scanIncomplete: true })
    // Budget guard: the CDN fetch loop must never start when the root itself truncated.
    expect(fetchSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  // T2.20
  it('returns unknown when a sibling scan truncated and nothing is rejectable', async () => {
    // 'dev mode override ' repeated matches the same content-scope
    // JB_JS3A_DEV_MODE_THEN_CAPABILITY pattern as scan-skill-bundle.test.ts's
    // T2.11 (via CAPABILITY_SRC's bare `override` alternative — shorter than
    // T2.11's phrase so 11,000 reps stays under MAX_SIBLING_CONTENT_BYTES,
    // unlike a sibling fetch — which the primary-content path is not bound
    // by). No code_execution/obfuscated_directive findings, so
    // siblingRejectable stays false and the loop runs to completion.
    const truncatingContent = 'dev mode override '.repeat(
      MAX_MULTILINE_ITERATIONS_PER_PATTERN + 1000
    )
    const cleanRoot = await scanSkillContent(CLEAN_CONTENT)

    vi.spyOn(globalThis, 'fetch').mockImplementation((url: unknown) => {
      const urlStr = String(url)
      if (urlStr.endsWith('/.mcp.json')) {
        const bytes = new TextEncoder().encode(truncatingContent)
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => null },
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes)
              controller.close()
            },
          }),
        } as unknown as Response)
      }
      // Every other sibling target: confirmed absent (404).
      return Promise.resolve({ ok: false, status: 404, headers: { get: () => null } } as Response)
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await runSiblingRescan(
      'acme',
      'my-skill',
      'main',
      '',
      newRateLimitTelemetry(),
      cleanRoot
    )

    expect(result).toEqual({ status: 'unknown', scanIncomplete: true })
    warnSpy.mockRestore()
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
    // Only one write: the last_seen_at CAS touch (+ SMI-5849 content_hash backfill
    // + SMI-5866 security_score/last_scanned_at repair).
    expect(handle.updatePayloads).toHaveLength(1)
    expect(Object.keys(handle.updatePayloads[0]).sort()).toEqual(
      ['content_hash', 'last_scanned_at', 'last_seen_at', 'security_score'].sort()
    )
    expect(handle.updatePayloads[0].content_hash).toBe(await generateContentHash(CLEAN_CONTENT))
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

// ---------------------------------------------------------------------------
// SMI-5445 Wave 1 — C1: merged-score gate (score-triggered quarantines stay quarantined)
// ---------------------------------------------------------------------------

describe('runRecheck — SMI-5445 C1: sibling-triggered quarantine stays quarantined (code_exec gate)', () => {
  beforeEach(() => {
    writeIndexerAuditLog.mockClear()
    delete process.env.RECHECK_ENABLED
  })
  afterEach(() => vi.restoreAllMocks())

  it('PASS-3 row with malicious siblings (code_execution) stays quarantined (sibling_requarantined)', async () => {
    // SKILL.md is clean; siblings have code_execution (postinstall curl | bash).
    // The C1 merged-score gate confirms the sibling scan result stays as 'malicious'
    // and prevents the clear (sibling_recovered=0; sibling_requarantined=1).
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    stubFetchCleanSkillMdMaliciousSiblings()
    // A security-quarantined row from PASS 3 with a sibling-derived finding.
    const row = makeRow({
      id: 'c1-sib-block-1',
      quarantined: true,
      quarantine_reason: 'security: code_execution in package.json',
      security_findings: [{ type: 'code_execution', filePath: 'package.json' }],
    })
    const handle = makeRunDb({
      pass1: [],
      pass2: [],
      pass3: [row],
      casReturns: [{ id: row.id }],
      casError: null,
    })

    const result = await runRecheck({ supabase: handle.db, ...BASE_OPTS })

    // Row must NOT have been cleared.
    expect(result.recheck.sibling_recovered).toBe(0)
    expect(result.recheck.cleared).toBe(0)
    // sibling_requarantined = 1 shows the sibling rescan blocked the clear.
    expect(result.recheck.sibling_requarantined).toBe(1)
    // No quarantine-clear write should have been issued.
    const clearWrites = handle.updatePayloads.filter((p) => p.quarantined === false)
    expect(clearWrites).toHaveLength(0)
  })
})

describe('runRecheck — SMI-5445 C1: genuinely-clean sibling set IS cleared', () => {
  beforeEach(() => {
    writeIndexerAuditLog.mockClear()
    delete process.env.RECHECK_ENABLED
  })
  afterEach(() => vi.restoreAllMocks())

  it('row with all-clean siblings (riskScore < 40, no code_exec) IS cleared via sibling-recovered', async () => {
    stubFetchCleanAlways()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    // A security-quarantined row from PASS 3.
    const row = makeRow({
      id: 'c1-clean-1',
      quarantined: true,
      quarantine_reason: 'security: code_execution in .mcp.json',
      security_findings: [{ type: 'code_execution', filePath: '.mcp.json' }],
    })
    const handle = makeRunDb({
      pass1: [],
      pass2: [],
      pass3: [row],
      casReturns: [{ id: row.id }],
      casError: null,
    })

    const result = await runRecheck({ supabase: handle.db, ...BASE_OPTS })

    expect(result.recheck.sibling_recovered).toBe(1)
    expect(result.recheck.cleared).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// SMI-5445 C2: per-run sibling-clear cap + deferred-cap + spike alert
// ---------------------------------------------------------------------------

describe('runRecheck — SMI-5445 C2: per-run sibling-clear cap enforced', () => {
  const prevCap = process.env.RECHECK_MAX_SIBLING_CLEARS
  beforeEach(() => {
    writeIndexerAuditLog.mockClear()
    delete process.env.RECHECK_ENABLED
    // Set cap = 2 for the test.
    process.env.RECHECK_MAX_SIBLING_CLEARS = '2'
  })
  afterEach(() => {
    if (prevCap === undefined) delete process.env.RECHECK_MAX_SIBLING_CLEARS
    else process.env.RECHECK_MAX_SIBLING_CLEARS = prevCap
    vi.restoreAllMocks()
  })

  it('cap+1 recoverable PASS-3 rows → exactly cap cleared and 1 deferred-cap', async () => {
    // cap = 2; 3 recoverable rows → 2 cleared + 1 deferred.
    stubFetchCleanAlways()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const rows = Array.from({ length: 3 }, (_, i) =>
      makeRow({
        id: `cap-row-${i}`,
        quarantined: true,
        quarantine_reason: 'security: code_execution',
        security_findings: [{ type: 'code_execution', filePath: '.mcp.json' }],
      })
    )
    const handle = makeRunDb({
      pass1: [],
      pass2: [],
      pass3: rows,
      casReturns: [{ id: 'cas' }],
      casError: null,
    })

    const result = await runRecheck({ supabase: handle.db, ...BASE_OPTS, batch: 10 })

    // Exactly cap (2) cleared, 1 deferred.
    expect(result.recheck.sibling_recovered).toBe(2)
    expect(result.recheck.cleared).toBe(2)
    expect(result.recheck.deferred_cap).toBe(1)
    // SMI-5445 C2-medium: the (cap+1)th row must NOT have been written. Only the 2
    // cleared rows issue a skills UPDATE + a quarantine:cleared audit; the deferred
    // row issues neither, so its DB row stays quarantined=true and is retried next run.
    const clearWrites = handle.updatePayloads.filter((p) => p.quarantined === false)
    expect(clearWrites).toHaveLength(2)
    const clearAudits = handle.auditInserts.filter(
      (a) => (a as { event_type: string }).event_type === 'quarantine:cleared'
    )
    expect(clearAudits).toHaveLength(2)
    // No other skills UPDATE (no requarantine / touch) was issued for the deferred row.
    expect(handle.updatePayloads).toHaveLength(2)
  })

  it('emits a WARN spike alert when sibling_recovered exceeds half the cap threshold', async () => {
    // cap = 2; spike threshold = max(1, floor(2/2)) = 1. 2 recovered → spike fires.
    stubFetchCleanAlways()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const rows = Array.from({ length: 2 }, (_, i) =>
      makeRow({
        id: `spike-row-${i}`,
        quarantined: true,
        quarantine_reason: 'security: code_execution',
        security_findings: [{ type: 'code_execution', filePath: '.mcp.json' }],
      })
    )
    const handle = makeRunDb({
      pass1: [],
      pass2: [],
      pass3: rows,
      casReturns: [{ id: 'cas' }],
      casError: null,
    })

    await runRecheck({ supabase: handle.db, ...BASE_OPTS, batch: 10 })

    // Spike alert should have fired.
    const spikeWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes('SPIKE ALERT'))
    expect(spikeWarns.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// SMI-5445 PASS 3: RPC-loaded sibling rows + dedup vs PASS 2
// ---------------------------------------------------------------------------

describe('loadRecheckCandidates — SMI-5445 PASS 3: sibling-quarantined rows loaded via RPC', () => {
  afterEach(() => vi.restoreAllMocks())

  it('PASS-3 rows are included when cap remains after PASS 1+2', async () => {
    const pass1 = [makeRow({ id: 'p1-0', quarantined: false })]
    const pass2 = [makeRow({ id: 'p2-0', quarantined: true, quarantine_reason: 'stale' })]
    const pass3 = [
      makeRow({
        id: 'p3-0',
        quarantined: true,
        quarantine_reason: 'security: code_execution',
        security_findings: [{ type: 'code_execution', filePath: '.mcp.json' }],
      }),
    ]
    const handle = makeLoadDb(pass1, pass2, pass3)
    const rows = await loadRecheckCandidates(handle.db, { thresholdDays: 5, cap: 10 })

    expect(rows.map((r) => r.id)).toContain('p3-0')
    expect(rows).toHaveLength(3)
    // RPC should have been called for PASS 3.
    expect(handle.rpcCalls).toHaveLength(1)
    expect(handle.rpcCalls[0][0]).toBe('get_recheck_sibling_candidates')
  })

  it('PASS-3 row is deduped if it also appears in PASS 2 (id collision)', async () => {
    // A row with reason=null (PASS 2 match) AND filePath findings (PASS 3 match).
    const ambiguousRow = makeRow({
      id: 'dup-row',
      quarantined: true,
      quarantine_reason: null,
      security_findings: [{ type: 'code_execution', filePath: '.mcp.json' }],
    })
    const pass2 = [ambiguousRow]
    // PASS 3 RPC returns the same row.
    const pass3 = [ambiguousRow]
    const handle = makeLoadDb([], pass2, pass3)
    const rows = await loadRecheckCandidates(handle.db, { thresholdDays: 5, cap: 10 })

    // Should appear exactly once (PASS 2 wins, PASS 3 deduped).
    expect(rows.filter((r) => r.id === 'dup-row')).toHaveLength(1)
  })

  it('PASS 3 does NOT run when cap is exhausted by PASS 1+2', async () => {
    const pass1 = Array.from({ length: 3 }, (_, i) =>
      makeRow({ id: `p1-${i}`, quarantined: false })
    )
    const pass2 = Array.from({ length: 2 }, (_, i) =>
      makeRow({ id: `p2-${i}`, quarantined: true, quarantine_reason: 'stale' })
    )
    const pass3 = [
      makeRow({
        id: 'p3-0',
        quarantined: true,
        quarantine_reason: 'security: code_execution',
        security_findings: [{ type: 'code_execution', filePath: '.mcp.json' }],
      }),
    ]
    // cap = 5 = pass1.length + pass2.length → no remaining cap for PASS 3.
    const handle = makeLoadDb(pass1, pass2, pass3)
    const rows = await loadRecheckCandidates(handle.db, { thresholdDays: 5, cap: 5 })

    expect(rows).toHaveLength(5)
    expect(rows.every((r) => r.id.startsWith('p1-') || r.id.startsWith('p2-'))).toBe(true)
    expect(rows.find((r) => r.id === 'p3-0')).toBeUndefined()
    // RPC must NOT have been called.
    expect(handle.rpcCalls).toHaveLength(0)
  })
})
