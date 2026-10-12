/**
 * SMI-7030 T-equivalence: the CATEGORY_COEFFICIENTS refactor of
 * calculateRiskScore must not move any pre-existing score.
 *
 * `legacyCalculateRiskScore` below is a FROZEN, verbatim copy of
 * SecurityScanner.risk-score.ts's calculateRiskScore as it stood on main
 * (8a76c30fd) BEFORE the refactor: the inline 19-term sum, no coefficient
 * parameter, no executable_frontmatter category. Do not "update" it to track
 * the live function: its whole value is that it does not change. Only the
 * function name, and the imports above it, differ from the original.
 */

import { describe, it, expect } from 'vitest'
import type {
  SecurityFinding,
  RiskScoreBreakdown,
  FindingConfidence,
  SecurityFindingType,
  SecuritySeverity,
} from '../../src/security/scanner/types.js'
import {
  SEVERITY_WEIGHTS,
  CATEGORY_WEIGHTS,
  CATEGORY_COEFFICIENTS,
} from '../../src/security/scanner/weights.js'
import { calculateRiskScore } from '../../src/security/scanner/SecurityScanner.risk-score.js'

// ---- frozen reference: begin ----
// (type only: the live RiskScoreBreakdown gained executableFrontmatter after the freeze)
type LegacyBreakdown = Omit<RiskScoreBreakdown, 'executableFrontmatter'>

