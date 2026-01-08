/**
 * SMI-1189: Skill Scanner Types
 *
 * Type definitions for the security scanner script.
 */

import type { ScanReport, SecurityFinding, SecuritySeverity } from '../../security/index.js'

/**
 * Structure of an imported skill in imported-skills.json
 */
export interface ImportedSkill {
  id: string
  name: string
  description?: string
  author?: string
  content?: string
  repo_url?: string
  source?: string
  tags?: string[]
  instructions?: string
  trigger?: string
  metadata?: Record<string, unknown>
}

/**
 * Severity categories for output organization
 */
export type SeverityCategory = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'

/**
 * Skill scan result with categorization
 */
export interface SkillScanResult {
  skillId: string
  skillName: string
  author: string
  source: string
  scanReport: ScanReport
  severityCategory: SeverityCategory
  isQuarantined: boolean
  scanTimestamp: string
}

/**
 * Full security report output structure
 */
export interface SecurityReportOutput {
  scanDate: string
  inputFile: string
  summary: {
    totalScanned: number
    passed: number
    quarantined: number
    bySeverity: Record<SeverityCategory, number>
    averageRiskScore: number
    maxRiskScore: number
  }
  results: SkillScanResult[]
  topFindings: Array<{
    type: string
    count: number
    severity: SecuritySeverity
  }>
}

/**
 * Quarantine list output structure
 */
export interface QuarantineOutput {
  generatedAt: string
  reason: string
  count: number
  skills: Array<{
    skillId: string
    skillName: string
    author: string
    riskScore: number
    severityCategory: SeverityCategory
    topFindings: string[]
  }>
}

/**
 * Safe skills list output structure
 */
export interface SafeSkillsOutput {
  generatedAt: string
  count: number
  skills: Array<{
    skillId: string
    skillName: string
    author: string
    source: string
    riskScore: number
  }>
}

/**
 * Finding with skill context
 */
export interface FindingWithContext extends SecurityFinding {
  skillId: string
}

// Re-export security types for convenience
export type { ScanReport, SecurityFinding, SecuritySeverity }
