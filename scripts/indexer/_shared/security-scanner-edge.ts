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
// Patterns - High-risk subset from core SecurityScanner
// ============================================================================

/**
 * Jailbreak attempt patterns - attempts to manipulate AI behavior
 *
 * SMI-4960: `/developer\s+mode/i` required an activation verb (enable / enter /
 * activate / switch to). Bare "developer mode" is browser/VS-Code documentation
 * vocabulary (xixu-me/develop-userscripts FP); only an explicit activation
 * instruction is a jailbreak signal. The remaining patterns mirror core
 * patterns.ts JAILBREAK_PATTERNS (no looser core equivalent exists for these).
 */
const JAILBREAK_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+)?(previous|prior|your)\s+(instructions?|programming)/i,
  /(enable|enter|activate|switch\s+to)\s+developer\s+mode/i,
  /\bDAN\b/,
  /do\s+anything\s+now/i,
  /jailbreak/i,
  /bypass\s+(all\s+)?(restrictions?|filters?|safety)/i,
  /pretend\s+(you\s+)?(are|have)\s+no\s+(restrictions?|limits?)/i,
  /you\s+are\s+now\s+(free|unrestricted|unfiltered)/i,
  /ignore\s+your\s+(safety|ethical)\s+(guidelines?|rules?)/i,
]

/**
 * Suspicious patterns - code execution, shell commands
 */
const SUSPICIOUS_PATTERNS: RegExp[] = [
  /eval\s*\(/i,
  /exec\s*\(/i,
  /child_process/i,
  /\$\(\s*[`'"]/i, // Command substitution
  /base64\s*\.\s*decode/i,
  /subprocess\s*\.\s*(run|call|Popen)/i,
  /os\s*\.\s*(system|popen|exec)/i,
  /\brm\s+-rf\b/i,
  /curl\s+.*\|\s*(bash|sh)/i,
  /wget\s+.*\|\s*(bash|sh)/i,
]

/**
 * Data exfiltration patterns - suspicious data transfer
 *
 * SMI-4960: tightened to core patterns.ts DATA_EXFILTRATION_PATTERNS (SMI-4396
 * Wave 2 forms). The prior `/upload\s+.*(to|the)\s+(server|cloud|remote)/i`
 * matched "upload to Cloudinary" (Cloud prefix substring); the bounded
 * `[\w\s]{0,30}?` + `\bcloud\b` word-boundary excludes
 * Cloudinary/cloudfront/cloudflare/iCloud. The `(send|transmit|leak|dump|steal|
 * extract) … (passwords|credentials|secrets)` form preserves imperative
 * exfiltration coverage without re-introducing prose FPs.
 */
const DATA_EXFILTRATION_PATTERNS: RegExp[] = [
  /navigator\.sendBeacon/i,
  /webhook\s*[=:]/i,
  /exfil/i,
  /send\s+.*(to|the)\s+(external|remote)/i,
  /upload\s+[\w\s]{0,30}?\s*(?:to|the)\s+(?:server|\bcloud\b|remote)/i,
  /upload\s+[\w\s]{0,50}?\s*(?:private\s+)?(?:key|secret|credential|token)s?\b/i,
  /post\s+data\s+to/i,
  /to\s+external\s+(api|server|endpoint)/i,
  /(?:send|transmit|leak|dump|steal|extract)\s+[\w\s']{0,40}(?:passwords?|credentials?|secrets?)\b/i,
]

/**
 * Privilege escalation patterns
 *
 * SMI-4960: tightened to core patterns.ts PRIVILEGE_ESCALATION_PATTERNS (SMI-4396
 * Wave 2 forms). The prior bare `/escalat(e|ion)/i` matched documentation prose
 * in security-research / prompt-injection-scanner skills that enumerate
 * "privilege escalation" as a technique they DETECT. Replaced with contextual
 * variants (exploit-escalate, attack/vector noun phrases, to-root/to-admin
 * targets) that preserve real coverage.
 */
const PRIVILEGE_ESCALATION_PATTERNS: RegExp[] = [
  /sudo\s+.*(-S|--stdin)/i,
  /echo\s+.*\|\s*sudo/i,
  /sudo\s+-S/i,
  /\bchmod\s+[0-7]*[4-7][0-7][0-7]\b/i,
  /\bchmod\s+\+s\b/i,
  /\bchmod\s+777\b/i,
  /\bchmod\s+666\b/i,
  /\bchown\s+root/i,
  /\bchgrp\s+root/i,
  /visudo/i,
  /\/etc\/sudoers/i,
  /NOPASSWD/i,
  /setuid/i,
  /setgid/i,
  /capability\s+cap_/i,
  /privilege[_\s-]+escalat(?:e|ion)/i,
  /escalat(?:e|ion)\s+(?:attack|vector|(?:to|as)\s+(?:root|admin|superuser))/i,
  /exploit\s+[\w\s]{0,30}?\s*escalat(?:e|ion)/i,
  /privilege[ds]?\s+(elevat|escal)/i,
  /run\s+.*as\s+root/i,
  /(run|execute)\s+as\s+(root|admin)/i,
  /admin(istrator)?\s+access/i,
  /root\s+(access|user)/i,
  /as\s+root\s+user/i,
  /su\s+-\s+root/i,
  /become\s+root/i,
]

/**
 * Prompt injection patterns - AI-specific attacks
 */
const PROMPT_INJECTION_PATTERNS: RegExp[] = [
  // Role injection
  /(?:^|\s)(?:system|assistant|user)\s*:\s*(?:\n|$)/i,
  // Hidden instruction brackets
  /\[\[\s*[^\]]{1,200}\s*\]\]/,
  // HTML comment injection
  /<!--[\s\S]{0,100}?(?:ignore|override|bypass|system|instruction)[\s\S]{0,100}?-->/i,
  // Prompt structure manipulation
  /<\/?(?:system|prompt|instruction|context|message)(?:\s[^>]*)?>/i,
  // Delimiter injection
  /(?:^|\n)(?:---|\*{3}|#{3,})\s*(?:system|prompt|instruction|override)/i,
  // JSON structure injection
  /["']\s*(?:role|system|instruction)\s*["']\s*:\s*["'](?:system|assistant|user|ignore|override|bypass)/i,
]

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
          severity: inDocContext ? 'medium' : 'high',
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
