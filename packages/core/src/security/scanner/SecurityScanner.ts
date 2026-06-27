/**
 * Security Scanner - SMI-587, SMI-685, SMI-882, SMI-1189
 *
 * Security scanning for skill content with advanced pattern detection.
 */

import type { SecurityFinding, ScanReport, ScannerOptions, FindingConfidence } from './types.js'
import {
  DEFAULT_ALLOWED_DOMAINS,
  JAILBREAK_PATTERNS,
  SUSPICIOUS_PATTERNS,
  AI_DEFENCE_PATTERNS,
} from './patterns.js'
import { safeRegexTest, safeRegexCheck } from './regex-utils.js'

// Import helpers
import type { LineContext } from './SecurityScanner.helpers.js'
import {
  isMultilinePattern,
  analyzeMarkdownContext,
  isDocumentationContext,
  isWithinInlineCode,
  calculateRiskScore,
  scanPatternsWithMultilineSupport,
} from './SecurityScanner.helpers.js'

// Import SSRF scanner
import { scanSsrfPatterns } from './SecurityScanner.ssrf.js'

// Import per-category scanners (SMI-5359 Wave 4.2: extracted to keep this file
// under the 500-line gate; pure functions of content + lineContexts).
import {
  scanSensitivePaths,
  scanSocialEngineering,
  scanPromptLeaking,
  scanDataExfiltration,
  scanPrivilegeEscalation,
  scanPiiPatterns,
} from './SecurityScanner.scanners.js'

// Import code-execution & obfuscated-directive detectors (SMI-5359 Wave 4.2).
import {
  scanCodeExecution,
  scanObfuscatedDirective,
  escalateCodeExecution,
} from './SecurityScanner.exec.js'

// Import formatters (used for both re-export and static methods)
import {
  toMinimalRefs,
  toSARIF,
  toGitHubAnnotations,
  toSummary,
} from './SecurityScanner.formatters.js'

// Re-export helpers and formatters for public API
export {
  LineContext,
  isMultilinePattern,
  analyzeMarkdownContext,
  isDocumentationContext,
  isWithinInlineCode,
  calculateRiskScore,
}
export { scanSsrfPatterns }
export { toMinimalRefs, toSARIF, toGitHubAnnotations, toSummary }

export class SecurityScanner {
  private allowedDomains: Set<string>
  private blockedPatterns: RegExp[]
  private maxContentLength: number
  private riskThreshold: number

  constructor(options: ScannerOptions = {}) {
    this.allowedDomains = new Set(options.allowedDomains ?? DEFAULT_ALLOWED_DOMAINS)
    this.blockedPatterns = options.blockedPatterns ?? []
    this.maxContentLength = options.maxContentLength ?? 1_000_000 // 1MB
    this.riskThreshold = options.riskThreshold ?? 40
  }

