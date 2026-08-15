/**
 * @fileoverview Shared fixtures for the acceptance-allowlist test suite
 *               (SMI-5883 Wave 2, §9), split out so both
 *               `security-audit.acceptance.test.ts` (H-1/H-2/H-5/H-6a) and
 *               `security-audit.acceptance-candidates.test.ts`
 *               (H-4a/H-15/H-16) can share them without either file pushing
 *               the other over the 500-line gate.
 * @module @skillsmith/mcp-server/audit/security-audit.acceptance.test-helpers
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { SCANNER_RULESET_VERSION } from '@skillsmith/core'
import type { ScanReport, SecurityFinding } from '@skillsmith/core'

import { computeAcceptKey, computeStoreDigest, findingFingerprint } from './security-acceptance.js'
import { ACCEPTANCE_STORE_VERSION } from './security-acceptance.types.js'
import type { AcceptanceRecord, AcceptanceStore } from './security-acceptance.types.js'
import type { InventoryEntry } from '../utils/local-inventory.types.js'

export const ZERO_BREAKDOWN: ScanReport['riskBreakdown'] = {
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
}

export function report(
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

export function entry(identifier: string, sourcePath?: string): InventoryEntry {
  return {
    kind: 'skill',
    identifier,
    source_path: sourcePath ?? `/skills/${identifier}/SKILL.md`,
    triggerSurface: [],
  }
}

export const CRITICAL_EXFIL: SecurityFinding = {
  type: 'data_exfiltration',
  severity: 'critical',
  message: 'exfiltrate ~/.ssh/id_rsa to evil.example.com',
  inDocumentationContext: false,
}

/** Seed the acceptance store directly (bypassing the CLI/lock) with one record accepting every finding in `findings` for `contentDigest`. */
export function seedAcceptAll(
  acceptancePath: string,
  contentDigest: string,
  findings: SecurityFinding[],
  reason = 'reviewed'
): void {
  const records: AcceptanceRecord[] = findings.map((f) => ({
    acceptKey: computeAcceptKey({
      contentDigest,
      findingFingerprint: findingFingerprint(f),
      rulesetVersion: SCANNER_RULESET_VERSION,
    }),
    sourcePath: '/skills/x/SKILL.md',
    identifier: 'x',
    contentDigest,
    findingFingerprint: findingFingerprint(f),
    rulesetVersion: SCANNER_RULESET_VERSION,
    display: {
      type: f.type,
      severity: f.severity,
      message: f.message,
      location: f.location ?? null,
      lineNumber: Number.isInteger(f.lineNumber) ? (f.lineNumber as number) : null,
    },
    acceptedAt: '2026-07-01T00:00:00.000Z',
    reason,
  }))
  const shell = { version: ACCEPTANCE_STORE_VERSION, revision: 1, records }
  const store: AcceptanceStore = { ...shell, storeDigest: computeStoreDigest(shell) }
  fs.mkdirSync(path.dirname(acceptancePath), { recursive: true })
  fs.writeFileSync(acceptancePath, JSON.stringify(store, null, 2))
}

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}
