/**
 * @fileoverview Unit tests for the local security audit (SMI-5541 Wave 2C).
 * @module @skillsmith/mcp-server/audit/security-audit.test
 *
 * Orchestration (baseline persistence, verdict priority, pruning, fail-safe)
 * is tested against INJECTED `ScanReport`s so it is independent of scanner
 * pattern churn. One integration test exercises the real `SecurityScanner`
 * wiring on benign content (no false positive).
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ScanReport, SecurityFinding } from '@skillsmith/core'

import { runSecurityAudit } from './security-audit.js'
import { loadSecurityBaseline } from './security-baseline.js'
import type { InventoryEntry } from '../utils/local-inventory.types.js'

let tmpDir: string
let baselinePath: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-audit-'))
  baselinePath = path.join(tmpDir, 'security-baseline.json')
})
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// --- fixtures --------------------------------------------------------------

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

const CRITICAL_EXFIL: SecurityFinding = {
  type: 'data_exfiltration',
  severity: 'critical',
  message: 'exfiltrate ~/.ssh/id_rsa to evil.example.com',
  inDocumentationContext: false,
}

function entry(
  identifier: string,
  kind: InventoryEntry['kind'] = 'skill',
  sourcePath?: string
): InventoryEntry {
  return {
    kind,
    identifier,
    source_path: sourcePath ?? `/skills/${identifier}/SKILL.md`,
    triggerSurface: [],
  }
}

/** A `scan` stub that throws — proves the unchanged path never re-scans. */
const scanMustNotRun = (): ScanReport => {
  throw new Error('scan() should not be called for unchanged content')
}

// --- tests -----------------------------------------------------------------

