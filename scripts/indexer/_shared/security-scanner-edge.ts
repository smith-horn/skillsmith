/**
 * SMI-2272: Edge-compatible Security Scanner
 * @module scripts/indexer/_shared/security-scanner-edge (Node port)
 *
 * Node port of the Deno edge scanner; byte-identical body (parity test enforces).
 * Extracts pattern matching logic from @skillsmith/core SecurityScanner
 * to detect high-risk patterns in SKILL.md content.
 *
 * Design decisions:
 * - No Node.js dependencies (pure Deno/Web APIs)
 * - Focused on high-risk patterns (jailbreak, eval, data exfiltration)
 * - ReDoS protection via input length limits
 * - Content hash generation for change detection
 *
 * SMI-4960: Ported core's context + confidence model so this prod quarantine
 * gate stops auto-quarantining documentation prose / frontmatter / tables /
 * fenced examples / quoted-attack-in-defense strings. A single match in a
 * documentation context is now a low-confidence finding (0.3x weight) and the
 * scoring matches @skillsmith/core's category-coefficient model — so a lone
 * isolated finding can no longer crest the 40 quarantine threshold by itself,
 * while a pattern-saturated malicious skill (multiple high-confidence findings
 * OUTSIDE any doc context) still quarantines. The context model + scoring live
 * in ./security-scanner-edge.context.ts (split out for the 500-line limit).
 */

import type { SecurityFinding, LineContext } from './security-scanner-edge.context.ts'
import {
  analyzeMarkdownContext,
  classifyMatch,
  calculateRiskScore,
} from './security-scanner-edge.context.ts'
// SMI-5359 Wave 4.2c: code_execution + obfuscated_directive detectors (mirror of
// core SecurityScanner.exec.ts). Split into a sibling to stay under the 500-line
// limit; byte-identical body across both _shared twins.
import {
  scanCodeExecution,
  scanObfuscatedDirective,
  escalateCodeExecution,
} from './security-scanner-edge.exec.ts'

// SMI-5402: the five high-risk pattern arrays were extracted to a sibling twin
// (500-line limit); byte-identical body across both _shared twins (parity test).
import {
  JAILBREAK_PATTERNS,
  SUSPICIOUS_PATTERNS,
  DATA_EXFILTRATION_PATTERNS,
  PRIVILEGE_ESCALATION_PATTERNS,
  PROMPT_INJECTION_PATTERNS,
} from './security-scanner-edge.patterns.ts'

// SMI-4960: re-export the context model + finding types so existing consumers
// and the parity tests keep importing them from this module.
export type {
  SecurityFindingType,
  SecuritySeverity,
  FindingConfidence,
  SecurityFinding,
  LineContext,
} from './security-scanner-edge.context.ts'
export {
  analyzeMarkdownContext,
  isDocumentationContext,
  isWithinInlineCode,
  isInsideCodeBlock,
} from './security-scanner-edge.context.ts'

// ============================================================================
// Constants + Result Type
// ============================================================================

/**
 * ReDoS protection: maximum line length for regex matching
 */
const MAX_LINE_LENGTH = 10000

/**
 * Risk score threshold for quarantine (skills >= this are flagged)
 */
export const QUARANTINE_THRESHOLD = 40

/**
 * Scan result from the edge scanner
 */
