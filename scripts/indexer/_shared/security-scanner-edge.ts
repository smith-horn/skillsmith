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

// SMI-5424 PR2: owner-permission chmod is a COMPOUND signal, not standalone.
// `chmod 755 ./bin/cli` / `chmod 600 .env` / `chmod +x build.sh` are benign idioms
// that the broad owner-perm pattern previously false-fired as
// privilege_escalation:critical. Owner-perm chmod now emits ONLY when either a fetch
// COMMAND (curl/wget/git-clone/npx-to-URL) is within ±1 line of it, OR the file it
// targets is referenced by a fetch command anywhere in the content (distance-
// independent correlation, so filler lines between the download and the chmod can't
// evade the ±1 window) — the "download a payload, chmod it, run it" supply-chain
// shape — which kills the standalone FP AND preserves the chmod co-signal that
// escalateCodeExecution requires (it only accepts high/critical non-doc co-signals,
// so chmod cannot simply be downgraded). World-writable and setuid/setgid chmod stay
// standalone-critical in PRIVILEGE_ESCALATION_PATTERNS; `alreadyFlaggedLines` skips
// those so we never double-emit on one line.
const OWNER_PERM_CHMOD = /\bchmod\s+(?:[0-7]{3,4}|[ugoa]*\+x)\b/i
// FIX-1: actual fetch COMMANDS only. The prior weak tokens (bare `fetch`/`download`/
// `downloaded`, a bare `https?://`, a bare `npx`) false-fired on benign prose next to
// an owner-perm chmod. Keep curl/wget/git-clone, and `npx` only when followed by a URL.
const CHMOD_FETCH_CONTEXT = /\b(?:curl|wget)\b|\bgit\s+clone\b|\bnpx\b[^\n]{0,80}https?:\/\//i
// FIX-2: the file an owner-perm chmod targets (capture its path), so a download command
// anywhere in the content that references the same file correlates with the chmod even
// when filler lines space them outside the ±1 window.
const CHMOD_TARGET = /\bchmod\s+(?:[0-7]{3,4}|[ugoa]*\+x)\s+(\S+)/i
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Owner-perm chmod compound signal — see comment above. Emits HIGH (non-doc) /
 * low (doc) privilege_escalation when an owner-perm chmod is within ±1 line of a
 * fetch command OR targets a file a fetch command references anywhere; lines
 * already flagged critical by the standalone patterns are skipped to avoid
 * double-emitting. Accepted residual: a spaced `curl … | bash` (pipe-to-
 * interpreter, no downloaded filename) followed by a non-adjacent chmod is not
 * caught — there is no filename to correlate, and the remote-exec signal itself is
 * the appropriate detector for that shape (tracked separately).
 */
function scanChmodFetchCompound(
  lines: string[],
  contexts: LineContext[],
  alreadyFlaggedLines: ReadonlySet<number>
): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  // FIX-2: lines carrying a fetch command, for distance-independent correlation.
  const fetchLines = lines.filter((l) => CHMOD_FETCH_CONTEXT.test(l))
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1
    if (alreadyFlaggedLines.has(lineNumber)) continue
    const match = safeRegexTest(OWNER_PERM_CHMOD, line)
    if (!match) continue
    const window = [lines[index - 1] ?? '', line, lines[index + 1] ?? ''].join('\n')
    const adjacentFetch = CHMOD_FETCH_CONTEXT.test(window)
    // FIX-2: correlate the chmod's target basename against any fetch command anywhere
    // in the content — catches a download-then-chmod that filler lines pushed outside
    // the ±1 window. Exact path-token match; basename ≥3 chars excludes `.`/`*`.
    let correlated = false
    const tm = line.match(CHMOD_TARGET)
    if (tm) {
      const base = tm[1].replace(/['"]/g, '').split('/').pop() ?? ''
      if (base.length >= 3) {
        const re = new RegExp(`(?:^|[\\s/'"=])${escapeRegExp(base)}(?:[\\s'"]|$)`)
        correlated = fetchLines.some((l) => re.test(l))
      }
    }
    if (!adjacentFetch && !correlated) continue
    const { inDocContext, confidence } = classifyMatch(contexts[index], line, match.index ?? 0)
    findings.push({
      type: 'privilege_escalation',
      severity: inDocContext ? 'low' : 'high',
      message: `chmod of a fetched/downloaded file (compound with a download verb): "${match[0].slice(0, 50)}"`,
      lineNumber,
      location: line.trim().slice(0, 100),
      inDocumentationContext: inDocContext,
      confidence,
    })
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
  // SMI-5424 PR2: owner-perm chmod compound signal (download-then-chmod). After
  // scanPrivilegeEscalation so we can skip lines it already flagged critical, and
  // before escalateCodeExecution so a compound chmod HIGH can serve as the
  // code_execution co-signal.
  const privEscLines = new Set(
    findings
      .filter((f) => f.type === 'privilege_escalation' && f.lineNumber)
      .map((f) => f.lineNumber as number)
  )
  findings.push(...scanChmodFetchCompound(lines, contexts, privEscLines))
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
