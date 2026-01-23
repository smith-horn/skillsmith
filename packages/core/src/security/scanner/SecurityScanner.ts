/**
 * Security Scanner - SMI-587, SMI-685, SMI-882, SMI-1189
 *
 * Security scanning for skill content with advanced pattern detection.
 */

import type { SecurityFinding, ScanReport, ScannerOptions, FindingConfidence } from './types.js'
import {
  DEFAULT_ALLOWED_DOMAINS,
  SENSITIVE_PATH_PATTERNS,
  JAILBREAK_PATTERNS,
  SUSPICIOUS_PATTERNS,
  SOCIAL_ENGINEERING_PATTERNS,
  PROMPT_LEAKING_PATTERNS,
  DATA_EXFILTRATION_PATTERNS,
  PRIVILEGE_ESCALATION_PATTERNS,
  AI_DEFENCE_PATTERNS,
} from './patterns.js'
import { safeRegexTest, safeRegexCheck } from './regex-utils.js'

// Import helpers
import type { LineContext } from './SecurityScanner.helpers.js'
import {
  isMultilinePattern,
  analyzeMarkdownContext,
  isDocumentationContext,
  calculateRiskScore,
} from './SecurityScanner.helpers.js'

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
  calculateRiskScore,
}
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

  private scanSensitivePaths(content: string, lineContexts?: LineContext[]): SecurityFinding[] {
    const findings: SecurityFinding[] = []
    const lines = content.split('\n')
    const contexts = lineContexts ?? analyzeMarkdownContext(content)

    lines.forEach((line, index) => {
      const ctx = contexts[index]
      const inDocContext = ctx ? isDocumentationContext(ctx) : false

      for (const pattern of SENSITIVE_PATH_PATTERNS) {
        if (safeRegexCheck(pattern, line)) {
          const confidence: FindingConfidence = inDocContext ? 'low' : 'high'
          const severity = inDocContext ? 'medium' : 'high'

          findings.push({
            type: 'sensitive_path',
            severity,
            message: `Reference to potentially sensitive path: ${pattern.source}`,
            location: line.trim().slice(0, 100),
            lineNumber: index + 1,
            inDocumentationContext: inDocContext,
            confidence,
          })
          break
        }
      }
    })

    return findings
  }

  private scanJailbreakPatterns(content: string, lineContexts?: LineContext[]): SecurityFinding[] {
    const findings: SecurityFinding[] = []
    const lines = content.split('\n')
    const contexts = lineContexts ?? analyzeMarkdownContext(content)

    lines.forEach((line, index) => {
      const ctx = contexts[index]
      const inDocContext = ctx ? isDocumentationContext(ctx) : false

      for (const pattern of JAILBREAK_PATTERNS) {
        const match = safeRegexTest(pattern, line)
        if (match) {
          const confidence: FindingConfidence = inDocContext ? 'low' : 'high'
          const severity = inDocContext ? 'high' : 'critical'

          findings.push({
            type: 'jailbreak',
            severity,
            message: `Potential jailbreak pattern detected: "${match[0]}"`,
            location: line.trim().slice(0, 100),
            lineNumber: index + 1,
            inDocumentationContext: inDocContext,
            confidence,
          })
          break
        }
      }
    })

    return findings
  }

  private scanSuspiciousPatterns(content: string): SecurityFinding[] {
    const findings: SecurityFinding[] = []
    const lines = content.split('\n')

    lines.forEach((line, index) => {
      for (const pattern of SUSPICIOUS_PATTERNS) {
        const match = safeRegexTest(pattern, line)
        if (match) {
          findings.push({
            type: 'suspicious_pattern',
            severity: 'medium',
            message: `Suspicious pattern detected: "${match[0]}"`,
            location: line.trim().slice(0, 100),
            lineNumber: index + 1,
          })
          break
        }
      }

      for (const pattern of this.blockedPatterns) {
        const match = safeRegexTest(pattern, line)
        if (match) {
          findings.push({
            type: 'suspicious_pattern',
            severity: 'high',
            message: `Blocked pattern detected: "${match[0]}"`,
            location: line.trim().slice(0, 100),
            lineNumber: index + 1,
          })
          break
        }
      }
    })

    return findings
  }

  private scanSocialEngineering(content: string, lineContexts?: LineContext[]): SecurityFinding[] {
    const findings: SecurityFinding[] = []
    const lines = content.split('\n')
    const contexts = lineContexts ?? analyzeMarkdownContext(content)

    lines.forEach((line, index) => {
      const ctx = contexts[index]
      const inDocContext = ctx ? isDocumentationContext(ctx) : false

      for (const pattern of SOCIAL_ENGINEERING_PATTERNS) {
        const match = safeRegexTest(pattern, line)
        if (match) {
          const confidence: FindingConfidence = inDocContext ? 'low' : 'high'
          const severity = inDocContext ? 'medium' : 'high'

          findings.push({
            type: 'social_engineering',
            severity,
            message: `Social engineering attempt detected: "${match[0]}"`,
            location: line.trim().slice(0, 100),
            lineNumber: index + 1,
            category: 'social_engineering',
            inDocumentationContext: inDocContext,
            confidence,
          })
          break
        }
      }
    })

    return findings
  }

  private scanPromptLeaking(content: string, lineContexts?: LineContext[]): SecurityFinding[] {
    const findings: SecurityFinding[] = []
    const lines = content.split('\n')
    const contexts = lineContexts ?? analyzeMarkdownContext(content)

    lines.forEach((line, index) => {
      const ctx = contexts[index]
      const inDocContext = ctx ? isDocumentationContext(ctx) : false

      for (const pattern of PROMPT_LEAKING_PATTERNS) {
        const match = safeRegexTest(pattern, line)
        if (match) {
          const confidence: FindingConfidence = inDocContext ? 'low' : 'high'
          const severity = inDocContext ? 'high' : 'critical'

          findings.push({
            type: 'prompt_leaking',
            severity,
            message: `Prompt leaking attempt detected: "${match[0]}"`,
            location: line.trim().slice(0, 100),
            lineNumber: index + 1,
            category: 'prompt_leaking',
            inDocumentationContext: inDocContext,
            confidence,
          })
          break
        }
      }
    })

    return findings
  }

  private scanDataExfiltration(content: string, lineContexts?: LineContext[]): SecurityFinding[] {
    const findings: SecurityFinding[] = []
    const lines = content.split('\n')
    const contexts = lineContexts ?? analyzeMarkdownContext(content)

    lines.forEach((line, index) => {
      const ctx = contexts[index]
      const inDocContext = ctx ? isDocumentationContext(ctx) : false

      for (const pattern of DATA_EXFILTRATION_PATTERNS) {
        const match = safeRegexTest(pattern, line)
        if (match) {
          const confidence: FindingConfidence = inDocContext ? 'low' : 'high'
          const severity = inDocContext ? 'medium' : 'high'

          findings.push({
            type: 'data_exfiltration',
            severity,
            message: `Potential data exfiltration pattern: "${match[0]}"`,
            location: line.trim().slice(0, 100),
            lineNumber: index + 1,
            category: 'data_exfiltration',
            inDocumentationContext: inDocContext,
            confidence,
          })
          break
        }
      }
    })

    return findings
  }

  private scanPrivilegeEscalation(
    content: string,
    lineContexts?: LineContext[]
  ): SecurityFinding[] {
    const findings: SecurityFinding[] = []
    const lines = content.split('\n')
    const contexts = lineContexts ?? analyzeMarkdownContext(content)

    lines.forEach((line, index) => {
      const ctx = contexts[index]
      const inDocContext = ctx ? isDocumentationContext(ctx) : false

      for (const pattern of PRIVILEGE_ESCALATION_PATTERNS) {
        const match = safeRegexTest(pattern, line)
        if (match) {
          const confidence: FindingConfidence = inDocContext ? 'low' : 'high'
          const severity = inDocContext ? 'high' : 'critical'

          findings.push({
            type: 'privilege_escalation',
            severity,
            message: `Privilege escalation pattern detected: "${match[0]}"`,
            location: line.trim().slice(0, 100),
            lineNumber: index + 1,
            category: 'privilege_escalation',
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
    const findings: SecurityFinding[] = []
    const lines = content.split('\n')
    const contexts = lineContexts ?? analyzeMarkdownContext(content)
    const flaggedLines = new Set<number>()

    // First pass: scan full content for multi-line patterns
    for (const pattern of AI_DEFENCE_PATTERNS) {
      if (isMultilinePattern(pattern)) {
        const match = safeRegexTest(pattern, content)
        if (match) {
          const matchIndex = content.indexOf(match[0])
          const lineNumber = content.slice(0, matchIndex).split('\n').length
          const lineIndex = lineNumber - 1

          const ctx = contexts[lineIndex]
          const inDocContext = ctx ? isDocumentationContext(ctx) : false
          const confidence: FindingConfidence = inDocContext ? 'low' : 'high'
          const severity = inDocContext ? 'high' : 'critical'

          findings.push({
            type: 'ai_defence',
            severity,
            message: `AI injection pattern detected: "${match[0].slice(0, 50)}${match[0].length > 50 ? '...' : ''}"`,
            location: match[0].trim().slice(0, 100),
            lineNumber,
            category: 'ai_defence',
            inDocumentationContext: inDocContext,
            confidence,
          })
          flaggedLines.add(lineNumber)
        }
      }
    }

    // Second pass: line-by-line scanning for single-line patterns
    lines.forEach((line, index) => {
      if (flaggedLines.has(index + 1)) return

      const ctx = contexts[index]
      const inDocContext = ctx ? isDocumentationContext(ctx) : false

      for (const pattern of AI_DEFENCE_PATTERNS) {
        if (isMultilinePattern(pattern)) continue

        const match = safeRegexTest(pattern, line)
        if (match) {
          const confidence: FindingConfidence = inDocContext ? 'low' : 'high'
          const severity = inDocContext ? 'high' : 'critical'

          findings.push({
            type: 'ai_defence',
            severity,
            message: `AI injection pattern detected: "${match[0].slice(0, 50)}${match[0].length > 50 ? '...' : ''}"`,
            location: line.trim().slice(0, 100),
            lineNumber: index + 1,
            category: 'ai_defence',
            inDocumentationContext: inDocContext,
            confidence,
          })
          break
        }
      }
    })

    return findings
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
    findings.push(...this.scanSensitivePaths(content, lineContexts))
    findings.push(...this.scanJailbreakPatterns(content, lineContexts))
    findings.push(...this.scanSuspiciousPatterns(content))
    findings.push(...this.scanSocialEngineering(content, lineContexts))
    findings.push(...this.scanPromptLeaking(content, lineContexts))
    findings.push(...this.scanDataExfiltration(content, lineContexts))
    findings.push(...this.scanPrivilegeEscalation(content, lineContexts))
    findings.push(...this.scanAIDefenceVulnerabilities(content, lineContexts))

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
