/**
 * Security Scanner Types - SMI-587, SMI-685, SMI-1189
 *
 * Type definitions for security scanning functionality.
 */

/**
 * Types of security findings that can be detected
 */
export type SecurityFindingType =
  | 'url'
  | 'sensitive_path'
  | 'jailbreak'
  | 'suspicious_pattern'
  | 'social_engineering'
  | 'prompt_leaking'
  | 'data_exfiltration'
  | 'privilege_escalation'
  | 'ai_defence' // SMI-1532: CVE-hardened AI injection detection
  | 'ssrf' // SMI-3509: SSRF instruction detection
  | 'pii' // SMI-3864: PII detection
  | 'code_execution' // SMI-5359 Wave 4.2: remote-fetch piped to an interpreter
  | 'obfuscated_directive' // SMI-5359 Wave 4.2: security directive concealed via Unicode obfuscation
  | 'typosquat' // SMI-595: skill-name similarity to a popular/trusted reference name
  | 'gatekeeper_bypass' // SMI-6033 Wave 2 (Gap 5): xattr strips the macOS Gatekeeper quarantine attribute
  | 'archive_evasion' // SMI-6033 Wave 2 (Gap 3): password-protected archive used to evade content scanning
  | 'paste_host_fetch' // SMI-6033 Wave 2 (Gap 4): anonymous paste/snippet-host URL is the target of a fetch command
  | 'encoded_payload' // SMI-6033 Wave 2 (Gap 2): base64-encoded blob decoded and recursively rescanned

/**
 * Severity levels for security findings
 */
export type SecuritySeverity = 'low' | 'medium' | 'high' | 'critical'

/**
 * Confidence level for a finding
 * - high: Strong indicator of malicious intent
 * - medium: Possible issue, context suggests caution
 * - low: Likely false positive (e.g., in documentation/examples)
 */
export type FindingConfidence = 'high' | 'medium' | 'low'

/**
 * SMI-5876: evidence tier behind a jailbreak/ai_defence finding. A pattern is
 * `mention`-tier iff its matched text, read in isolation, instructs nothing
 * (a bare noun/name/label/structural marker/payload-free obfuscation
 * artifact). Anything with a verb+object pairing or a second-person
 * predicate is directive-tier.
 *
 * - `mention`                — payload-free vocabulary (e.g. bare `jailbreak`,
 *   `DAN`, `developer mode`, a bare role marker with no body).
 * - `role_turn_with_body`    — a fabricated conversation-turn boundary WITH an
 *   instructing body (e.g. a role marker followed by a directive, or a
 *   `<instruction>...</instruction>` block with content).
 * - `imperative_instruction` — a second-person directive without an explicit
 *   "override prior instructions" framing (e.g. "pretend you have no
 *   restrictions").
 * - `instruction_override`   — an explicit "ignore/disregard/override prior
 *   instructions" directive.
 * - `state_assertion`        — a DECLARATIVE assertion that a jailbroken/
 *   unrestricted state is active, with no verb/frame aimed at the model
 *   (e.g. "Jailbreak activated", "DAN mode enabled", "Developer mode: ON.
 *   Restrictions: OFF"). Distinct machine-readable reason code from
 *   `imperative_instruction` (the design REJECTED aimed-at-the-model framing
 *   as a requirement here — a state assertion is evidence of an already-
 *   completed jailbreak, not a request), but carries the SAME severity tuple
 *   (critical non-doc / high doc) — see `EVIDENCE_SEVERITY_TABLE`.
 *
 * See `SecurityScanner.evidence.ts` for how this maps to severity/confidence,
 * and `patterns.jailbreak.evidence.ts`'s `EVIDENCE_TYPE_BY_PATTERN` for the
 * per-pattern classification.
 */
export type EvidenceType =
  | 'mention'
  | 'role_turn_with_body'
  | 'imperative_instruction'
  | 'instruction_override'
  | 'state_assertion'

/**
 * Individual security finding from a scan
 */
