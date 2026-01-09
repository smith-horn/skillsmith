/**
 * Security Scanner - SMI-587, SMI-685, SMI-882, SMI-1189
 *
 * Security scanning for skill content with advanced pattern detection.
 */

import type { SecurityFinding, ScanReport, ScannerOptions, RiskScoreBreakdown } from './types.js'
import {
  DEFAULT_ALLOWED_DOMAINS,
  SENSITIVE_PATH_PATTERNS,
  JAILBREAK_PATTERNS,
  SUSPICIOUS_PATTERNS,
  SOCIAL_ENGINEERING_PATTERNS,
  PROMPT_LEAKING_PATTERNS,
  DATA_EXFILTRATION_PATTERNS,
  PRIVILEGE_ESCALATION_PATTERNS,
} from './patterns.js'
import { SEVERITY_WEIGHTS, CATEGORY_WEIGHTS } from './weights.js'
import { safeRegexTest, safeRegexCheck } from './regex-utils.js'

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

  /**
   * Extract all URLs from content
   */
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

  /**
   * Check if URL domain is allowed
   */
  private isAllowedDomain(url: string): boolean {
    try {
      const parsed = new URL(url)
      const hostname = parsed.hostname.toLowerCase()

      // Check exact match or subdomain match
      return Array.from(this.allowedDomains).some(
        (domain) => hostname === domain || hostname.endsWith('.' + domain)
      )
    } catch {
      return false
    }
  }

  /**
   * Scan for non-allowlisted URLs
   */
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

  /**
   * Scan for sensitive file path references
   * SMI-882: Uses safeRegexCheck to prevent ReDoS
   */
  private scanSensitivePaths(content: string): SecurityFinding[] {
    const findings: SecurityFinding[] = []
    const lines = content.split('\n')

    lines.forEach((line, index) => {
      for (const pattern of SENSITIVE_PATH_PATTERNS) {
        // SMI-882: Use safe regex check with length limit
        if (safeRegexCheck(pattern, line)) {
          findings.push({
            type: 'sensitive_path',
            severity: 'high',
            message: `Reference to potentially sensitive path: ${pattern.source}`,
            location: line.trim().slice(0, 100),
            lineNumber: index + 1,
          })
          break // One finding per line
        }
      }
    })

    return findings
  }

  /**
   * Scan for jailbreak attempts
   * SMI-882: Uses safeRegexTest to prevent ReDoS
   */
  private scanJailbreakPatterns(content: string): SecurityFinding[] {
    const findings: SecurityFinding[] = []
    const lines = content.split('\n')

    lines.forEach((line, index) => {
      for (const pattern of JAILBREAK_PATTERNS) {
        // SMI-882: Use safe regex test with length limit
        const match = safeRegexTest(pattern, line)
        if (match) {
          findings.push({
            type: 'jailbreak',
            severity: 'critical',
            message: `Potential jailbreak pattern detected: "${match[0]}"`,
            location: line.trim().slice(0, 100),
            lineNumber: index + 1,
          })
          break // One finding per line
        }
      }
    })

    return findings
  }

  /**
   * Scan for suspicious code patterns
   * SMI-882: Uses safeRegexTest to prevent ReDoS
   */
  private scanSuspiciousPatterns(content: string): SecurityFinding[] {
    const findings: SecurityFinding[] = []
    const lines = content.split('\n')

    lines.forEach((line, index) => {
      for (const pattern of SUSPICIOUS_PATTERNS) {
        // SMI-882: Use safe regex test with length limit
        const match = safeRegexTest(pattern, line)
        if (match) {
          findings.push({
            type: 'suspicious_pattern',
            severity: 'medium',
            message: `Suspicious pattern detected: "${match[0]}"`,
            location: line.trim().slice(0, 100),
            lineNumber: index + 1,
          })
          break // One finding per line
        }
      }

      // Check custom blocked patterns
      for (const pattern of this.blockedPatterns) {
        // SMI-882: Use safe regex test with length limit
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

  /**
   * SMI-685: Scan for social engineering attempts
   * SMI-882: Uses safeRegexTest to prevent ReDoS
   * Detects patterns like "pretend to be", "roleplay as", "you are now"
   */
  private scanSocialEngineering(content: string): SecurityFinding[] {
    const findings: SecurityFinding[] = []
    const lines = content.split('\n')

    lines.forEach((line, index) => {
      for (const pattern of SOCIAL_ENGINEERING_PATTERNS) {
        // SMI-882: Use safe regex test with length limit
        const match = safeRegexTest(pattern, line)
        if (match) {
          findings.push({
            type: 'social_engineering',
            severity: 'high',
            message: `Social engineering attempt detected: "${match[0]}"`,
            location: line.trim().slice(0, 100),
            lineNumber: index + 1,
            category: 'social_engineering',
          })
          break // One finding per line
        }
      }
    })

    return findings
  }

  /**
   * SMI-685: Scan for prompt leaking attempts
   * SMI-882: Uses safeRegexTest to prevent ReDoS
   * Detects patterns like "show me your instructions", "what are your rules"
   */
  private scanPromptLeaking(content: string): SecurityFinding[] {
    const findings: SecurityFinding[] = []
    const lines = content.split('\n')

    lines.forEach((line, index) => {
      for (const pattern of PROMPT_LEAKING_PATTERNS) {
        // SMI-882: Use safe regex test with length limit
        const match = safeRegexTest(pattern, line)
        if (match) {
          findings.push({
            type: 'prompt_leaking',
            severity: 'critical',
            message: `Prompt leaking attempt detected: "${match[0]}"`,
            location: line.trim().slice(0, 100),
            lineNumber: index + 1,
            category: 'prompt_leaking',
          })
          break // One finding per line
        }
      }
    })

    return findings
  }

  /**
   * SMI-685: Scan for data exfiltration patterns
   * SMI-882: Uses safeRegexTest to prevent ReDoS
   * Detects encoding to external URLs, file upload patterns
   */
  private scanDataExfiltration(content: string): SecurityFinding[] {
    const findings: SecurityFinding[] = []
    const lines = content.split('\n')

    lines.forEach((line, index) => {
      for (const pattern of DATA_EXFILTRATION_PATTERNS) {
        // SMI-882: Use safe regex test with length limit
        const match = safeRegexTest(pattern, line)
        if (match) {
          findings.push({
            type: 'data_exfiltration',
            severity: 'high',
            message: `Potential data exfiltration pattern: "${match[0]}"`,
            location: line.trim().slice(0, 100),
            lineNumber: index + 1,
            category: 'data_exfiltration',
          })
          break // One finding per line
        }
      }
    })

    return findings
  }

  /**
   * SMI-685: Scan for privilege escalation patterns
   * SMI-882: Uses safeRegexTest to prevent ReDoS
   * Detects sudo with passwords, chmod patterns, root access attempts
   */
  private scanPrivilegeEscalation(content: string): SecurityFinding[] {
    const findings: SecurityFinding[] = []
    const lines = content.split('\n')

    lines.forEach((line, index) => {
      for (const pattern of PRIVILEGE_ESCALATION_PATTERNS) {
        // SMI-882: Use safe regex test with length limit
        const match = safeRegexTest(pattern, line)
        if (match) {
          findings.push({
            type: 'privilege_escalation',
            severity: 'critical',
            message: `Privilege escalation pattern detected: "${match[0]}"`,
            location: line.trim().slice(0, 100),
            lineNumber: index + 1,
            category: 'privilege_escalation',
          })
          break // One finding per line
        }
      }
    })

    return findings
  }

  /**
   * SMI-685: Calculate risk score from findings
   * Aggregates multiple findings into a risk score from 0-100
   * @param findings - Array of security findings
   * @returns Risk score breakdown and total
   */
  calculateRiskScore(findings: SecurityFinding[]): {
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
    }

    // Calculate raw scores by category
    for (const finding of findings) {
      const severityWeight = SEVERITY_WEIGHTS[finding.severity]
      const categoryWeight = CATEGORY_WEIGHTS[finding.type] ?? 1.0
      const score = severityWeight * categoryWeight

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

    // Calculate total as weighted average, capped at 100
    const total = Math.min(
      100,
      Math.round(
        breakdown.jailbreak * 0.25 +
          breakdown.socialEngineering * 0.15 +
          breakdown.promptLeaking * 0.15 +
          breakdown.dataExfiltration * 0.12 +
          breakdown.privilegeEscalation * 0.13 +
          breakdown.suspiciousCode * 0.1 +
          breakdown.sensitivePaths * 0.05 +
          breakdown.externalUrls * 0.05
      )
    )

    return { total, breakdown }
  }

  /**
   * Perform full security scan
   * SMI-685: Enhanced with new pattern detection and risk scoring
   */
  scan(skillId: string, content: string): ScanReport {
    const startTime = performance.now()
    const findings: SecurityFinding[] = []

    // Check content length
    if (content.length > this.maxContentLength) {
      findings.push({
        type: 'suspicious_pattern',
        severity: 'low',
        message: `Content exceeds maximum length (${this.maxContentLength} bytes)`,
      })
    }

    // Run all scans (original)
    findings.push(...this.scanUrls(content))
    findings.push(...this.scanSensitivePaths(content))
    findings.push(...this.scanJailbreakPatterns(content))
    findings.push(...this.scanSuspiciousPatterns(content))

    // SMI-685: Run new scans
    findings.push(...this.scanSocialEngineering(content))
    findings.push(...this.scanPromptLeaking(content))
    findings.push(...this.scanDataExfiltration(content))
    findings.push(...this.scanPrivilegeEscalation(content))

    const endTime = performance.now()

    // SMI-685: Calculate risk score
    const { total: riskScore, breakdown: riskBreakdown } = this.calculateRiskScore(findings)

    // Determine if scan passed based on risk threshold and severity
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

  /**
   * Quick check without full scan
   * SMI-882: Uses safeRegexCheck to prevent ReDoS
   */
  quickCheck(content: string): boolean {
    // Check for critical patterns only
    for (const pattern of JAILBREAK_PATTERNS) {
      // SMI-882: Use safe regex check with length limit
      if (safeRegexCheck(pattern, content)) return false
    }
    return true
  }

  /**
   * Add allowed domain
   */
  addAllowedDomain(domain: string): void {
    this.allowedDomains.add(domain.toLowerCase())
  }

  /**
   * Add blocked pattern
   */
  addBlockedPattern(pattern: RegExp): void {
    this.blockedPatterns.push(pattern)
  }
}

export default SecurityScanner