  private extractUrls(content: string): Array<{ url: string; line: number }> {
    const urlPattern = /https?:\/\/[^\s<>"')\]]+/gi
    const lines = content.split('\n')
    const results: Array<{ url: string; line: number }> = []

    lines.forEach((line, index) => {
      let match
      while ((match = urlPattern.exec(line)) !== null) {
        results.push({ url: match[0], line: index + 1 })
      }
    })

    return results
  }

  private isAllowedDomain(url: string): boolean {
    try {
      const parsed = new URL(url)
      const hostname = parsed.hostname.toLowerCase()
      return Array.from(this.allowedDomains).some(
        (domain) => hostname === domain || hostname.endsWith('.' + domain)
      )
    } catch {
      return false
    }
  }

  private scanUrls(content: string): SecurityFinding[] {
    const findings: SecurityFinding[] = []
    const urls = this.extractUrls(content)

    for (const { url, line } of urls) {
      if (!this.isAllowedDomain(url)) {
        findings.push({
          type: 'url',
          severity: 'medium',
          message: `External URL not in allowlist: ${url}`,
          location: url,
          lineNumber: line,
        })
      }
    }

    return findings
  }

  private scanJailbreakPatterns(content: string, lineContexts?: LineContext[]): SecurityFinding[] {
    return scanPatternsWithMultilineSupport(
      content,
      {
        type: 'jailbreak',
        messagePrefix: 'Potential jailbreak pattern detected',
        patterns: JAILBREAK_PATTERNS,
        severities: ['high', 'critical'],
      },
      lineContexts
    )
  }

  private scanSuspiciousPatterns(content: string, lineContexts?: LineContext[]): SecurityFinding[] {
    const findings: SecurityFinding[] = []
    const lines = content.split('\n')
    const contexts = lineContexts ?? analyzeMarkdownContext(content)

    lines.forEach((line, index) => {
      const ctx = contexts[index]

      for (const pattern of SUSPICIOUS_PATTERNS) {
        const match = safeRegexTest(pattern, line)
        if (match) {
          const inInlineCode = ctx?.isInlineCode && isWithinInlineCode(line, match.index ?? 0)
          const inDocContext = ctx ? isDocumentationContext(ctx) || inInlineCode : false
          // Non-doc keeps the original medium/implicit-high score (confidence
          // defaults to 'high'); doc-context downgrades both so a fenced/quoted
          // example cannot reach the trust-scorer.ts:58 high/critical short-circuit.
          const confidence: FindingConfidence = inDocContext ? 'low' : 'high'
          const severity: SecurityFinding['severity'] = inDocContext ? 'low' : 'medium'

          findings.push({
            type: 'suspicious_pattern',
            severity,
            message: `Suspicious pattern detected: "${match[0]}"`,
            location: line.trim().slice(0, 100),
            lineNumber: index + 1,
            category: 'suspicious_pattern',
            inDocumentationContext: inDocContext,
            confidence,
          })
          break
        }
      }

      for (const pattern of this.blockedPatterns) {
        const match = safeRegexTest(pattern, line)
        if (match) {
          const inInlineCode = ctx?.isInlineCode && isWithinInlineCode(line, match.index ?? 0)
          const inDocContext = ctx ? isDocumentationContext(ctx) || inInlineCode : false
          // Non-doc keeps the original high score; doc-context drops to medium
          // so a quoted "blocked" example cannot trip trust-scorer.ts:58.
          const confidence: FindingConfidence = inDocContext ? 'low' : 'high'
          const severity: SecurityFinding['severity'] = inDocContext ? 'medium' : 'high'

          findings.push({
            type: 'suspicious_pattern',
            severity,
            message: `Blocked pattern detected: "${match[0]}"`,
            location: line.trim().slice(0, 100),
            lineNumber: index + 1,
            category: 'suspicious_pattern',
            inDocumentationContext: inDocContext,
            confidence,
          })
          break
        }
      }
    })

    return findings
  }

  private scanAIDefenceVulnerabilities(
    content: string,
    lineContexts?: LineContext[]
  ): SecurityFinding[] {
    return scanPatternsWithMultilineSupport(
      content,
      {
        type: 'ai_defence',
        messagePrefix: 'AI injection pattern detected',
        patterns: AI_DEFENCE_PATTERNS,
        severities: ['high', 'critical'],
      },
      lineContexts
    )
  }

  /** @deprecated Use standalone calculateRiskScore function for new code */
  calculateRiskScore = calculateRiskScore

  scan(skillId: string, content: string): ScanReport {
    const startTime = performance.now()
    const findings: SecurityFinding[] = []
    const lineContexts = analyzeMarkdownContext(content)

    if (content.length > this.maxContentLength) {
      findings.push({
        type: 'suspicious_pattern',
        severity: 'low',
        message: `Content exceeds maximum length (${this.maxContentLength} bytes)`,
      })
    }

    findings.push(...this.scanUrls(content))
    findings.push(...scanSensitivePaths(content, lineContexts))
    findings.push(...this.scanJailbreakPatterns(content, lineContexts))
    findings.push(...this.scanSuspiciousPatterns(content, lineContexts))
    findings.push(...scanSocialEngineering(content, lineContexts))
    findings.push(...scanPromptLeaking(content, lineContexts))
    findings.push(...scanDataExfiltration(content, lineContexts))
    findings.push(...scanPrivilegeEscalation(content, lineContexts))
    findings.push(...this.scanAIDefenceVulnerabilities(content, lineContexts))
    findings.push(...scanSsrfPatterns(content, lineContexts))
    findings.push(...scanPiiPatterns(content, lineContexts))
    findings.push(...scanCodeExecution(content, lineContexts))
    findings.push(...scanObfuscatedDirective(content))

    // SMI-5359 Wave 4.2: promote code_execution to critical when it co-occurs with a
    // non-documentation exfiltration / privilege / credential / obfuscation signal.
    // Runs after every detector so all co-signals are present.
    escalateCodeExecution(findings)

    const endTime = performance.now()
    const { total: riskScore, breakdown: riskBreakdown } = calculateRiskScore(findings)

    const hasCritical = findings.some((f) => f.severity === 'critical')
    const hasHigh = findings.some((f) => f.severity === 'high')
    const exceedsThreshold = riskScore >= this.riskThreshold

    return {
      skillId,
      passed: !hasCritical && !hasHigh && !exceedsThreshold,
      findings,
      scannedAt: new Date(),
      scanDurationMs: endTime - startTime,
      riskScore,
      riskBreakdown,
    }
  }

  quickCheck(content: string): boolean {
    for (const pattern of JAILBREAK_PATTERNS) {
      if (safeRegexCheck(pattern, content)) return false
    }
    return true
  }

  addAllowedDomain(domain: string): void {
    this.allowedDomains.add(domain.toLowerCase())
  }

  addBlockedPattern(pattern: RegExp): void {
    this.blockedPatterns.push(pattern)
  }

  // Static methods delegate to formatters for backwards compatibility
  static toMinimalRefs = toMinimalRefs
  static toSARIF = toSARIF
  static toGitHubAnnotations = toGitHubAnnotations
  static toSummary = toSummary
}

export default SecurityScanner
