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
 * Configuration options for the security scanner
 */
export interface ScannerOptions {
  allowedDomains?: string[]
  blockedPatterns?: RegExp[]
  maxContentLength?: number
  /** Risk score threshold for failing a scan (default: 40) */
  riskThreshold?: number
}
