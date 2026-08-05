/**
 * @fileoverview Acceptance-allowlist tests for the local security audit
 *               (SMI-5883 Wave 2, §9). Split from `security-audit.test.ts`
 *               (which covers the pre-existing baseline/rug-pull mechanics)
 *               to stay under the 500-line file gate. H-15/H-16/H-4a live in
 *               the sibling `security-audit.acceptance-candidates.test.ts`
 *               (same split reason); shared fixtures live in
 *               `security-audit.acceptance.test-helpers.ts`.
 * @module @skillsmith/mcp-server/audit/security-audit.acceptance.test
 *
 * Covers H-1, H-2, H-5, H-6a.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SecurityFinding } from '@skillsmith/core'

import { runSecurityAudit } from './security-audit.js'
import { loadSecurityBaseline } from './security-baseline.js'
import {
  CRITICAL_EXFIL,
  entry,
  report,
  seedAcceptAll,
  sha256,
} from './security-audit.acceptance.test-helpers.js'

let tmpDir: string
let baselinePath: string
let acceptancePath: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-audit-accept-'))
  baselinePath = path.join(tmpDir, 'security-baseline.json')
  acceptancePath = path.join(tmpDir, 'security-acceptance.json')
})
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('security acceptance -- INV-1/INV-2: never leaks into compareScanReports (H-1/H-2)', () => {
  it('H-1: accepting every finding on S does not blind the hostile rug-pull check, and the persisted baseline stays raw/unfiltered', async () => {
    const e = entry('S')
    // Establish a benign baseline.
    await runSecurityAudit({
      baselinePath,
      acceptancePath,
      inventory: [e],
      readContent: () => 'v1',
      scan: () => report('S', { passed: true, riskScore: 5 }),
    })
    // Accept a finding that will appear on the NEXT (malicious) scan.
    seedAcceptAll(acceptancePath, sha256('v2-malicious'), [CRITICAL_EXFIL])

    const res = await runSecurityAudit({
      baselinePath,
      acceptancePath,
      inventory: [e],
      readContent: () => 'v2-malicious',
      scan: () => report('S', { passed: false, riskScore: 80, findings: [CRITICAL_EXFIL] }),
    })

    expect(res.findings).toHaveLength(1)
    expect(res.findings[0]?.verdict).toBe('hostile') // INV-2: never suppressed
    expect(res.findings[0]?.accepted).toBeUndefined()

    const base = loadSecurityBaseline(baselinePath)
    expect(base.skills[e.source_path]?.report.findings).toEqual([CRITICAL_EXFIL]) // raw, unfiltered
  })

  it('H-2(a): a hostile transition is emitted even when every underlying finding is accepted', async () => {
    const e = entry('S')
    await runSecurityAudit({
      baselinePath,
      acceptancePath,
      inventory: [e],
      readContent: () => 'v1',
      scan: () => report('S', { passed: true, riskScore: 5 }),
    })
    seedAcceptAll(acceptancePath, sha256('v2-hostile'), [CRITICAL_EXFIL])
    const res = await runSecurityAudit({
      baselinePath,
      acceptancePath,
      inventory: [e],
      readContent: () => 'v2-hostile',
      scan: () => report('S', { passed: false, riskScore: 90, findings: [CRITICAL_EXFIL] }),
    })
    expect(res.findings[0]?.verdict).toBe('hostile')
  })

  it('H-2(b): a suspicious transition is emitted even when every underlying finding is accepted', async () => {
    const e = entry('S')
    const mediumFinding: SecurityFinding = {
      type: 'suspicious_pattern',
      severity: 'medium',
      message: 'new medium-severity pattern',
      inDocumentationContext: false,
    }
    await runSecurityAudit({
      baselinePath,
      acceptancePath,
      inventory: [e],
      readContent: () => 'v1',
      scan: () => report('S', { passed: true, riskScore: 5 }),
    })
    seedAcceptAll(acceptancePath, sha256('v2-suspicious'), [mediumFinding])
    const res = await runSecurityAudit({
      baselinePath,
      acceptancePath,
      inventory: [e],
      readContent: () => 'v2-suspicious',
      scan: () => report('S', { passed: true, riskScore: 30, findings: [mediumFinding] }),
    })
    expect(res.findings).toHaveLength(1)
    expect(res.findings[0]?.verdict).toBe('suspicious')
  })
})

describe('security acceptance -- H-5/H-6a: suppression + INV-5 visibility', () => {
  it('H-5: accepting all findings on a failing skill suppresses it into an ACCEPTED annotation, never silently', async () => {
    const e = entry('evil')
    const content = 'bad-content'
    seedAcceptAll(
      acceptancePath,
      sha256(content),
      [CRITICAL_EXFIL],
      'reviewed 2026-07-29: documented example, not a real payload'
    )

    const res = await runSecurityAudit({
      baselinePath,
      acceptancePath,
      inventory: [e],
      readContent: () => content,
      scan: () => report('evil', { passed: false, riskScore: 80, findings: [CRITICAL_EXFIL] }),
    })

    expect(res.findings).toHaveLength(1)
    const f = res.findings[0]
    expect(f?.verdict).toBe('malicious') // INV-5: not removed, just annotated
    expect(f?.accepted).toBeDefined()
    expect(f?.accepted?.count).toBe(1)
    expect(f?.accepted?.reason).toContain('documented example')
    expect(res.summary.accepted).toBe(1)
    expect(res.summary.malicious).toBe(0) // no longer an actionable failure
  })

  it('H-6a: a pre-seeded acceptance (never run through --accept) is honored on the very first audit', async () => {
    const e = entry('evil')
    const content = 'bad-content-2'
    seedAcceptAll(acceptancePath, sha256(content), [CRITICAL_EXFIL])

    const res = await runSecurityAudit({
      baselinePath,
      acceptancePath,
      inventory: [e],
      readContent: () => content,
      scan: () => report('evil', { passed: false, riskScore: 80, findings: [CRITICAL_EXFIL] }),
    })
    expect(res.findings[0]?.accepted).toBeDefined()
  })

  it('a PARTIALLY accepted skill (one of two findings) is NOT suppressed', async () => {
    const e = entry('evil')
    const content = 'bad-content-3'
    const other: SecurityFinding = { type: 'ssrf', severity: 'high', message: 'other finding' }
    seedAcceptAll(acceptancePath, sha256(content), [CRITICAL_EXFIL]) // only ONE of the two findings

    const res = await runSecurityAudit({
      baselinePath,
      acceptancePath,
      inventory: [e],
      readContent: () => content,
      scan: () =>
        report('evil', { passed: false, riskScore: 80, findings: [CRITICAL_EXFIL, other] }),
    })
    expect(res.findings[0]?.accepted).toBeUndefined()
    expect(res.summary.malicious).toBe(1)
    expect(res.summary.accepted).toBe(0)
  })
})
