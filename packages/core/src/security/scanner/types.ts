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

/**
 * Severity levels for security findings
 */
export type SecuritySeverity = 'low' | 'medium' | 'high' | 'critical'

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
 * Configuration options for the security scanner
 */
export interface ScannerOptions {
  allowedDomains?: string[]
  blockedPatterns?: RegExp[]
  maxContentLength?: number
  /** Risk score threshold for failing a scan (default: 40) */
  riskThreshold?: number
}
