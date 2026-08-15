/**
 * Security Scanner Weights - SMI-685, SMI-1189
 *
 * Weight constants for risk score calculation.
 */

import type { SecurityFindingType, SecuritySeverity } from './types.js'

/**
 * Severity weights for risk score calculation
 */
export const SEVERITY_WEIGHTS: Record<SecuritySeverity, number> = {
  low: 5,
  medium: 15,
  high: 30,
  critical: 50,
}

/**
 * Category weights for risk score calculation.
 *
 * SMI-6033 Wave 2 gap-closing pass: typed against `SecurityFindingType`
 * (was `Record<string, number>`) so a future new finding type that ships
 * without a weight entry here is a TypeScript compile error, not a silent
 * runtime `?? 1.0` fallback in SecurityScanner.helpers.ts's
 * `calculateRiskScore` — the exact class of gap
 * scripts/tests/indexer/parity.test.ts's new consolidated core<->edge
 * coverage test (SMI-6033 Wave 2) was added to catch on the edge side; this
 * closes the equivalent hole on the core side, one layer earlier.
 */
export const CATEGORY_WEIGHTS: Record<SecurityFindingType, number> = {
  jailbreak: 2.0,
  social_engineering: 1.5,
  prompt_leaking: 1.8,
  data_exfiltration: 1.7,
  privilege_escalation: 1.9,
  suspicious_pattern: 1.3,
  sensitive_path: 1.2,
  url: 0.8,
  ai_defence: 1.9, // SMI-1532: High weight for AI injection attacks
  ssrf: 1.6, // SMI-3509: SSRF instruction detection
  pii: 1.8, // SMI-3864: PII in skill content is high-risk
  // SMI-5359 Wave 4.2: remote-fetch-to-interpreter and concealed directives are
  // top-tier risks. Paired with a 0.40 coefficient in calculateRiskScore, a single
  // CRITICAL finding in either category reaches exactly the 40 quarantine threshold
  // on its own (50 * 2.0 * 1.0 = 100 -> capped 100 -> * 0.40 = 40).
  code_execution: 2.0,
  obfuscated_directive: 2.0,
  // SMI-595: a naming-similarity heuristic is advisory, not damning on its own —
  // deliberately the same tier as sensitive_path/url, NOT the 1.7-2.0 tier used
  // for jailbreak/exfiltration-class findings. Paired with the 0.04 coefficient
  // in calculateRiskScore (the same coefficient already used for
  // sensitivePaths/externalUrls/ssrf): a single medium-severity, high-confidence
  // finding scores 15 * 1.2 * 1.0 = 18 -> contributes 18 * 0.04 = 0.72 (rounds to
  // ~1) to the total; a saturated breakdown (capped at 100) contributes 4 —
  // comfortably under the riskThreshold: 40 quarantine cutoff on its own. See the
  // stacked-risk test in SecurityScanner.scoring.test.ts.
  typosquat: 1.2,
  // SMI-6033 Wave 2 (Gap 5/Gap 3): top-tier weight matching code_execution/
  // obfuscated_directive — the SAME single weight is used for both the
  // critical (standalone-quarantining) and medium (advisory, co-signal-
  // eligible) forms of each type; severity alone (SEVERITY_WEIGHTS 50 vs 15)
  // does the two-tier split, exactly as scanChmodFetchCompound's own
  // privilege_escalation compound signal already does with ONE weight
  // (1.9/0.11) across its high/low severities. Paired with the 0.40
  // coefficient in calculateRiskScore: a single CRITICAL finding reaches
  // exactly the 40 quarantine threshold on its own (50 * 2.0 * 1.0 = 100 ->
  // capped 100 -> * 0.40 = 40); a single MEDIUM finding contributes 12
  // (15 * 2.0 * 1.0 = 30 -> * 0.40 = 12) — well under threshold alone.
  gatekeeper_bypass: 2.0,
  archive_evasion: 2.0,
  // SMI-6033 Wave 2 (Gap 4): same top-tier weight as gatekeeper_bypass/
  // archive_evasion, for the same reason — a paste-host URL that is the
  // TARGET of a fetch command reaches exactly the 40 quarantine threshold
  // standalone (50 * 2.0 * 1.0 = 100 -> capped 100 -> * 0.40 = 40), while a
  // paste-host URL that is merely linked never reaches this detector at all
  // (see SecurityScanner.paste-host.ts) and stays covered by the existing
  // url:medium finding instead.
  paste_host_fetch: 2.0,
  // SMI-6033 Wave 2 (Gap 2): the sensitive_path/typosquat tier (1.2/0.04 —
  // NOT the 2.0/0.40 tier every other Wave 2 detector above uses). This
  // detector's wrapper finding is deliberately advisory-only: the escalation
  // Gap 2 achieves comes for free from the decoded content's OWN findings
  // (e.g. a decoded `curl|bash` natively trips code_execution at ITS OWN
  // top-tier weight), not from encoded_payload itself. A single medium,
  // high-confidence finding scores 15 * 1.2 * 1.0 = 18 -> * 0.04 = 0.72
  // (rounds to ~1); a saturated breakdown (capped at 100) contributes 4 —
  // comfortably under the riskThreshold: 40 quarantine cutoff on its own.
  encoded_payload: 1.2,
}
