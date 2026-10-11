/**
 * SMI-7030: Edge security-scanner category weights + coefficients
 * @module scripts/indexer/_shared/security-scanner-edge.weights (Node port)
 *
 * Split out of security-scanner-edge.context.ts to keep that file under the
 * 500-line limit once the executable_frontmatter entries were added. Re-exported
 * from security-scanner-edge.context.ts so every existing importer keeps
 * working unchanged. The SecurityFindingType import is type-only (erased at
 * runtime), so context -> weights creates no runtime import cycle. Kept
 * byte-identical to its supabase/functions/_shared twin (parity test enforces).
 */

// ============================================================================
// category weights + coefficients
// ============================================================================

import type { SecurityFindingType } from './security-scanner-edge.context.ts'

/**
 * SMI-4960: category weights — the four shared categories carry core
 * weights.ts CATEGORY_WEIGHTS values. The edge-only `prompt_injection` type has
 * no core equivalent; it is mapped onto core's `ai_defence` (weight 1.9,
 * coefficient 0.12) since both detect AI-injection attacks.
 */
export const CATEGORY_WEIGHTS: Record<SecurityFindingType, number> = {
  jailbreak: 2.0,
  suspicious_pattern: 1.3,
  data_exfiltration: 1.7,
  privilege_escalation: 1.9,
  prompt_injection: 1.9, // mapped to core ai_defence
  // SMI-5359 Wave 4.2c: mirror of core's two new top-tier categories.
  code_execution: 2.0,
  obfuscated_directive: 2.0,
  // SMI-6033 Wave 1: byte-identical to core weights.ts CATEGORY_WEIGHTS.
  sensitive_path: 1.2,
  typosquat: 1.2,
  // SMI-6033 Wave 2: top-tier weight matching code_execution/obfuscated_directive
  // — byte-identical to core weights.ts CATEGORY_WEIGHTS.gatekeeper_bypass /
  // .archive_evasion. The SAME weight is used for both the critical
  // (standalone-quarantining) and medium (advisory) forms of each type;
  // severity alone (SEVERITY_WEIGHTS 50 vs 15) does the two-tier split.
  gatekeeper_bypass: 2.0,
  archive_evasion: 2.0,
  // SMI-6033 Wave 2 (Gap 4): byte-identical to core weights.ts
  // CATEGORY_WEIGHTS.paste_host_fetch — same top-tier weight as
  // gatekeeper_bypass/archive_evasion, for the same reason.
  paste_host_fetch: 2.0,
  // SMI-6033 Wave 2 (Gap 2): byte-identical to core weights.ts
  // CATEGORY_WEIGHTS.encoded_payload — the sensitive_path/typosquat tier
  // (1.2), NOT the 2.0 tier every other Wave 2 category above uses. This
  // wrapper finding is deliberately advisory-only; the escalation comes free
  // from the decoded content's OWN findings (e.g. a decoded `curl|bash`
  // natively trips code_execution at ITS OWN top-tier weight).
  encoded_payload: 1.2,
  // SMI-6033 Wave 4 (Gap 6): byte-identical to core weights.ts
  // CATEGORY_WEIGHTS.decoy_misdirection — same advisory tier as
  // sensitive_path/typosquat/encoded_payload (1.2), NOT the 2.0 tier every
  // other Wave 2/3 category above uses, since this finding type must never
  // be standalone-critical.
  decoy_misdirection: 1.2,
  // SMI-7030: flag-only executable frontmatter (`---js` / `---javascript`
  // opener). Reporting weight only: the paired coefficient below is 0, so this
  // category never contributes to riskScore.
  executable_frontmatter: 1.2,
}

/**
 * SMI-4960: per-category final coefficients — byte-identical to the multipliers
 * in core SecurityScanner.helpers.ts calculateRiskScore. `prompt_injection`
 * uses core's `ai_defence` coefficient (0.12).
 */
export const CATEGORY_COEFFICIENTS: Record<SecurityFindingType, number> = {
  jailbreak: 0.2,
  suspicious_pattern: 0.07, // core suspiciousCode
  data_exfiltration: 0.08,
  privilege_escalation: 0.11,
  prompt_injection: 0.12, // mapped to core ai_defence
  // SMI-5359 Wave 4.2c: additive 0.40 each (mirror of core). One CRITICAL reaches
  // exactly the 40 quarantine threshold: 50 * 2.0 * 1.0 = 100 -> cap 100 -> * 0.40 = 40.
  code_execution: 0.4,
  obfuscated_directive: 0.4,
  // SMI-6033 Wave 1: byte-identical to core SecurityScanner.helpers.ts
  // calculateRiskScore's per-category coefficients — core's "advisory tier"
  // (the same 0.04 core uses for sensitivePaths/externalUrls/ssrf/typosquat).
  sensitive_path: 0.04,
  typosquat: 0.04,
  // SMI-6033 Wave 2: additive 0.40 each (mirror of core), matching
  // code_execution/obfuscated_directive's top tier. A single CRITICAL
  // gatekeeper_bypass/archive_evasion finding reaches exactly the 40
  // quarantine threshold on its own (50 * 2.0 * 1.0 = 100 -> cap 100 -> * 0.40
  // = 40); a single MEDIUM finding contributes 12 — well under threshold alone.
  gatekeeper_bypass: 0.4,
  archive_evasion: 0.4,
  // SMI-6033 Wave 2 (Gap 4): additive 0.40, matching gatekeeper_bypass/
  // archive_evasion — byte-identical to core weights.ts's paired coefficient.
  paste_host_fetch: 0.4,
  // SMI-6033 Wave 2 (Gap 2): additive 0.04 — the sensitive_path/typosquat
  // advisory-tier coefficient, byte-identical to core
  // SecurityScanner.helpers.ts's paired coefficient for encoded_payload.
  encoded_payload: 0.04,
  // SMI-6033 Wave 4 (Gap 6): additive 0.04 — the sensitive_path/typosquat/
  // encoded_payload advisory-tier coefficient, byte-identical to core
  // SecurityScanner.helpers.ts's paired coefficient for decoy_misdirection.
  decoy_misdirection: 0.04,
  // SMI-7030 (owner decision, 2026-10-09): exactly 0. The finding is reported
  // but never moves riskScore, alone or mixed with other findings, so it can
  // never quarantine. Read through calculateRiskScore's `coefficients` param.
  executable_frontmatter: 0,
}
