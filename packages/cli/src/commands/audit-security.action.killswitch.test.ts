/**
 * @fileoverview H-18 kill-switch tests, split out of audit-security.action.test.ts
 *               to keep that file under the 500-line gate (SMI-5901).
 * @module @skillsmith/cli/commands/audit-security.action.killswitch.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ScanReport, SecurityFinding } from '@skillsmith/core'
import type { InventoryEntry } from '@skillsmith/mcp-server/audit'

import { runAuditSecurity } from './audit-security.action.js'
import type { AuditSecurityCliSeams, AuditSecurityOptions } from './audit-security.types.js'

let tmpDir: string
let baselinePath: string
let acceptancePath: string
let logSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-audit-security-killswitch-'))
  baselinePath = path.join(tmpDir, 'security-baseline.json')
  acceptancePath = path.join(tmpDir, 'security-acceptance.json')
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
})
afterEach(() => {
  logSpy.mockRestore()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const output = (): string => logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n')
const jsonOutput = (): unknown => {
  const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1]
  return JSON.parse(String(lastCall?.[0]))
}

const ZERO_BREAKDOWN: ScanReport['riskBreakdown'] = {
  jailbreak: 0,
  socialEngineering: 0,
  promptLeaking: 0,
  dataExfiltration: 0,
  privilegeEscalation: 0,
  suspiciousCode: 0,
  sensitivePaths: 0,
  externalUrls: 0,
  aiDefence: 0,
  ssrf: 0,
  pii: 0,
  codeExecution: 0,
  obfuscatedDirective: 0,
  typosquat: 0,
  gatekeeperBypass: 0,
  archiveEvasion: 0,
  pasteHostFetch: 0,
  encodedPayload: 0,
  decoyMisdirection: 0,
}

function report(
  skillId: string,
  opts: { passed: boolean; riskScore: number; findings?: SecurityFinding[] }
): ScanReport {
  return {
    skillId,
    passed: opts.passed,
    riskScore: opts.riskScore,
    findings: opts.findings ?? [],
    riskBreakdown: { ...ZERO_BREAKDOWN },
    scannedAt: new Date('2026-07-04T00:00:00.000Z'),
    scanDurationMs: 1,
  }
}

function baseOpts(extra: Partial<AuditSecurityOptions & AuditSecurityCliSeams> = {}) {
  return {
    json: false,
    email: false,
    baselinePath,
    acceptancePath,
    ...extra,
  } as AuditSecurityOptions & AuditSecurityCliSeams
}

describe('H-18: SKILLSMITH_AUDIT_ACCEPT_DISABLE=1 kill switch', () => {
  it('bypasses the store entirely -- output matches the empty-store baseline, store mtime unchanged', async () => {
    const entry: InventoryEntry = {
      kind: 'skill',
      identifier: 'S',
      source_path: '/skills/S/SKILL.md',
      triggerSurface: [],
    }
    const finding: SecurityFinding = {
      type: 'jailbreak',
      severity: 'critical',
      message: 'flagged pattern',
    }

    // Populate the store with a real acceptance for this exact finding.
    await runAuditSecurity(
      baseOpts({
        json: true,
        inventory: [entry],
        readContent: () => 'bad-content',
        scan: () => report('S', { passed: false, riskScore: 80, findings: [finding] }),
      })
    )
    const captured = jsonOutput() as { candidates: Array<{ acceptKey: string }> }
    logSpy.mockClear()
    await runAuditSecurity(
      baseOpts({
        json: true,
        accept: captured.candidates[0]?.acceptKey,
        reason: 'reviewed',
        inventory: [entry],
        readContent: () => 'bad-content',
        scan: () => report('S', { passed: false, riskScore: 80, findings: [finding] }),
      })
    )
    const mtimeBefore = fs.statSync(acceptancePath).mtimeMs

    logSpy.mockClear()
    process.env['SKILLSMITH_AUDIT_ACCEPT_DISABLE'] = '1'
    try {
      await runAuditSecurity(
        baseOpts({
          json: true,
          inventory: [entry],
          readContent: () => 'bad-content',
          scan: () => report('S', { passed: false, riskScore: 80, findings: [finding] }),
        })
      )
    } finally {
      delete process.env['SKILLSMITH_AUDIT_ACCEPT_DISABLE']
    }

    const disabledResult = jsonOutput() as {
      findings: Array<{ accepted?: unknown }>
      acceptances: unknown[]
    }
    expect(disabledResult.findings[0]?.accepted).toBeUndefined() // no suppression despite a populated store
    expect(disabledResult.acceptances).toEqual([])
    expect(fs.statSync(acceptancePath).mtimeMs).toBe(mtimeBefore) // never touched
  })

  it('post-merge retro: --accept/--revoke are rejected outright (not silently written) while the kill switch is set', async () => {
    // Round 1 shipped: the kill switch's own doc comment claims "no store
    // write," but --accept/--revoke previously wrote a real (if dormant)
    // record anyway, printing a false "OK Accepted" success message.
    const entry: InventoryEntry = {
      kind: 'skill',
      identifier: 'S',
      source_path: '/skills/S/SKILL.md',
      triggerSurface: [],
    }
    const finding: SecurityFinding = {
      type: 'jailbreak',
      severity: 'critical',
      message: 'flagged pattern',
    }
    const scanOpts = {
      json: true,
      inventory: [entry],
      readContent: () => 'bad-content',
      scan: () => report('S', { passed: false, riskScore: 80, findings: [finding] }),
    }
    await runAuditSecurity(baseOpts(scanOpts))
    const beforeResult = jsonOutput() as { candidates: Array<{ acceptKey: string }> }
    const acceptKey = beforeResult.candidates[0]?.acceptKey as string
    expect(fs.existsSync(acceptancePath)).toBe(false) // no store yet -- nothing to compare mtime against

    logSpy.mockClear()
    process.env['SKILLSMITH_AUDIT_ACCEPT_DISABLE'] = '1'
    try {
      const exitCodeBefore = process.exitCode
      process.exitCode = undefined
      await runAuditSecurity(baseOpts({ ...scanOpts, accept: acceptKey, reason: 'reviewed' }))
      expect(process.exitCode).toBe(1)
      expect(output()).toContain('accept_disabled')
      expect(fs.existsSync(acceptancePath)).toBe(false) // still never created

      logSpy.mockClear()
      process.exitCode = undefined
      await runAuditSecurity(baseOpts({ ...scanOpts, revoke: 'a'.repeat(64) }))
      expect(process.exitCode).toBe(1)
      expect(output()).toContain('accept_disabled')
      process.exitCode = exitCodeBefore
    } finally {
      delete process.env['SKILLSMITH_AUDIT_ACCEPT_DISABLE']
    }
  })
})
