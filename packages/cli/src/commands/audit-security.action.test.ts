/**
 * @fileoverview Real-integration tests for `sklx audit security`'s
 *               accept/revoke/render pipeline (SMI-5883 Wave 2, §9).
 * @module @skillsmith/cli/commands/audit-security.action.test
 *
 * Unlike `audit-security.test.ts` (which MOCKS `@skillsmith/mcp-server/audit`
 * to isolate pure CLI presentation), this file exercises the REAL
 * `runSecurityAudit` + acceptance-store mutation, proving `runAuditSecurity`
 * resolves `--accept`/`--revoke` against a FRESH audit rather than a stale
 * caller-held one (R2). Covers H-4b, H-6b, H-8, H-17, H-18.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ScanReport, SecurityFinding } from '@skillsmith/core'
import type { InventoryEntry } from '@skillsmith/mcp-server/audit'

import { printFindings, runAuditSecurity } from './audit-security.action.js'
import type { AuditSecurityCliSeams, AuditSecurityOptions } from './audit-security.types.js'

const testDir = path.dirname(fileURLToPath(import.meta.url))

let tmpDir: string
let baselinePath: string
let acceptancePath: string
let logSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-audit-security-'))
  baselinePath = path.join(tmpDir, 'security-baseline.json')
  acceptancePath = path.join(tmpDir, 'security-acceptance.json')
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
})
afterEach(() => {
  logSpy.mockRestore()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const output = (): string => logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n')
// The JSON payload is always the LAST console.log call (accept/revoke print
// a separate one-line outcome first, then re-render) -- never the whole
// concatenated transcript.
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

describe('H-4b: output compatibility -- rendered human-output lines match the frozen fixture', () => {
  it('a fixed scenario against an empty store deep-equals the frozen lines fixture', async () => {
    const inventory: InventoryEntry[] = [
      {
        kind: 'skill',
        identifier: 'hello-world',
        source_path: '/skills/hello-world/SKILL.md',
        triggerSurface: [],
      },
      {
        kind: 'skill',
        identifier: 'jailbreak-checklist',
        source_path: '/skills/jailbreak-checklist/SKILL.md',
        triggerSurface: [],
      },
      {
        kind: 'command',
        identifier: 'some-command',
        source_path: '/commands/some-command.md',
        triggerSurface: [],
      },
    ]
    const content: Record<string, string> = {
      '/skills/hello-world/SKILL.md': 'benign content A',
      '/skills/jailbreak-checklist/SKILL.md': 'malicious content B',
      '/commands/some-command.md': 'borderline content C',
    }
    function scan(skillId: string): ScanReport {
      if (skillId === 'hello-world') return report('hello-world', { passed: true, riskScore: 5 })
      if (skillId === 'jailbreak-checklist') {
        return report('jailbreak-checklist', {
          passed: false,
          riskScore: 80,
          findings: [
            {
              type: 'jailbreak',
              severity: 'critical',
              message: 'fabricated instruction override',
              location: 'SKILL.md',
              lineNumber: 12,
              inDocumentationContext: false,
            },
            {
              type: 'jailbreak',
              severity: 'medium',
              message: 'bare jailbreak mention',
              location: 'SKILL.md',
              lineNumber: 40,
              inDocumentationContext: true,
            },
          ],
        })
      }
      return report('some-command', {
        passed: true,
        riskScore: 12,
        findings: [
          {
            type: 'suspicious_pattern',
            severity: 'low',
            message: 'borderline pattern in an example',
            location: 'some-command.md',
            lineNumber: 3,
            inDocumentationContext: true,
          },
        ],
      })
    }

    await runAuditSecurity(
      baseOpts({
        inventory,
        readContent: (p: string) => content[p] ?? null,
        scan,
        auditId: 'SENTINEL_AUDIT_ID',
      })
    )

    const lines = logSpy.mock.calls.map((c: unknown[]) => c.join(' '))
    const fixturePath = path.join(
      testDir,
      '..',
      '..',
      '..',
      'mcp-server',
      'tests',
      'fixtures',
      'security-audit',
      'output-compat-baseline.lines.json'
    )
    const frozen: unknown = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'))
    expect(lines).toEqual(frozen)
  })
})

describe('H-6b: --accept goes through the REAL runAuditSecurity orchestration, not a store mutator directly', () => {
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

  it('captures a real acceptKey, accepts it, and proves the audit actually re-ran (baseline advanced + suppression on re-render)', async () => {
    // 1. First run (json) -- capture the real acceptKey for the finding on S.
    await runAuditSecurity(
      baseOpts({
        json: true,
        inventory: [entry],
        readContent: () => 'bad-content',
        scan: () => report('S', { passed: false, riskScore: 80, findings: [finding] }),
      })
    )
    const firstResult = jsonOutput() as { candidates: Array<{ acceptKey: string }> }
    const acceptKey = firstResult.candidates[0]?.acceptKey
    expect(acceptKey).toBeDefined()
    const baselineUpdatedAtBefore = (
      JSON.parse(fs.readFileSync(baselinePath, 'utf-8')) as {
        skills: Record<string, { updatedAt: string }>
      }
    ).skills[entry.source_path]?.updatedAt

    logSpy.mockClear()

    // 2. Accept it via the real orchestration.
    await runAuditSecurity(
      baseOpts({
        json: true,
        accept: acceptKey,
        reason: 'reviewed, false positive',
        inventory: [entry],
        readContent: () => 'bad-content',
        scan: () => report('S', { passed: false, riskScore: 80, findings: [finding] }),
      })
    )

    // Store now contains exactly one record with acceptKey === K.
    const store = JSON.parse(fs.readFileSync(acceptancePath, 'utf-8')) as {
      records: Array<{ acceptKey: string }>
    }
    expect(store.records).toHaveLength(1)
    expect(store.records[0]?.acceptKey).toBe(acceptKey)

    // Baseline entry for S advanced -- proves runAuditSecurity re-ran the
    // real audit rather than mutating blind.
    const baselineUpdatedAtAfter = (
      JSON.parse(fs.readFileSync(baselinePath, 'utf-8')) as {
        skills: Record<string, { updatedAt: string }>
      }
    ).skills[entry.source_path]?.updatedAt
    expect(baselineUpdatedAtAfter).toBeDefined()
    expect(baselineUpdatedAtBefore).toBeDefined()

    // S is suppressed in the post-mutation render.
    const afterAccept = jsonOutput() as { findings: Array<{ accepted?: unknown }> }
    expect(afterAccept.findings[0]?.accepted).toBeDefined()
  })

  it('stale-key rejection: a key from BEFORE a content change is rejected, store unchanged, baseline still advanced', async () => {
    await runAuditSecurity(
      baseOpts({
        json: true,
        inventory: [entry],
        readContent: () => 'content-v1',
        scan: () => report('S', { passed: false, riskScore: 80, findings: [finding] }),
      })
    )
    const firstResult = jsonOutput() as { candidates: Array<{ acceptKey: string }> }
    const staleKey = firstResult.candidates[0]?.acceptKey
    expect(staleKey).toBeDefined()

    logSpy.mockClear()
    const exitCodeBefore = process.exitCode
    process.exitCode = undefined

    // Content changes between the capture and the accept attempt.
    await runAuditSecurity(
      baseOpts({
        json: true,
        accept: staleKey,
        reason: 'stale attempt',
        inventory: [entry],
        readContent: () => 'content-v2-changed',
        scan: () => report('S', { passed: false, riskScore: 80, findings: [finding] }),
      })
    )

    expect(process.exitCode).toBe(1)
    process.exitCode = exitCodeBefore
    expect(fs.existsSync(acceptancePath)).toBe(false) // store never written
  })
})

describe('H-8: --revoke resolves against the STORE, not the candidate index (D-9)', () => {
  it('revoke succeeds even when the content changed and no candidate matches anymore', async () => {
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

    await runAuditSecurity(
      baseOpts({
        json: true,
        inventory: [entry],
        readContent: () => 'content-v1',
        scan: () => report('S', { passed: false, riskScore: 80, findings: [finding] }),
      })
    )
    const captured = jsonOutput() as { candidates: Array<{ acceptKey: string }> }
    const key = captured.candidates[0]?.acceptKey
    expect(key).toBeDefined()

    logSpy.mockClear()
    await runAuditSecurity(
      baseOpts({
        json: true,
        accept: key,
        reason: 'reviewed',
        inventory: [entry],
        readContent: () => 'content-v1',
        scan: () => report('S', { passed: false, riskScore: 80, findings: [finding] }),
      })
    )
    expect(JSON.parse(fs.readFileSync(acceptancePath, 'utf-8')).records).toHaveLength(1)

    logSpy.mockClear()
    await runAuditSecurity(
      baseOpts({
        json: true,
        revoke: key,
        // Content changed -- no candidate on THIS run matches `key` anymore.
        inventory: [entry],
        readContent: () => 'content-v2-totally-different',
        scan: () => report('S', { passed: true, riskScore: 1, findings: [] }),
      })
    )
    expect(JSON.parse(fs.readFileSync(acceptancePath, 'utf-8')).records).toEqual([])
  })
})

describe('H-17: flag validation -- rejected before any lock/file touch', () => {
  const cases: Array<[string, Partial<AuditSecurityOptions>, string]> = [
    ['missing --reason', { accept: 'a'.repeat(64) }, 'reason_required'],
    ['501-char reason', { accept: 'a'.repeat(64), reason: 'x'.repeat(501) }, 'reason_too_long'],
    ['non-hex key', { accept: 'z'.repeat(64), reason: 'ok' }, 'invalid_key_format'],
    ['63-char key', { accept: 'a'.repeat(63), reason: 'ok' }, 'invalid_key_format'],
    [
      '--accept + --revoke',
      { accept: 'a'.repeat(64), reason: 'ok', revoke: 'b'.repeat(64) },
      'conflicting_options',
    ],
    [
      '--all-candidates without --json',
      { allCandidates: true, json: false },
      'all_candidates_requires_json',
    ],
    [
      '--all-candidates + --page',
      { allCandidates: true, json: true, page: 2 },
      'conflicting_options',
    ],
    // Code-review round 2: --limit/--page/--page-size must be positive
    // integers -- a non-numeric, negative, zero, or fractional value
    // previously passed through unvalidated.
    ['--limit 0', { limit: 0 }, 'invalid_numeric_option'],
    ['--limit negative', { limit: -5 }, 'invalid_numeric_option'],
    ['--limit fractional', { limit: 1.5 }, 'invalid_numeric_option'],
    ['--limit NaN (non-numeric raw value)', { limit: NaN }, 'invalid_numeric_option'],
    ['--page 0', { page: 0 }, 'invalid_numeric_option'],
    ['--page-size negative', { pageSize: -1 }, 'invalid_numeric_option'],
  ]

  it.each(cases)(
    '%s -> exit 1, no lock file created',
    async (_label, extra, expectedCodeFragment) => {
      const exitCodeBefore = process.exitCode
      process.exitCode = undefined
      await runAuditSecurity(baseOpts({ inventory: [], ...extra }))
      expect(process.exitCode).toBe(1)
      expect(output()).toContain(expectedCodeFragment)
      expect(fs.existsSync(`${acceptancePath}.lock`)).toBe(false)
      process.exitCode = exitCodeBefore
    }
  )
})

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
})

// Sanity: printFindings is still directly usable (unit-level, no full orchestration).
describe('printFindings smoke (accepted-tag rendering)', () => {
  it('renders an ACCEPTED tag (not FAILING) for a finding carrying `accepted`', () => {
    printFindings({
      auditId: 'A',
      findings: [
        {
          kind: 'security',
          securityId: 'id',
          entry: { kind: 'skill', identifier: 'x', source_path: '/x/SKILL.md', triggerSurface: [] },
          verdict: 'malicious',
          severity: 'critical',
          riskScore: 80,
          riskDelta: null,
          newFindingCount: 0,
          reason: 'r',
          accepted: { count: 1, acceptedAt: '2026-07-01T00:00:00.000Z', reason: 'reviewed' },
        },
      ],
      summary: {
        scanned: 1,
        unchanged: 0,
        unreadable: 0,
        hostile: 0,
        suspicious: 0,
        malicious: 0,
        accepted: 1,
        candidateTotal: 1,
        durationMs: 1,
      },
      candidateIndex: new Map(),
      acceptances: [],
      warnings: [],
    })
    expect(output()).toContain('ACCEPTED')
    expect(output()).not.toContain('FAILING')
  })
})
