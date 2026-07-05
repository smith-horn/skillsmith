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

const mocks = vi.hoisted(() => ({ runSecurityAudit: vi.fn() }))
vi.mock('@skillsmith/mcp-server/audit', () => ({ runSecurityAudit: mocks.runSecurityAudit }))

import type {
  RunSecurityAuditResult,
  SecurityAuditFinding,
  SecurityVerdict,
} from '@skillsmith/mcp-server/audit'

import { printFindings, runAuditSecurity } from './audit-security.js'

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
    await runAuditSecurity({ json: true })
    const out = output()
    expect(out).toContain('"auditId"')
    expect(out).not.toContain('No security issues found')
  })

  it('default mode runs the audit and prints the formatted findings', async () => {
    mocks.runSecurityAudit.mockResolvedValue(result([]))
    await runAuditSecurity({ json: false })
    expect(mocks.runSecurityAudit).toHaveBeenCalledTimes(1)
    expect(output()).toContain('No security issues found')
  })
})
