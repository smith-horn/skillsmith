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
// SMI-6033 Wave 1: chmod+fetch compound signal, extracted to a sibling twin
// (500-line limit); byte-identical body across both _shared twins (parity test).
// SMI-6033 Wave 2: xattr Gatekeeper-bypass (Gap 5) lives in the same module.
import { scanChmodFetchCompound, scanGatekeeperBypass } from './security-scanner-edge.compound.ts'
// SMI-6033 Wave 1: sensitive_path detector, ported from core's
// SecurityScanner.scanners.ts (edge previously had no sensitive_path
// type/detector/weight/coefficient at all).
import { scanSensitivePaths } from './security-scanner-edge.paths.ts'
// SMI-6033 Wave 2 (Gap 3): password-protected archive evasion.
import { scanArchiveEvasion } from './security-scanner-edge.archive.ts'
// SMI-6033 Wave 2 (Gap 4): paste/snippet-host reputation + fetch-context escalation.
import { scanPasteHostFetch } from './security-scanner-edge.paste-host.ts'
// SMI-6033 Wave 2 (Gap 2): encoded (base64) payload detect-decode-recursively-rescan.
import { scanEncodedPayload } from './security-scanner-edge.encoding.ts'
// SMI-6033 Wave 4 (Gap 6): decoy/misdirection URL-target heuristic.
import { scanDecoyMisdirection } from './security-scanner-edge.decoy.ts'

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
 * Run every content-scanning detector against `lines`/`contexts` and return
 * the combined findings. Factored out of `scanSkillContent()` (SMI-6033 Wave
 * 2, Gap 2) so the encoded-payload detector's recursive rescan of DECODED
 * content can reuse the exact same detector suite instead of a parallel,
 * narrower reimplementation.
 *
 * `skipEncodedPayload` is the STRUCTURAL depth-1 recursion guarantee: the
 * recursive callback passed to `scanEncodedPayload` below always calls this
 * function with `skipEncodedPayload: true`, so a base64 blob discovered
 * INSIDE already-decoded content can never itself be decoded — the inner
 * call cannot reach `scanEncodedPayload` again no matter what the decoded
 * text contains. This disables ONLY the encoded-payload detector on the
 * inner call, not the rest of the suite.
 */
function runDetectors(
  lines: string[],
  contexts: LineContext[],
  skipEncodedPayload: boolean,
  isHighTrustAuthor = false
): SecurityFinding[] {
  const findings: SecurityFinding[] = []

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
  // SMI-6033 Wave 2/3 (Gap 5): xattr Gatekeeper-bypass — critical only when
  // correlated with a fetch destination AND the author isn't high-trust.
  findings.push(...scanGatekeeperBypass(lines, contexts, isHighTrustAuthor))
  // SMI-6033 Wave 2 (Gap 3): password-protected archive evasion — correlated +
  // inline-literal-password form is standalone-critical; every other shape
  // (uncorrelated CLI usage, prose-only mention) is medium/advisory.
  findings.push(...scanArchiveEvasion(lines, contexts))
  // SMI-6033 Wave 2 (Gap 4): paste/snippet-host reputation — a paste-host
  // URL that is the target of a fetch command is standalone-critical; a
  // merely-linked paste-host URL produces no finding on edge (edge has no
  // url:medium detector to preserve — see security-scanner-edge.paste-host.ts).
  findings.push(...scanPasteHostFetch(lines, contexts))
  // SMI-6033 Wave 4 (Gap 6): decoy/misdirection — a fetch target whose
  // domain doesn't match a brand/authority claim made nearby in the skill's
  // own prose. Advisory-only (medium, never high/critical); must run before
  // escalateCodeExecution below since a later dispatch wires this finding
  // type into that co-signal mechanism.
  findings.push(...scanDecoyMisdirection(lines, contexts))
  findings.push(...scanPromptInjection(lines, contexts))
  // SMI-6033 Wave 1: sensitive_path (credential file/path/env-var references).
  findings.push(...scanSensitivePaths(lines, contexts))
  // SMI-5359 Wave 4.2c: remote-fetch-to-interpreter + Unicode-concealed directives.
  findings.push(...scanCodeExecution(lines, contexts))
  findings.push(...scanObfuscatedDirective(lines))
  // Promote code_execution to critical when it co-occurs with a non-doc
  // exfil/privilege/obfuscation signal (runs after every detector).
  escalateCodeExecution(findings)

  // SMI-6033 Wave 2 (Gap 2): decode-and-recursively-rescan base64 payloads.
  // Appended AFTER escalateCodeExecution above, and the recursive rescan's
  // OWN findings are already fully escalated by its own (inner) call to this
  // same function — so no finding is ever run through escalateCodeExecution
  // twice.
  if (!skipEncodedPayload) {
    findings.push(
      ...scanEncodedPayload(lines, contexts, (decodedContent) => {
        const decodedLines = decodedContent.split('\n')
        const decodedContexts = analyzeMarkdownContext(decodedContent)
        return runDetectors(decodedLines, decodedContexts, true, isHighTrustAuthor)
      })
    )
  }

  return findings
}

/**
 * Scan SKILL.md content for security issues
 *
 * @param content - The SKILL.md content to scan
 * @param isHighTrustAuthor - SMI-6033 Wave 3 (Gap 5): the Gatekeeper-bypass
 *   trust-tier carve-out (see scanGatekeeperBypass's own header,
 *   security-scanner-edge.compound.ts). Must be sourced from a VERIFIED
 *   author signal (the indexer's own resolved GitHub repo owner) — never
 *   omit this reasoning when threading a value in from a new call site.
 *   Defaults `false` (closed).
 * @returns EdgeScanResult with findings, risk score, and content hash
 */
export async function scanSkillContent(
  content: string,
  isHighTrustAuthor = false
): Promise<EdgeScanResult> {
  const startTime = performance.now()

  // SMI-2408: Split once, pass to all scanners to avoid 5x redundant splitting
  const lines = content.split('\n')
  // SMI-4960: compute markdown context once and thread it through all scanners.
  const contexts = analyzeMarkdownContext(content)

  const findings = runDetectors(lines, contexts, false, isHighTrustAuthor)

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
