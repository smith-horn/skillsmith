/**
 * Security Scanner - SMI-587, SMI-685, SMI-882, SMI-1189
 *
 * Security scanning for skill content with advanced pattern detection.
 */

import type {
  SecurityFinding,
  ScanReport,
  ScannerOptions,
  RiskScoreBreakdown,
  FindingConfidence,
} from './types.js'
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
import { SEVERITY_WEIGHTS, CATEGORY_WEIGHTS } from './weights.js'
import { safeRegexTest, safeRegexCheck } from './regex-utils.js'

/**
 * SMI-1532: Check if a regex pattern requires multi-line matching
 * Patterns that contain newline/carriage-return characters or start with
 * multi-line anchors need to be tested against full content, not line-by-line.
 */
function isMultilinePattern(pattern: RegExp): boolean {
  const patternStr = pattern.source
  return (
    patternStr.includes('\\r') || patternStr.includes('\\n') || patternStr.startsWith('(?:^|\\n)')
  )
}

/**
 * Context information for each line in markdown content
 */
interface LineContext {
  lineNumber: number
  inCodeBlock: boolean
  inTable: boolean
  isIndentedCode: boolean
  isInlineCode: boolean
}

/**
 * Analyze markdown content and return context for each line
 * Used to reduce false positives in documentation/examples
 */
