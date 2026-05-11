/**
 * Security scanner (Node port)
 * @module scripts/indexer/_shared/security-scanner-edge
 *
 * SMI-4852: Node-flavored sibling of `supabase/functions/_shared/security-scanner-edge.ts`.
 * Pure analysis logic — uses Web Crypto + standard regex/string APIs available
 * globally on Node 22. No fetches; byte-identical to the Deno parent. Parity
 * guarded by `scripts/indexer/tests/parity.test.ts`.
 *
 * SMI-2272: Lightweight security scanner for high-risk pattern detection
 * (jailbreak, eval, data exfiltration). ReDoS protection via input length limits.
 * Content hash generation for change detection.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Types of security findings
 */
export type SecurityFindingType =
  | 'jailbreak'
  | 'suspicious_pattern'
  | 'data_exfiltration'
  | 'privilege_escalation'
  | 'prompt_injection'

/**
 * Severity levels for findings
 */
export type SecuritySeverity = 'low' | 'medium' | 'high' | 'critical'

/**
 * Individual security finding
 */
export interface SecurityFinding {
  type: SecurityFindingType
  severity: SecuritySeverity
  message: string
  lineNumber?: number
  location?: string
}

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
// Constants
// ============================================================================

/**
 * ReDoS protection: maximum line length for regex matching
 */
const MAX_LINE_LENGTH = 10000

/**
 * Risk score threshold for quarantine (skills >= this are flagged)
 */
export const QUARANTINE_THRESHOLD = 40

// ============================================================================
// Patterns - High-risk subset from core SecurityScanner
// ============================================================================

/**
 * Jailbreak attempt patterns - attempts to manipulate AI behavior
 */
const JAILBREAK_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+)?(previous|prior|your)\s+(instructions?|programming)/i,
  /developer\s+mode/i,
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
 */
const DATA_EXFILTRATION_PATTERNS: RegExp[] = [
  /navigator\.sendBeacon/i,
  /webhook\s*[=:]/i,
  /exfil/i,
  /send\s+.*(to|the)\s+(external|remote)/i,
  /upload\s+.*(to|the)\s+(server|cloud|remote)/i,
  /post\s+data\s+to/i,
  /to\s+external\s+(api|server|endpoint)/i,
]

/**
 * Privilege escalation patterns
 */