export interface EdgeScanResult {
  passed: boolean
  riskScore: number
  findings: SecurityFinding[]
  contentHash: string
  scannedAt: string
  scanDurationMs: number
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Safe regex test with length limit to prevent ReDoS
 */
function safeRegexTest(pattern: RegExp, input: string): RegExpMatchArray | null {
  const safeInput = input.length > MAX_LINE_LENGTH ? input.slice(0, MAX_LINE_LENGTH) : input
  return safeInput.match(pattern)
}

/**
 * Generate SHA-256 hash of content for change detection
 */
export async function generateContentHash(content: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(content)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ============================================================================
// Scanner Implementation
// ============================================================================

/**
 * Scan content for jailbreak patterns
 * SMI-4960: documentation-context matches downgrade to low confidence.
 */
function scanJailbreakPatterns(lines: string[], contexts: LineContext[]): SecurityFinding[] {
  const findings: SecurityFinding[] = []

  for (const [index, line] of lines.entries()) {
    for (const pattern of JAILBREAK_PATTERNS) {
      const match = safeRegexTest(pattern, line)
      if (match) {
        const { inDocContext, confidence } = classifyMatch(contexts[index], line, match.index ?? 0)
        findings.push({
          type: 'jailbreak',
          severity: inDocContext ? 'high' : 'critical',
          message: `Jailbreak pattern detected: "${match[0].slice(0, 50)}"`,
          lineNumber: index + 1,
          location: line.trim().slice(0, 100),
          inDocumentationContext: inDocContext,
          confidence,
        })
        break // One finding per line
      }
    }
  }

  return findings
}

/**
 * Scan content for suspicious patterns
 * SMI-4960: documentation-context matches downgrade to low confidence.
 */
function scanSuspiciousPatterns(lines: string[], contexts: LineContext[]): SecurityFinding[] {
  const findings: SecurityFinding[] = []

  for (const [index, line] of lines.entries()) {
    for (const pattern of SUSPICIOUS_PATTERNS) {
      const match = safeRegexTest(pattern, line)
      if (match) {
        const { inDocContext, confidence } = classifyMatch(contexts[index], line, match.index ?? 0)
        findings.push({
          type: 'suspicious_pattern',
          severity: inDocContext ? 'low' : 'medium',
          message: `Suspicious pattern detected: "${match[0].slice(0, 50)}"`,
          lineNumber: index + 1,
          location: line.trim().slice(0, 100),
          inDocumentationContext: inDocContext,
          confidence,
        })
        break
      }
    }
  }

  return findings
}

/**
 * Scan content for data exfiltration patterns
 * SMI-4960: documentation-context matches downgrade to low confidence.
 */
function scanDataExfiltration(lines: string[], contexts: LineContext[]): SecurityFinding[] {
  const findings: SecurityFinding[] = []

  for (const [index, line] of lines.entries()) {
    for (const pattern of DATA_EXFILTRATION_PATTERNS) {
      const match = safeRegexTest(pattern, line)
      if (match) {
        const { inDocContext, confidence } = classifyMatch(contexts[index], line, match.index ?? 0)
        findings.push({
          type: 'data_exfiltration',
          severity: inDocContext ? 'medium' : 'high',
          message: `Data exfiltration pattern: "${match[0].slice(0, 50)}"`,
          lineNumber: index + 1,
          location: line.trim().slice(0, 100),
          inDocumentationContext: inDocContext,
          confidence,
        })
        break
      }
    }
  }

  return findings
}

/**
 * Scan content for privilege escalation patterns
 * SMI-4960: documentation-context matches downgrade to low confidence.
 */
function scanPrivilegeEscalation(lines: string[], contexts: LineContext[]): SecurityFinding[] {
  const findings: SecurityFinding[] = []

  for (const [index, line] of lines.entries()) {
    for (const pattern of PRIVILEGE_ESCALATION_PATTERNS) {
      const match = safeRegexTest(pattern, line)
      if (match) {
        const { inDocContext, confidence } = classifyMatch(contexts[index], line, match.index ?? 0)
        findings.push({
          type: 'privilege_escalation',
          severity: inDocContext ? 'high' : 'critical',
          message: `Privilege escalation pattern: "${match[0].slice(0, 50)}"`,
          lineNumber: index + 1,
          location: line.trim().slice(0, 100),
          inDocumentationContext: inDocContext,
          confidence,
        })
        break
      }
    }
  }

  return findings
}

/**
 * Scan content for prompt injection patterns
 * SMI-4960: documentation-context matches downgrade to low confidence.
 */
function scanPromptInjection(lines: string[], contexts: LineContext[]): SecurityFinding[] {
  const findings: SecurityFinding[] = []

  for (const [index, line] of lines.entries()) {
    for (const pattern of PROMPT_INJECTION_PATTERNS) {
      const match = safeRegexTest(pattern, line)
      if (match) {
        const { inDocContext, confidence } = classifyMatch(contexts[index], line, match.index ?? 0)
        findings.push({
          type: 'prompt_injection',
          severity: inDocContext ? 'high' : 'critical',
          message: `Prompt injection pattern: "${match[0].slice(0, 50)}"`,
          lineNumber: index + 1,
          location: line.trim().slice(0, 100),
          inDocumentationContext: inDocContext,
          confidence,
        })
        break
      }
    }
  }

  return findings
}

// ============================================================================
// Main Scanner Function
// ============================================================================

/**
 * Scan SKILL.md content for security issues
 *
 * @param content - The SKILL.md content to scan
 * @returns EdgeScanResult with findings, risk score, and content hash
 */
export async function scanSkillContent(content: string): Promise<EdgeScanResult> {
  const startTime = performance.now()
  const findings: SecurityFinding[] = []

  // SMI-2408: Split once, pass to all scanners to avoid 5x redundant splitting
  const lines = content.split('\n')
  // SMI-4960: compute markdown context once and thread it through all scanners.
  const contexts = analyzeMarkdownContext(content)

  // Run all scanners
  findings.push(...scanJailbreakPatterns(lines, contexts))
  findings.push(...scanSuspiciousPatterns(lines, contexts))
  findings.push(...scanDataExfiltration(lines, contexts))
  findings.push(...scanPrivilegeEscalation(lines, contexts))
  findings.push(...scanPromptInjection(lines, contexts))
  // SMI-5359 Wave 4.2c: remote-fetch-to-interpreter + Unicode-concealed directives.
  findings.push(...scanCodeExecution(lines, contexts))
  findings.push(...scanObfuscatedDirective(lines))
  // Promote code_execution to critical when it co-occurs with a non-doc
  // exfil/privilege/obfuscation signal (runs after every detector).
  escalateCodeExecution(findings)

  // Calculate risk score
  const riskScore = calculateRiskScore(findings)

  // Generate content hash for change detection
  const contentHash = await generateContentHash(content)

  const endTime = performance.now()

  // SMI-4960: `passed` is informational only. Quarantine is decided SOLELY by
  // `shouldQuarantine` (riskScore >= QUARANTINE_THRESHOLD). `passed` mirrors
  // core's report semantics (no critical/high finding AND under threshold) but
  // is NOT consulted by the quarantine gate — an otherwise-clean skill whose
  // only finding is a downgraded doc-context match still clears
  // shouldQuarantine().
  const hasCritical = findings.some((f) => f.severity === 'critical')
  const hasHigh = findings.some((f) => f.severity === 'high')
  const passed = !hasCritical && !hasHigh && riskScore < QUARANTINE_THRESHOLD

  return {
    passed,
    riskScore,
    findings,
    contentHash,
    scannedAt: new Date().toISOString(),
    scanDurationMs: endTime - startTime,
  }
}

/**
 * Quick check for critical patterns only (fast path)
 * Use this for quick rejection before full scan
 *
 * SMI-2391: Split content into lines before testing. Previously passed entire
 * content as a single string to safeRegexTest, which truncates at MAX_LINE_LENGTH
 * (10KB). Content after 10KB was never scanned, allowing jailbreak patterns
 * placed after that offset to bypass detection.
 *
 * @param content - Content to check
 * @returns true if content appears safe, false if critical pattern found
 */
export function quickSecurityCheck(content: string): boolean {
  const lines = content.split('\n')
  for (const line of lines) {
    for (const pattern of JAILBREAK_PATTERNS) {
      if (safeRegexTest(pattern, line)) {
        return false
      }
    }
  }
  return true
}

/**
 * Check if a skill should be quarantined based on scan result
 *
 * SMI-4960: quarantine is purely score-driven — riskScore >= QUARANTINE_THRESHOLD
 * (40). This is the single prod quarantine gate; it does not consult `passed`.
 */
export function shouldQuarantine(scanResult: EdgeScanResult): boolean {
  return scanResult.riskScore >= QUARANTINE_THRESHOLD
}

/**
 * SMI-2384: Create a concise human-readable summary of security findings.
 *
 * Groups findings by type and lists each with its line number (if available).
 * Output is capped at `maxFindings` entries to keep the summary brief.
 *
 * @param findings - Array of SecurityFinding objects from a scan
 * @param maxFindings - Maximum number of individual findings to list (default 5)
 * @returns A summary string, or empty string if there are no findings
 */
export function summarizeFindings(findings: SecurityFinding[], maxFindings = 5): string {
  if (findings.length === 0) {
    return ''
  }

  const listed = findings.slice(0, maxFindings)
  const parts = listed.map((f) => {
    const location = f.lineNumber ? ` (line ${f.lineNumber})` : ''
    return `${f.type}${location}`
  })

  let summary = `Patterns found: ${parts.join(', ')}`
  if (findings.length > maxFindings) {
    summary += `, and ${findings.length - maxFindings} more`
  }

  return summary
}
