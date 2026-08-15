/**
 * Security Scanner — risk score calculation
 * @module @skillsmith/core/security/scanner/SecurityScanner.risk-score
 *
 * SMI-6033 Wave 4: extracted out of `SecurityScanner.helpers.ts` (which had
 * grown to 504/500 lines, over this repo's file-length gate, once Wave 4's
 * `decoyMisdirection` breakdown field/switch-arm/cap/sum entries landed).
 * This filename intentionally matches the one already referenced by the
 * separate, still-open SMI-5879 Wave 2 PR (#2192,
 * `feat/smi-5879-wave2-pattern-port` — see that branch's
 * `scripts/indexer/smi5879-corroboration.types.ts`, which already names
 * `packages/core/src/security/scanner/SecurityScanner.risk-score.ts` as its
 * own planned extraction target for this same function): reusing the name
 * that PR already committed to avoids a second, differently-named
 * competing extraction landing later and forcing a rename/merge fight.
 */

import type { SecurityFinding, RiskScoreBreakdown, FindingConfidence } from './types.js'
import { SEVERITY_WEIGHTS, CATEGORY_WEIGHTS } from './weights.js'

/**
 * SMI-685: Calculate risk score from findings
 * SMI-1513: Accounts for confidence levels (low confidence = reduced weight)
 * Aggregates multiple findings into a risk score from 0-100
 */
export function calculateRiskScore(findings: SecurityFinding[]): {
  total: number
  breakdown: RiskScoreBreakdown
} {
  const breakdown: RiskScoreBreakdown = {
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