const PRIVILEGE_ESCALATION_PATTERNS: RegExp[] = [
  /sudo\s+-S/i,
  /echo\s+.*\|\s*sudo/i,
  /\bchmod\s+777\b/i,
  /\bchmod\s+\+s\b/i,
  /\/etc\/sudoers/i,
  /NOPASSWD/i,
  /escalat(e|ion)/i,
  /(run|execute)\s+as\s+(root|admin)/i,
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
// Severity Weights
// ============================================================================

const SEVERITY_WEIGHTS: Record<SecuritySeverity, number> = {
  low: 5,
  medium: 15,
  high: 30,
  critical: 50,
}

const TYPE_WEIGHTS: Record<SecurityFindingType, number> = {
  jailbreak: 2.0,
  suspicious_pattern: 1.3,
  data_exfiltration: 1.7,
  privilege_escalation: 1.9,
  prompt_injection: 1.9,
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
 * SMI-2385: Check if a given line index is inside a fenced code block.
 *
 * Bioinformatics and other technical SKILL.md files commonly document
 * tool installation with patterns like `curl | bash`, `exec()`, and
 * `subprocess.run` inside markdown code blocks. These are false positives
 * for the security scanner. This helper enables context-aware severity
 * downgrading for patterns found inside code fences.
 *
 * Walks lines 0..lineIndex counting triple-backtick fence toggles.
 * An odd count means we are inside a fenced block.
 */
export function isInsideCodeBlock(lines: string[], lineIndex: number): boolean {
  let insideCodeBlock = false
  for (let i = 0; i < lineIndex && i < lines.length; i++) {
    if (lines[i].trimStart().startsWith('```')) {
      insideCodeBlock = !insideCodeBlock
    }
  }
  return insideCodeBlock
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

/**
 * Calculate risk score from findings
 */
function calculateRiskScore(findings: SecurityFinding[]): number {
  let score = 0

  for (const finding of findings) {
    const severityWeight = SEVERITY_WEIGHTS[finding.severity]
    const typeWeight = TYPE_WEIGHTS[finding.type]
    score += severityWeight * typeWeight
  }

  // Cap at 100
  return Math.min(100, Math.round(score))
}

// ============================================================================
// Scanner Implementation
// ============================================================================

/**
 * Scan content for jailbreak patterns
 */
function scanJailbreakPatterns(lines: string[]): SecurityFinding[] {
  const findings: SecurityFinding[] = []

  for (const [index, line] of lines.entries()) {
    for (const pattern of JAILBREAK_PATTERNS) {
      const match = safeRegexTest(pattern, line)
      if (match) {
        findings.push({
          type: 'jailbreak',
          severity: 'critical',
          message: `Jailbreak pattern detected: "${match[0].slice(0, 50)}"`,
          lineNumber: index + 1,
          location: line.trim().slice(0, 100),
        })
        break // One finding per line
      }
    }
  }

  return findings
}

/**
 * Scan content for suspicious patterns
 * SMI-2385: Downgrade severity from 'high' to 'medium' when match is inside a code block
 */
function scanSuspiciousPatterns(lines: string[]): SecurityFinding[] {
  const findings: SecurityFinding[] = []

  for (const [index, line] of lines.entries()) {
    for (const pattern of SUSPICIOUS_PATTERNS) {
      const match = safeRegexTest(pattern, line)
      if (match) {
        const inCodeBlock = isInsideCodeBlock(lines, index)
        findings.push({
          type: 'suspicious_pattern',
          severity: inCodeBlock ? 'medium' : 'high',
          message: `Suspicious pattern detected: "${match[0].slice(0, 50)}"`,
          lineNumber: index + 1,
          location: line.trim().slice(0, 100),
        })
        break
      }
    }
  }

  return findings
}

/**
 * Scan content for data exfiltration patterns
 * SMI-2385: Downgrade severity from 'high' to 'medium' when match is inside a code block
 */
function scanDataExfiltration(lines: string[]): SecurityFinding[] {
  const findings: SecurityFinding[] = []

  for (const [index, line] of lines.entries()) {
    for (const pattern of DATA_EXFILTRATION_PATTERNS) {
      const match = safeRegexTest(pattern, line)
      if (match) {
        const inCodeBlock = isInsideCodeBlock(lines, index)
        findings.push({
          type: 'data_exfiltration',
          severity: inCodeBlock ? 'medium' : 'high',
          message: `Data exfiltration pattern: "${match[0].slice(0, 50)}"`,
          lineNumber: index + 1,
          location: line.trim().slice(0, 100),
        })
        break
      }
    }
  }

  return findings
}

/**
 * Scan content for privilege escalation patterns
 * SMI-2385: Downgrade severity from 'critical' to 'medium' when match is inside a code block
 */
function scanPrivilegeEscalation(lines: string[]): SecurityFinding[] {
  const findings: SecurityFinding[] = []

  for (const [index, line] of lines.entries()) {
    for (const pattern of PRIVILEGE_ESCALATION_PATTERNS) {
      const match = safeRegexTest(pattern, line)
      if (match) {
        const inCodeBlock = isInsideCodeBlock(lines, index)
        findings.push({
          type: 'privilege_escalation',
          severity: inCodeBlock ? 'medium' : 'critical',
          message: `Privilege escalation pattern: "${match[0].slice(0, 50)}"`,
          lineNumber: index + 1,
          location: line.trim().slice(0, 100),
        })
        break
      }
    }
  }

  return findings
}

/**
 * Scan content for prompt injection patterns
 */
function scanPromptInjection(lines: string[]): SecurityFinding[] {
  const findings: SecurityFinding[] = []

  for (const [index, line] of lines.entries()) {
    for (const pattern of PROMPT_INJECTION_PATTERNS) {
      const match = safeRegexTest(pattern, line)
      if (match) {
        findings.push({
          type: 'prompt_injection',
          severity: 'critical',
          message: `Prompt injection pattern: "${match[0].slice(0, 50)}"`,
          lineNumber: index + 1,
          location: line.trim().slice(0, 100),
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

  // Run all scanners
  findings.push(...scanJailbreakPatterns(lines))
  findings.push(...scanSuspiciousPatterns(lines))
  findings.push(...scanDataExfiltration(lines))
  findings.push(...scanPrivilegeEscalation(lines))
  findings.push(...scanPromptInjection(lines))

  // Calculate risk score
  const riskScore = calculateRiskScore(findings)

  // Generate content hash for change detection
  const contentHash = await generateContentHash(content)

  const endTime = performance.now()

  // Determine if scan passed (no critical/high findings and score below threshold)
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