export interface SecurityFinding {
  type: SecurityFindingType
  severity: SecuritySeverity
  message: string
  location?: string
  lineNumber?: number
  /** Category for grouping related findings */
  category?: string
  /** Whether finding is in a documentation context (code block, table, example) */
  inDocumentationContext?: boolean
  /** Confidence level - lower for findings in documentation context */
  confidence?: FindingConfidence
  /** SMI-5436: Path of the skill bundle file that triggered this finding, relative to the skill root. Absent for SKILL.md-only findings. */
  filePath?: string
  /** SMI-5876: machine-readable evidence class behind this finding (jailbreak/ai_defence only). */
  evidenceType?: EvidenceType
  /** SMI-5876: a mention-tier finding lifted by a co-occurring non-documentation high/critical signal. */
  corroborated?: boolean
  /**
   * SMI-6033 Wave 2 (Gap 2): the OUTER document line number of the base64
   * blob whose decoded content produced this finding — set ONLY on findings
   * folded in by `scanEncodedPayload`'s recursive rescan. Same provenance-
   * marker role `filePath` plays for a sibling-file finding, but for a
   * decoded-blob origin within the SAME document rather than a different
   * file. Absent for every other finding.
   */
  decodedFrom?: number
}

/**
 * Risk score breakdown by category
 */
export interface RiskScoreBreakdown {
  jailbreak: number
  socialEngineering: number
  promptLeaking: number
  dataExfiltration: number
  privilegeEscalation: number
  suspiciousCode: number
  sensitivePaths: number
  externalUrls: number
  aiDefence: number // SMI-1532: AI injection detection score
  ssrf: number // SMI-3509: SSRF instruction detection score
  pii: number // SMI-3864: PII detection score
  codeExecution: number // SMI-5359 Wave 4.2: remote-fetch-to-interpreter score
  obfuscatedDirective: number // SMI-5359 Wave 4.2: concealed-directive score
  typosquat: number // SMI-595: typosquat/impersonation detection score
  gatekeeperBypass: number // SMI-6033 Wave 2 (Gap 5): xattr Gatekeeper-bypass score
  archiveEvasion: number // SMI-6033 Wave 2 (Gap 3): password-protected archive evasion score
  pasteHostFetch: number // SMI-6033 Wave 2 (Gap 4): paste-host fetch-target score
  encodedPayload: number // SMI-6033 Wave 2 (Gap 2): base64 decode-and-rescan wrapper-finding score
}

/**
 * Comprehensive scan report with risk scoring
 */
export interface ScanReport {
  skillId: string
  passed: boolean
  findings: SecurityFinding[]
  scannedAt: Date
  scanDurationMs: number
  /** Overall risk score from 0-100 (0 = safe, 100 = extremely dangerous) */
  riskScore: number
  /** Breakdown of risk score by category */
  riskBreakdown: RiskScoreBreakdown
}

/**
 * Verdict returned by comparing two scans of the SAME skill to detect a
 * benign→malicious "rug-pull" update (SMI-5535, R0 Wave 2A).
 *
 * - `hostile`    — a previously-passing skill introduced new high/critical
 *   findings (or crossed the risk threshold): a genuine benign→malicious flip.
 * - `suspicious` — the update added new medium findings or a material risk
 *   increase, but did not meet the hostile bar (also covers an already-flagged
 *   skill that got materially worse, which is a worsening — not a new rug-pull).
 * - `benign`     — no new high/critical findings and no threshold crossing;
 *   findings are unchanged, reduced, or only benign churn.
 */
export interface HostileUpdateVerdict {
  verdict: 'benign' | 'suspicious' | 'hostile'
  /** Findings present in the current scan but absent from the previous scan. */
  newFindings: SecurityFinding[]
  /** `current.riskScore - previous.riskScore` (positive = riskier). */
  riskDelta: number
  /** One concrete human-readable sentence citing the deciding signal. */
  reason: string
}

/**
 * SMI-595: Rollout mode for the typosquat detector.
 * - `off`   — detector output is discarded entirely (no findings surface).
 * - `warn`  — shadow mode (default): findings surface but are capped at
 *   `medium` severity regardless of the raw detector's confidence, so a
 *   false positive on this early-stage heuristic can't alone quarantine
 *   an install.
 * - `block` — findings surface at their raw (uncapped) severity.
 */
export type TyposquatEnforcementMode = 'off' | 'warn' | 'block'

/**
 * Configuration options for the security scanner
 */
export interface ScannerOptions {
  allowedDomains?: string[]
  blockedPatterns?: RegExp[]
  maxContentLength?: number
  /** Risk score threshold for failing a scan (default: 40) */
  riskThreshold?: number
  /** SMI-595: typosquat detector enforcement mode (default: 'warn'). */
  typosquatEnforcementMode?: TyposquatEnforcementMode
}