function legacyCalculateRiskScore(findings: SecurityFinding[]): {
  total: number
  breakdown: LegacyBreakdown
} {
  const breakdown: LegacyBreakdown = {
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

  const confidenceWeights: Record<FindingConfidence, number> = {
    high: 1.0,
    medium: 0.7,
    low: 0.3,
  }

  for (const finding of findings) {
    const severityWeight = SEVERITY_WEIGHTS[finding.severity]
    const categoryWeight = CATEGORY_WEIGHTS[finding.type] ?? 1.0
    const confidenceWeight = confidenceWeights[finding.confidence ?? 'high']
    const score = severityWeight * categoryWeight * confidenceWeight

    switch (finding.type) {
      case 'jailbreak':
        breakdown.jailbreak += score
        break
      case 'social_engineering':
        breakdown.socialEngineering += score
        break
      case 'prompt_leaking':
        breakdown.promptLeaking += score
        break
      case 'data_exfiltration':
        breakdown.dataExfiltration += score
        break
      case 'privilege_escalation':
        breakdown.privilegeEscalation += score
        break
      case 'suspicious_pattern':
        breakdown.suspiciousCode += score
        break
      case 'sensitive_path':
        breakdown.sensitivePaths += score
        break
      case 'url':
        breakdown.externalUrls += score
        break
      case 'ai_defence':
        breakdown.aiDefence += score
        break
      case 'ssrf':
        breakdown.ssrf += score
        break
      case 'pii':
        breakdown.pii += score
        break
      case 'code_execution':
        breakdown.codeExecution += score
        break
      case 'obfuscated_directive':
        breakdown.obfuscatedDirective += score
        break
      case 'typosquat':
        // SMI-595: this switch has NO default case — a missing arm here would
        // silently drop every typosquat finding from the breakdown with zero
        // compile-time or runtime error. See the switch-case coverage test in
        // SecurityScanner.scoring.test.ts, added specifically to guard this.
        breakdown.typosquat += score
        break
      case 'gatekeeper_bypass':
        breakdown.gatekeeperBypass += score
        break
      case 'archive_evasion':
        breakdown.archiveEvasion += score
        break
      case 'paste_host_fetch':
        breakdown.pasteHostFetch += score
        break
      case 'encoded_payload':
        breakdown.encodedPayload += score
        break
      case 'decoy_misdirection':
        breakdown.decoyMisdirection += score
        break
    }
  }

  // Cap each category at 100
  breakdown.jailbreak = Math.min(100, breakdown.jailbreak)
  breakdown.socialEngineering = Math.min(100, breakdown.socialEngineering)
  breakdown.promptLeaking = Math.min(100, breakdown.promptLeaking)
  breakdown.dataExfiltration = Math.min(100, breakdown.dataExfiltration)
  breakdown.privilegeEscalation = Math.min(100, breakdown.privilegeEscalation)
  breakdown.suspiciousCode = Math.min(100, breakdown.suspiciousCode)
  breakdown.sensitivePaths = Math.min(100, breakdown.sensitivePaths)
  breakdown.externalUrls = Math.min(100, breakdown.externalUrls)
  breakdown.aiDefence = Math.min(100, breakdown.aiDefence)
  breakdown.ssrf = Math.min(100, breakdown.ssrf)
  breakdown.pii = Math.min(100, breakdown.pii)
  breakdown.codeExecution = Math.min(100, breakdown.codeExecution)
  breakdown.obfuscatedDirective = Math.min(100, breakdown.obfuscatedDirective)
  breakdown.typosquat = Math.min(100, breakdown.typosquat)
  breakdown.gatekeeperBypass = Math.min(100, breakdown.gatekeeperBypass)
  breakdown.archiveEvasion = Math.min(100, breakdown.archiveEvasion)
  breakdown.pasteHostFetch = Math.min(100, breakdown.pasteHostFetch)
  breakdown.encodedPayload = Math.min(100, breakdown.encodedPayload)
  breakdown.decoyMisdirection = Math.min(100, breakdown.decoyMisdirection)

  // SMI-5359 Wave 4.2: the two new categories use a 0.40 coefficient and are ADDITIVE
  // (the original eleven coefficients sum to 1.0; these add on top). No code assumes the
  // coefficients sum to 1.0, and the final Math.min(100, ...) cap is preserved — so a skill
  // that triggers neither new category scores exactly as before (both breakdown entries 0).
  // SMI-595: typosquat is likewise ADDITIVE, at the 0.04 coefficient already used for
  // sensitivePaths/externalUrls/ssrf (the "advisory tier" of this second-stage formula) —
  // NOT folded into the eleven-category budget that sums to 1.0. See weights.ts's
  // CATEGORY_WEIGHTS.typosquat comment for the worked calculation this pairs with.
  // SMI-6033 Wave 2: gatekeeperBypass/archiveEvasion/pasteHostFetch are
  // ADDITIVE at the 0.40 coefficient (matching codeExecution/
  // obfuscatedDirective's top tier) — see weights.ts's
  // CATEGORY_WEIGHTS.gatekeeper_bypass comment for the worked calculation
  // showing how ONE weight/coefficient pair produces both the
  // standalone-critical and advisory-medium outcomes via severity alone.
  // encodedPayload is likewise ADDITIVE, at the 0.04 coefficient (the same
  // advisory tier as sensitivePaths/externalUrls/ssrf/typosquat) — see
  // weights.ts's CATEGORY_WEIGHTS.encoded_payload comment.
  const total = Math.min(
    100,
    Math.round(
      breakdown.jailbreak * 0.2 +
        breakdown.socialEngineering * 0.11 +
        breakdown.promptLeaking * 0.11 +
        breakdown.dataExfiltration * 0.08 +
        breakdown.privilegeEscalation * 0.11 +
        breakdown.suspiciousCode * 0.07 +
        breakdown.sensitivePaths * 0.04 +
        breakdown.externalUrls * 0.04 +
        breakdown.aiDefence * 0.12 +
        breakdown.ssrf * 0.04 +
        breakdown.pii * 0.08 +
        breakdown.codeExecution * 0.4 +
        breakdown.obfuscatedDirective * 0.4 +
        breakdown.typosquat * 0.04 +
        breakdown.gatekeeperBypass * 0.4 +
        breakdown.archiveEvasion * 0.4 +
        breakdown.pasteHostFetch * 0.4 +
        breakdown.encodedPayload * 0.04 +
        // SMI-6033 Wave 4 (Gap 6): additive 0.04, same advisory tier as encodedPayload/typosquat.
        breakdown.decoyMisdirection * 0.04
    )
  )

  return { total, breakdown }
}

// ---- frozen reference: end ----

const LEGACY_TYPES = (Object.keys(CATEGORY_WEIGHTS) as SecurityFindingType[]).filter(
  (t) => t !== 'executable_frontmatter'
)
const SEVERITIES = Object.keys(SEVERITY_WEIGHTS) as SecuritySeverity[]
const CONFIDENCES: FindingConfidence[] = ['high', 'medium', 'low']

function f(
  type: SecurityFindingType,
  severity: SecuritySeverity,
  confidence: FindingConfidence = 'high'
): SecurityFinding {
  return { type, severity, confidence, message: 'x' }
}

function expectSame(findings: SecurityFinding[]): void {
  const now = calculateRiskScore(findings)
  const then = legacyCalculateRiskScore(findings)
  expect(now.total).toBe(then.total)
  for (const k of Object.keys(then.breakdown) as Array<keyof LegacyBreakdown>) {
    expect(now.breakdown[k]).toBe(then.breakdown[k])
  }
  // The only breakdown field the refactor adds is the flag-only one, and it is 0 here.
  expect(now.breakdown.executableFrontmatter).toBe(0)
}

describe('SMI-7030 coefficient map order', () => {
  // The refactored sum is a left-to-right loop over CATEGORY_COEFFICIENTS' keys.
  // Float addition is not associative, so a reordered map can move a total by
  // one ULP and, at an N + 0.5 boundary, by one point after Math.round. The
  // value table below cannot catch that (a measured adjacent swap survived it),
  // so pin the declaration order itself: the frozen legacy sum's term order,
  // then the new flag-only term last.
  it('iterates in exactly the legacy sum order, with executableFrontmatter last', () => {
    expect(Object.keys(CATEGORY_COEFFICIENTS)).toEqual([
      'jailbreak',
      'socialEngineering',
      'promptLeaking',
      'dataExfiltration',
      'privilegeEscalation',
      'suspiciousCode',
      'sensitivePaths',
      'externalUrls',
      'aiDefence',
      'ssrf',
      'pii',
      'codeExecution',
      'obfuscatedDirective',
      'typosquat',
      'gatekeeperBypass',
      'archiveEvasion',
      'pasteHostFetch',
      'encodedPayload',
      'decoyMisdirection',
      'executableFrontmatter',
    ])
  })
})

describe('SMI-7030 T-equivalence: refactored calculateRiskScore vs frozen legacy', () => {
  it('the table is non-trivial (presence guard, asserted first)', () => {
    // 19 pre-existing types, so a mis-filtered table cannot pass vacuously.
    expect(LEGACY_TYPES).toHaveLength(19)
    expect(legacyCalculateRiskScore([f('code_execution', 'critical')]).total).toBe(40)
  })

  it('every type at every severity and confidence, singly', () => {
    for (const t of LEGACY_TYPES)
      for (const s of SEVERITIES) for (const c of CONFIDENCES) expectSame([f(t, s, c)])
  })

  it('every ordered pair of types at critical/high and at medium/medium', () => {
    for (const a of LEGACY_TYPES)
      for (const b of LEGACY_TYPES) {
        expectSame([f(a, 'critical'), f(b, 'critical')])
        expectSame([f(a, 'medium', 'medium'), f(b, 'low', 'low')])
      }
  })

  it('B_core and a many-category pile-up', () => {
    expectSame([
      f('code_execution', 'medium'),
      f('jailbreak', 'low'),
      f('privilege_escalation', 'medium'),
      f('data_exfiltration', 'medium'),
    ])
    expectSame(LEGACY_TYPES.map((t, i) => f(t, SEVERITIES[i % 4], CONFIDENCES[i % 3])))
    expectSame(LEGACY_TYPES.flatMap((t) => [f(t, 'high'), f(t, 'medium'), f(t, 'low')]))
  })
})
