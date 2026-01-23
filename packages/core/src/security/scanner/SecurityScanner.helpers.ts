/**
 * Security Scanner Helper Functions
 * @module @skillsmith/core/security/scanner/SecurityScanner.helpers
 */

import type { SecurityFinding, RiskScoreBreakdown, FindingConfidence } from './types.js'
import { SEVERITY_WEIGHTS, CATEGORY_WEIGHTS } from './weights.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Context information for each line in markdown content
 */
export interface LineContext {
  lineNumber: number
  inCodeBlock: boolean
  inTable: boolean
  isIndentedCode: boolean
  isInlineCode: boolean
}

// ============================================================================
// Pattern Helpers
// ============================================================================

/**
 * SMI-1532: Check if a regex pattern requires multi-line matching
 * Patterns that contain newline/carriage-return characters or start with
 * multi-line anchors need to be tested against full content, not line-by-line.
 */
export function isMultilinePattern(pattern: RegExp): boolean {
  const patternStr = pattern.source
  return (
    patternStr.includes('\\r') || patternStr.includes('\\n') || patternStr.startsWith('(?:^|\\n)')
  )
}

// ============================================================================
// Markdown Context Analysis
// ============================================================================

/**
 * Analyze markdown content and return context for each line
 * Used to reduce false positives in documentation/examples
 */
export function analyzeMarkdownContext(content: string): LineContext[] {
  const lines = content.split('\n')
  const contexts: LineContext[] = []
  let inFencedCodeBlock = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmedLine = line.trim()

    // Check for fenced code block boundaries (``` or ~~~)
    if (/^(`{3,}|~{3,})/.test(trimmedLine)) {
      inFencedCodeBlock = !inFencedCodeBlock
    }

    // Check for table row (starts with |)
    const inTable = trimmedLine.startsWith('|')

    // Check for indented code block (4+ spaces or tab at start, not in list)
    const isIndentedCode =
      /^( {4,}|\t)/.test(line) &&
      !inFencedCodeBlock &&
      !trimmedLine.startsWith('-') &&
      !trimmedLine.startsWith('*')

    // Check for inline code (content between backticks on same line)
    const isInlineCode = /`[^`]+`/.test(line) && !inFencedCodeBlock

    contexts.push({
      lineNumber: i + 1,
      inCodeBlock: inFencedCodeBlock,
      inTable,
      isIndentedCode,
      isInlineCode,
    })
  }

  return contexts
}

/**
 * Check if a line is in a documentation context (code block, table, example)
 */
export function isDocumentationContext(ctx: LineContext): boolean {
  return ctx.inCodeBlock || ctx.inTable || ctx.isIndentedCode
}

// ============================================================================
// Risk Score Calculation
// ============================================================================

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

  const total = Math.min(
    100,
    Math.round(
      breakdown.jailbreak * 0.22 +
        breakdown.socialEngineering * 0.12 +
        breakdown.promptLeaking * 0.12 +
        breakdown.dataExfiltration * 0.1 +
        breakdown.privilegeEscalation * 0.11 +
        breakdown.suspiciousCode * 0.08 +
        breakdown.sensitivePaths * 0.05 +
        breakdown.externalUrls * 0.05 +
        breakdown.aiDefence * 0.15
    )
  )

  return { total, breakdown }
}
