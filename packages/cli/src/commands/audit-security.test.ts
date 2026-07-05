/**
 * @fileoverview Tests for `sklx audit security` presentation (SMI-5541 Wave 2C).
 * @module @skillsmith/cli/commands/audit-security.test
 *
 * The audit engine itself is unit-tested in
 * `packages/mcp-server/src/audit/security-audit.test.ts`. Here we mock
 * `runSecurityAudit` and cover the CLI surface: the empty-vs-findings render,
 * the strongest-first ordering, and the `--json` passthrough.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => {
  class AuditNotifyAuthError extends Error {
    constructor(message?: string) {
      super(message)
      this.name = 'AuditNotifyAuthError'
    }
  }
  return {
    runSecurityAudit: vi.fn(),
    buildAuditDigestPayload: vi.fn(() => ({
      scanned: 1,
      hostile: 1,
      malicious: 0,
      suspicious: 0,
      findings: [{ identifier: 'x', kind: 'skill', verdict: 'hostile', reason: 'r' }],
    })),
    hashDigest: vi.fn(() => 'hash-xyz'),
    sendAuditDigest: vi.fn(),
    recordAuditNotify: vi.fn(),
    AuditNotifyAuthError,
  }
})
vi.mock('@skillsmith/mcp-server/audit', () => ({
  runSecurityAudit: mocks.runSecurityAudit,
  buildAuditDigestPayload: mocks.buildAuditDigestPayload,
  hashDigest: mocks.hashDigest,
}))
vi.mock('@skillsmith/core', () => ({
  sendAuditDigest: mocks.sendAuditDigest,
  recordAuditNotify: mocks.recordAuditNotify,
  AuditNotifyAuthError: mocks.AuditNotifyAuthError,
}))

import type {
  RunSecurityAuditResult,
  SecurityAuditFinding,
  SecurityVerdict,
} from '@skillsmith/mcp-server/audit'

import {
  printFindings,
  printEmailOutcome,
  pushDigest,
  runAuditSecurity,
  type EmailOutcome,
} from './audit-security.js'

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

let logSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  mocks.runSecurityAudit.mockReset()
  mocks.sendAuditDigest.mockReset()
  mocks.buildAuditDigestPayload.mockClear()
  mocks.hashDigest.mockClear()
  mocks.recordAuditNotify.mockReset()
})
afterEach(() => {
  logSpy.mockRestore()
})

const output = (): string => logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n')

describe('printFindings', () => {
  it('reports a clean bill of health when there are no findings', () => {
    printFindings(result([], { scanned: 3 }))
    expect(output()).toContain('No security issues found in 3')
  })

  it('warns when some skills could not be scanned (incomplete coverage)', () => {
    printFindings(result([], { scanned: 2, unreadable: 1 }))
    const out = output()
    expect(out).toContain('could not be scanned')
    expect(out).toContain('1')
  })

  it('lists findings strongest-first (hostile before suspicious)', () => {
    printFindings(result([finding('suspicious', 'a'), finding('hostile', 'b')]))
    const out = output()
    expect(out).toContain('RUG-PULL')
    expect(out).toContain('SUSPECT')
    // hostile (RUG-PULL) must be listed before suspicious (SUSPECT).
    expect(out.indexOf('RUG-PULL')).toBeLessThan(out.indexOf('SUSPECT'))
  })

  it('surfaces a currently-failing skill as FAILING', () => {
    printFindings(result([finding('malicious', 'evil')]))
    expect(output()).toContain('FAILING')
  })
})

describe('runAuditSecurity', () => {
  it('--json prints the raw result and skips the formatted view', async () => {
    mocks.runSecurityAudit.mockResolvedValue(result([]))
    await runAuditSecurity({ json: true, email: false })
    const out = output()
    expect(out).toContain('"auditId"')
    expect(out).not.toContain('No security issues found')
  })

  it('default mode runs the audit and prints the formatted findings', async () => {
    mocks.runSecurityAudit.mockResolvedValue(result([]))
    await runAuditSecurity({ json: false, email: false })
    expect(mocks.runSecurityAudit).toHaveBeenCalledTimes(1)
    expect(output()).toContain('No security issues found')
  })

  it('without --email it never pushes a digest', async () => {
    mocks.runSecurityAudit.mockResolvedValue(result([finding('hostile', 'a')]))
    await runAuditSecurity({ json: false, email: false })
    expect(mocks.sendAuditDigest).not.toHaveBeenCalled()
  })

  it('--email with findings pushes the digest and reports success', async () => {
    mocks.runSecurityAudit.mockResolvedValue(result([finding('hostile', 'a')]))
    mocks.sendAuditDigest.mockResolvedValue({ ok: true, sent: true })
    await runAuditSecurity({ json: false, email: true })
    expect(mocks.sendAuditDigest).toHaveBeenCalledOnce()
    expect(output()).toContain('Emailed your security digest')
  })

  it('--email --json embeds the push outcome under `email`', async () => {
    mocks.runSecurityAudit.mockResolvedValue(result([finding('hostile', 'a')]))
    mocks.sendAuditDigest.mockResolvedValue({ ok: true, sent: true })
    await runAuditSecurity({ json: true, email: true })
    const out = output()
    expect(out).toContain('"email"')
    expect(out).toContain('"sent": true')
  })
})

describe('pushDigest', () => {
  it('short-circuits with nothing_to_report when there are no findings (no network)', async () => {
    const outcome = await pushDigest(result([]))
    expect(outcome).toEqual({ ok: true, sent: false, reason: 'nothing_to_report' })
    expect(mocks.sendAuditDigest).not.toHaveBeenCalled()
    expect(mocks.buildAuditDigestPayload).not.toHaveBeenCalled()
    // Records a clean state so the background auto-run also treats it as "nothing new".
    expect(mocks.recordAuditNotify).toHaveBeenCalledOnce()
  })

  it('maps a successful send AND records shared state (cross-channel dedup)', async () => {
    mocks.sendAuditDigest.mockResolvedValue({ ok: true, sent: true })
    const outcome = await pushDigest(result([finding('hostile', 'a')]))
    expect(outcome).toEqual({ ok: true, sent: true })
    expect(mocks.recordAuditNotify).toHaveBeenCalledWith(expect.any(String), 'hash-xyz')
  })

  it('passes a server reason (not_consented) through and does NOT record state', async () => {
    mocks.sendAuditDigest.mockResolvedValue({ ok: false, sent: false, reason: 'not_consented' })
    const outcome = await pushDigest(result([finding('hostile', 'a')]))
    expect(outcome).toEqual({ ok: false, sent: false, reason: 'not_consented' })
    expect(mocks.recordAuditNotify).not.toHaveBeenCalled()
  })

  it('captures an auth failure as not_authenticated (never throws, no state write)', async () => {
    mocks.sendAuditDigest.mockRejectedValue(new mocks.AuditNotifyAuthError('nope'))
    const outcome = await pushDigest(result([finding('hostile', 'a')]))
    expect(outcome).toEqual({ ok: false, sent: false, error: 'not_authenticated' })
    expect(mocks.recordAuditNotify).not.toHaveBeenCalled()
  })

  it('captures a transport failure message (never throws)', async () => {
    mocks.sendAuditDigest.mockRejectedValue(new Error('ECONNRESET'))
    const outcome = await pushDigest(result([finding('hostile', 'a')]))
    expect(outcome).toEqual({ ok: false, sent: false, error: 'ECONNRESET' })
    expect(mocks.recordAuditNotify).not.toHaveBeenCalled()
  })
})

describe('printEmailOutcome', () => {
  const cases: Array<[EmailOutcome, string]> = [
    [{ ok: true, sent: true }, 'Emailed your security digest'],
    [{ ok: false, sent: false, error: 'not_authenticated' }, 'skillsmith login'],
    [{ ok: false, sent: false, error: 'ECONNRESET' }, 'Email failed'],
    [{ ok: true, sent: false, reason: 'nothing_to_report' }, 'No issues to email'],
    [{ ok: false, sent: false, reason: 'not_consented' }, 'Audit emails are off'],
    [{ ok: false, sent: false, reason: 'email_not_verified' }, 'Verify your email'],
    [{ ok: false, sent: false, reason: 'no_email' }, 'No email address'],
    [{ ok: false, sent: false, reason: 'email_send_failed' }, 'could not send'],
  ]
  it.each(cases)('renders %o', (outcome, expected) => {
    printEmailOutcome(outcome)
    expect(output()).toContain(expected)
  })
})