describe('runSecurityAudit', () => {
  it('first-sight benign skill → no finding, baseline established', async () => {
    const e = entry('foo')
    const res = await runSecurityAudit({
      baselinePath,
      inventory: [e],
      readContent: () => 'benign-v1',
      scan: () => report('foo', { passed: true, riskScore: 5 }),
    })

    expect(res.findings).toHaveLength(0)
    expect(res.summary.scanned).toBe(1)
    const base = loadSecurityBaseline(baselinePath)
    expect(base.skills[e.source_path]?.report.passed).toBe(true)
  })

  it('first-sight failing skill → malicious finding (critical)', async () => {
    const res = await runSecurityAudit({
      baselinePath,
      inventory: [entry('evil')],
      readContent: () => 'bad',
      scan: () => report('evil', { passed: false, riskScore: 80, findings: [CRITICAL_EXFIL] }),
    })

    expect(res.findings).toHaveLength(1)
    expect(res.findings[0]?.verdict).toBe('malicious')
    expect(res.findings[0]?.severity).toBe('critical')
    expect(res.findings[0]?.riskDelta).toBeNull()
    expect(res.summary.malicious).toBe(1)
  })

  it('benign baseline → malicious content change = hostile rug-pull', async () => {
    const e = entry('foo')
    // Establish a benign baseline.
    await runSecurityAudit({
      baselinePath,
      inventory: [e],
      readContent: () => 'v1',
      scan: () => report('foo', { passed: true, riskScore: 5 }),
    })
    // Content changes and now fails.
    const res = await runSecurityAudit({
      baselinePath,
      inventory: [e],
      readContent: () => 'v2-malicious',
      scan: () => report('foo', { passed: false, riskScore: 80, findings: [CRITICAL_EXFIL] }),
    })

    expect(res.findings).toHaveLength(1)
    expect(res.findings[0]?.verdict).toBe('hostile')
    expect(res.findings[0]?.riskDelta).toBe(75)
    expect(res.findings[0]?.newFindingCount).toBe(1)
    expect(res.summary.hostile).toBe(1)
  })

  it('unchanged content → skipped, no re-scan, no finding', async () => {
    const e = entry('foo')
    await runSecurityAudit({
      baselinePath,
      inventory: [e],
      readContent: () => 'v1',
      scan: () => report('foo', { passed: true, riskScore: 5 }),
    })
    const res = await runSecurityAudit({
      baselinePath,
      inventory: [e],
      readContent: () => 'v1',
      scan: scanMustNotRun,
    })

    expect(res.findings).toHaveLength(0)
    expect(res.summary.scanned).toBe(0)
    expect(res.summary.unchanged).toBe(1)
  })

  it('persistently-failing unchanged skill → still surfaced as malicious (no re-scan)', async () => {
    const e = entry('evil')
    await runSecurityAudit({
      baselinePath,
      inventory: [e],
      readContent: () => 'bad',
      scan: () => report('evil', { passed: false, riskScore: 80, findings: [CRITICAL_EXFIL] }),
    })
    const res = await runSecurityAudit({
      baselinePath,
      inventory: [e],
      readContent: () => 'bad',
      scan: scanMustNotRun,
    })

    expect(res.findings).toHaveLength(1)
    expect(res.findings[0]?.verdict).toBe('malicious')
    expect(res.summary.unchanged).toBe(1)
  })

  it('unreadable content → counted as unreadable (not unchanged), no finding, no throw', async () => {
    const res = await runSecurityAudit({
      baselinePath,
      inventory: [entry('foo')],
      readContent: () => null,
      scan: () => report('foo', { passed: true, riskScore: 1 }),
    })

    expect(res.findings).toHaveLength(0)
    expect(res.summary.unreadable).toBe(1)
    expect(res.summary.unchanged).toBe(0)
    expect(res.summary.scanned).toBe(0)
  })

  it('a transient unreadable run PRESERVES the baseline (rug-pull still detected next run)', async () => {
    const e = entry('foo')
    // Run 1: establish a benign baseline.
    await runSecurityAudit({
      baselinePath,
      inventory: [e],
      readContent: () => 'v1',
      scan: () => report('foo', { passed: true, riskScore: 5 }),
    })
    // Run 2: a transient read failure. The prior baseline must NOT be pruned.
    await runSecurityAudit({
      baselinePath,
      inventory: [e],
      readContent: () => null,
      scan: scanMustNotRun,
    })
    expect(loadSecurityBaseline(baselinePath).skills[e.source_path]).toBeDefined()
    // Run 3: content changes to malicious → still a HOSTILE rug-pull, NOT a
    // first-sight `malicious` (which is what a pruned baseline would produce).
    const res = await runSecurityAudit({
      baselinePath,
      inventory: [e],
      readContent: () => 'v2-malicious',
      scan: () => report('foo', { passed: false, riskScore: 80, findings: [CRITICAL_EXFIL] }),
    })
    expect(res.findings[0]?.verdict).toBe('hostile')
  })

  it('a scanner throw is isolated to one skill; the batch continues, baseline preserved', async () => {
    const a = entry('a')
    const b = entry('b')
    // Seed a benign baseline for `a`.
    await runSecurityAudit({
      baselinePath,
      inventory: [a],
      readContent: () => 'a-v1',
      scan: () => report('a', { passed: true, riskScore: 5 }),
    })
    // `a`'s scan throws (content changed → re-scan path); `b` scans fine.
    const res = await runSecurityAudit({
      baselinePath,
      inventory: [a, b],
      readContent: (p) => (p === a.source_path ? 'a-v2' : 'b-v1'),
      scan: (id) => {
        if (id === 'a') throw new Error('scanner blew up on a')
        return report(id, { passed: true, riskScore: 2 })
      },
    })
    expect(res.summary.unreadable).toBe(1) // a
    expect(res.summary.scanned).toBe(1) // b
    // `a`'s prior baseline survives the throw; `b` is newly baselined.
    const base = loadSecurityBaseline(baselinePath)
    expect(base.skills[a.source_path]).toBeDefined()
    expect(base.skills[b.source_path]).toBeDefined()
  })

  it('a threshold change re-scans rather than trusting a verdict from a different bar', async () => {
    const e = entry('foo')
    await runSecurityAudit({
      baselinePath,
      inventory: [e],
      readContent: () => 'v1',
      riskThreshold: 40,
      scan: () => report('foo', { passed: true, riskScore: 5 }),
    })
    // Same content, DIFFERENT threshold → must NOT take the unchanged fast path.
    let scanCalls = 0
    const res = await runSecurityAudit({
      baselinePath,
      inventory: [e],
      readContent: () => 'v1',
      riskThreshold: 30,
      scan: () => {
        scanCalls += 1
        return report('foo', { passed: true, riskScore: 5 })
      },
    })
    expect(scanCalls).toBe(1)
    expect(res.summary.scanned).toBe(1)
    expect(res.summary.unchanged).toBe(0)
  })

  it('non-scannable kinds (claude_md_rule) are ignored', async () => {
    const rule = entry('CLAUDE.md', 'claude_md_rule', '/home/u/.claude/CLAUDE.md')
    const res = await runSecurityAudit({
      baselinePath,
      inventory: [rule],
      readContent: () => 'do a thing',
      scan: () => report('x', { passed: false, riskScore: 99, findings: [CRITICAL_EXFIL] }),
    })

    expect(res.findings).toHaveLength(0)
    expect(res.summary.scanned).toBe(0)
    const base = loadSecurityBaseline(baselinePath)
    expect(base.skills[rule.source_path]).toBeUndefined()
  })

  it('prunes uninstalled skills from the baseline', async () => {
    const a = entry('a')
    const b = entry('b')
    await runSecurityAudit({
      baselinePath,
      inventory: [a, b],
      readContent: (p) => p,
      scan: (id) => report(id, { passed: true, riskScore: 1 }),
    })
    // Re-run with only `a`, content changed so it is re-scanned.
    await runSecurityAudit({
      baselinePath,
      inventory: [a],
      readContent: (p) => `${p}-changed`,
      scan: (id) => report(id, { passed: true, riskScore: 1 }),
    })

    const base = loadSecurityBaseline(baselinePath)
    expect(Object.keys(base.skills)).toEqual([a.source_path])
  })

  it('corrupt baseline file → treated as empty (first-sight), no throw', async () => {
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true })
    fs.writeFileSync(baselinePath, 'not json {{{')
    const res = await runSecurityAudit({
      baselinePath,
      inventory: [entry('foo')],
      readContent: () => 'x',
      scan: () => report('foo', { passed: true, riskScore: 1 }),
    })

    expect(res.findings).toHaveLength(0)
    expect(res.summary.scanned).toBe(1)
  })

  it('integration: the real SecurityScanner is wired and does not flag benign content', async () => {
    const res = await runSecurityAudit({
      baselinePath,
      inventory: [entry('hello-world')],
      // A plain, benign skill body — the real scanner should pass it.
      readContent: () =>
        '# Hello World\n\nThis skill greets the user politely. It has no code, URLs, or secrets.\n',
      // No `scan` injected → exercises `new SecurityScanner().scan`.
    })

    expect(res.summary.scanned).toBe(1)
    expect(res.findings).toHaveLength(0)
  })
})