function analyzeMarkdownContext(content: string): LineContext[] {
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
function isDocumentationContext(ctx: LineContext): boolean {
  return ctx.inCodeBlock || ctx.inTable || ctx.isIndentedCode
}

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
   * SMI-1513: Mark findings in documentation context with lower confidence
   */
  private scanSensitivePaths(content: string, lineContexts?: LineContext[]): SecurityFinding[] {
    const findings: SecurityFinding[] = []
    const lines = content.split('\n')
    const contexts = lineContexts ?? analyzeMarkdownContext(content)

    lines.forEach((line, index) => {
      const ctx = contexts[index]
      const inDocContext = ctx ? isDocumentationContext(ctx) : false

      for (const pattern of SENSITIVE_PATH_PATTERNS) {
        // SMI-882: Use safe regex check with length limit
        if (safeRegexCheck(pattern, line)) {
          // SMI-1513: Still report findings in documentation context but with lower confidence
          const confidence: FindingConfidence = inDocContext ? 'low' : 'high'
          const severity = inDocContext ? 'medium' : 'high' // Reduce severity for examples

          findings.push({
            type: 'sensitive_path',
            severity,
            message: `Reference to potentially sensitive path: ${pattern.source}`,
            location: line.trim().slice(0, 100),
            lineNumber: index + 1,
            inDocumentationContext: inDocContext,
            confidence,
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
   * SMI-1513: Mark findings in documentation context with lower confidence
   */
  private scanJailbreakPatterns(content: string, lineContexts?: LineContext[]): SecurityFinding[] {
    const findings: SecurityFinding[] = []
    const lines = content.split('\n')
    const contexts = lineContexts ?? analyzeMarkdownContext(content)

    lines.forEach((line, index) => {
      const ctx = contexts[index]
      const inDocContext = ctx ? isDocumentationContext(ctx) : false

      for (const pattern of JAILBREAK_PATTERNS) {
        // SMI-882: Use safe regex test with length limit
        const match = safeRegexTest(pattern, line)
        if (match) {
          // SMI-1513: Documentation examples get reduced severity/confidence
          const confidence: FindingConfidence = inDocContext ? 'low' : 'high'
          const severity = inDocContext ? 'high' : 'critical' // Still high even in docs

          findings.push({
            type: 'jailbreak',
            severity,
            message: `Potential jailbreak pattern detected: "${match[0]}"`,
            location: line.trim().slice(0, 100),
            lineNumber: index + 1,
            inDocumentationContext: inDocContext,
            confidence,
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
   * SMI-1513: Mark findings in documentation context with lower confidence
   * Detects patterns like "pretend to be", "roleplay as", "you are now"
   */
  private scanSocialEngineering(content: string, lineContexts?: LineContext[]): SecurityFinding[] {
    const findings: SecurityFinding[] = []
    const lines = content.split('\n')
    const contexts = lineContexts ?? analyzeMarkdownContext(content)

    lines.forEach((line, index) => {
      const ctx = contexts[index]
      const inDocContext = ctx ? isDocumentationContext(ctx) : false

      for (const pattern of SOCIAL_ENGINEERING_PATTERNS) {
        // SMI-882: Use safe regex test with length limit
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
          break // One finding per line
        }
      }
    })

    return findings
  }

  /**
   * SMI-685: Scan for prompt leaking attempts
   * SMI-882: Uses safeRegexTest to prevent ReDoS
   * SMI-1513: Mark findings in documentation context with lower confidence
   * Detects patterns like "show me your instructions", "what are your rules"
   */
  private scanPromptLeaking(content: string, lineContexts?: LineContext[]): SecurityFinding[] {
    const findings: SecurityFinding[] = []
    const lines = content.split('\n')
    const contexts = lineContexts ?? analyzeMarkdownContext(content)

    lines.forEach((line, index) => {
      const ctx = contexts[index]
      const inDocContext = ctx ? isDocumentationContext(ctx) : false

      for (const pattern of PROMPT_LEAKING_PATTERNS) {
        // SMI-882: Use safe regex test with length limit
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
          break // One finding per line
        }
      }
    })

    return findings
  }

  /**
   * SMI-685: Scan for data exfiltration patterns
   * SMI-882: Uses safeRegexTest to prevent ReDoS
   * SMI-1513: Mark findings in documentation context with lower confidence
   * Detects encoding to external URLs, file upload patterns
   */
  private scanDataExfiltration(content: string, lineContexts?: LineContext[]): SecurityFinding[] {
    const findings: SecurityFinding[] = []
    const lines = content.split('\n')
    const contexts = lineContexts ?? analyzeMarkdownContext(content)

    lines.forEach((line, index) => {
      const ctx = contexts[index]
      const inDocContext = ctx ? isDocumentationContext(ctx) : false

      for (const pattern of DATA_EXFILTRATION_PATTERNS) {
        // SMI-882: Use safe regex test with length limit
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
          break // One finding per line
        }
      }
    })

    return findings
  }

  /**
   * SMI-685: Scan for privilege escalation patterns
   * SMI-882: Uses safeRegexTest to prevent ReDoS
   * SMI-1513: Mark findings in documentation context with lower confidence
   * Detects sudo with passwords, chmod patterns, root access attempts
   */
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
        // SMI-882: Use safe regex test with length limit
        const match = safeRegexTest(pattern, line)
        if (match) {
          // SMI-1513: Tutorials often show sudo examples - reduce severity in docs
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
          break // One finding per line
        }
      }
    })

    return findings
  }

  /**
   * SMI-1532: Scan for AI injection vulnerabilities (CVE-hardened)
   * Optimized for sub-10ms scan time with compiled regex
   * SMI-1513: Mark findings in documentation context with lower confidence
   *
   * Detects:
   * - Role injection (system:/assistant:/user:)
   * - Hidden instruction brackets [[...]]
   * - HTML comment injection
   * - Unicode homograph attacks
   * - Prompt structure manipulation
   * - Base64 encoded instructions
   * - And more...
   */
  private scanAIDefenceVulnerabilities(
    content: string,
    lineContexts?: LineContext[]
  ): SecurityFinding[] {
    const findings: SecurityFinding[] = []
    const lines = content.split('\n')
    const contexts = lineContexts ?? analyzeMarkdownContext(content)

    // Track which line ranges have been flagged to avoid duplicates
    const flaggedLines = new Set<number>()

    // First pass: scan full content for multi-line patterns
    // Patterns that require seeing multiple lines together (CRLF, delimiter injection)
    for (const pattern of AI_DEFENCE_PATTERNS) {
      if (isMultilinePattern(pattern)) {
        const match = safeRegexTest(pattern, content)
        if (match) {
          // Find which line the match starts on
          const matchIndex = content.indexOf(match[0])
          const lineNumber = content.slice(0, matchIndex).split('\n').length
          const lineIndex = lineNumber - 1

          // Check documentation context for this line
          const ctx = contexts[lineIndex]
          const inDocContext = ctx ? isDocumentationContext(ctx) : false

          // SMI-1513: Reduce severity/confidence for doc context
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
      if (flaggedLines.has(index + 1)) {
        return // Skip lines already flagged by multi-line scan
      }

      const ctx = contexts[index]
      const inDocContext = ctx ? isDocumentationContext(ctx) : false

      for (const pattern of AI_DEFENCE_PATTERNS) {
        // Skip multi-line patterns in line-by-line scan
        if (isMultilinePattern(pattern)) continue

        // SMI-882: Use safe regex test with length limit
        const match = safeRegexTest(pattern, line)
        if (match) {
          // SMI-1513: Documentation examples get reduced severity/confidence
          const confidence: FindingConfidence = inDocContext ? 'low' : 'high'
          // AI injection is always critical, but reduce to high in docs
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
          break // One finding per line for performance
        }
      }
    })

    return findings
  }

  /**
   * SMI-685: Calculate risk score from findings
   * SMI-1513: Accounts for confidence levels (low confidence = reduced weight)
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
      aiDefence: 0, // SMI-1532: AI injection detection score
    }

    // Confidence weights - low confidence findings contribute less to risk
    const confidenceWeights: Record<FindingConfidence, number> = {
      high: 1.0,
      medium: 0.7,
      low: 0.3, // Documentation context findings have reduced impact
    }

    // Calculate raw scores by category
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
    breakdown.aiDefence = Math.min(100, breakdown.aiDefence) // SMI-1532

    // Calculate total as weighted average, capped at 100
    // SMI-1532: Added aiDefence with 0.15 weight (redistributed from others)
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

  /**
   * Perform full security scan
   * SMI-685: Enhanced with new pattern detection and risk scoring
   * SMI-1513: Added markdown context awareness to reduce false positives
   */
  scan(skillId: string, content: string): ScanReport {
    const startTime = performance.now()
    const findings: SecurityFinding[] = []

    // SMI-1513: Analyze markdown context once for all scans
    const lineContexts = analyzeMarkdownContext(content)

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
    findings.push(...this.scanSensitivePaths(content, lineContexts))
    findings.push(...this.scanJailbreakPatterns(content, lineContexts))
    findings.push(...this.scanSuspiciousPatterns(content))

    // SMI-685: Run new scans with context awareness
    findings.push(...this.scanSocialEngineering(content, lineContexts))
    findings.push(...this.scanPromptLeaking(content, lineContexts))
    findings.push(...this.scanDataExfiltration(content, lineContexts))
    findings.push(...this.scanPrivilegeEscalation(content, lineContexts))

    // SMI-1532: Run AI Defence CVE-hardened scanning
    findings.push(...this.scanAIDefenceVulnerabilities(content, lineContexts))

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
