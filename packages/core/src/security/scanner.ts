/**
 * SMI-587: Security Scanner
 * SMI-685: Enhanced security scanning with severity scoring
 * Security scanning for skill content with advanced pattern detection
 */

/**
 * Types of security findings that can be detected
 */
export type SecurityFindingType =
  | 'url'
  | 'sensitive_path'
  | 'jailbreak'
  | 'suspicious_pattern'
  | 'social_engineering'
  | 'prompt_leaking'
  | 'data_exfiltration'
  | 'privilege_escalation'

/**
 * Severity levels for security findings
 */
export type SecuritySeverity = 'low' | 'medium' | 'high' | 'critical'

/**
 * Individual security finding from a scan
 */
export interface SecurityFinding {
  type: SecurityFindingType
  severity: SecuritySeverity
  message: string
  location?: string
  lineNumber?: number
  /** Category for grouping related findings */
  category?: string
}

/**
 * Risk score breakdown by category
 */
export interface RiskScoreBreakdown {
  jailbreak: number
  socialEngineering: number
  promptLeaking: number
  dataExfiltration: number
  privilegeEscalation: number
  suspiciousCode: number
  sensitivePaths: number
  externalUrls: number
}

/**
 * Comprehensive scan report with risk scoring
 */
export interface ScanReport {
  skillId: string
  passed: boolean
  findings: SecurityFinding[]
  scannedAt: Date
  scanDurationMs: number
  /** Overall risk score from 0-100 (0 = safe, 100 = extremely dangerous) */
  riskScore: number
  /** Breakdown of risk score by category */
  riskBreakdown: RiskScoreBreakdown
}

/**
 * Configuration options for the security scanner
 */
export interface ScannerOptions {
  allowedDomains?: string[]
  blockedPatterns?: RegExp[]
  maxContentLength?: number
  /** Risk score threshold for failing a scan (default: 40) */
  riskThreshold?: number
}

// Default allowed domains
const DEFAULT_ALLOWED_DOMAINS = [
  'github.com',
  'githubusercontent.com',
  'raw.githubusercontent.com',
  'npmjs.com',
  'npmjs.org',
  'docs.anthropic.com',
  'anthropic.com',
  'claude.ai',
  'docs.github.com',
  'developer.mozilla.org',
  'nodejs.org',
  'typescriptlang.org',
]

// Sensitive file path patterns
const SENSITIVE_PATH_PATTERNS = [
  /\.env/i,
  /credentials/i,
  /secrets?/i,
  /\.pem$/i,
  /\.key$/i,
  /\.crt$/i,
  /password/i,
  /api[_-]?key/i,
  /auth[_-]?token/i,
  /~\/\.ssh/i,
  /~\/\.aws/i,
  /~\/\.config/i,
]

// Jailbreak attempt patterns
const JAILBREAK_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+)?(previous|prior|your)\s+(instructions?|programming)/i,
  /developer\s+mode/i,
  /\bDAN\b/,
  /do\s+anything\s+now/i,
  /jailbreak/i,
  /bypass\s+(all\s+)?(restrictions?|filters?|safety)/i,
  /pretend\s+(you\s+)?(are|have)\s+no\s+(restrictions?|limits?)/i,
  /act\s+as\s+(if\s+)?you\s+(have\s+)?no\s+ethics/i,
  /you\s+are\s+now\s+(free|unrestricted|unfiltered)/i,
  /ignore\s+your\s+(safety|ethical)\s+(guidelines?|rules?)/i,
  /hypothetical\s+scenario\s+where\s+you\s+can/i,
]

// Suspicious patterns that might indicate malicious intent
const SUSPICIOUS_PATTERNS = [
  /eval\s*\(/i,
  /exec\s*\(/i,
  /child_process/i,
  /\$\(\s*[`'"]/i, // Command substitution
  /base64\s*\.\s*decode/i,
  /from\s+base64\s+import/i,
  /subprocess\s*\.\s*(run|call|Popen)/i,
  /os\s*\.\s*(system|popen|exec)/i,
  /\brm\s+-rf\b/i,
  /curl\s+.*\|\s*(bash|sh)/i, // Curl pipe to shell
  /wget\s+.*\|\s*(bash|sh)/i,
]

// SMI-685: Social engineering attempt patterns
const SOCIAL_ENGINEERING_PATTERNS = [
  /pretend\s+(to\s+be|you\s+are|that\s+you)/i,
  /roleplay\s+as/i,
  /you\s+are\s+now\s+(?!free|unrestricted)/i, // Exclude jailbreak patterns
  /act\s+as\s+(if\s+you\s+were|though\s+you\s+are)/i,
  /imagine\s+you\s+are/i,
  /for\s+the\s+purposes?\s+of\s+this/i,
  /let'?s?\s+say\s+you\s+are/i,
  /assume\s+the\s+role\s+of/i,
  /from\s+now\s+on\s+you\s+are/i,
  /i\s+want\s+you\s+to\s+act\s+as/i,
  /please\s+behave\s+as\s+if/i,
  /can\s+you\s+pretend/i,
]

// SMI-685: Prompt leaking attempt patterns
const PROMPT_LEAKING_PATTERNS = [
  /show\s+(me\s+)?your\s+(system\s+)?(instructions?|prompt)/i,
  /what\s+are\s+your\s+(\w+\s+)?rules/i,
  /reveal\s+your\s+(system\s+)?prompt/i,
  /display\s+your\s+(initial\s+)?instructions?/i,
  /output\s+your\s+(system\s+)?prompt/i,
  /print\s+your\s+(hidden\s+)?instructions?/i,
  /tell\s+me\s+your\s+(secret\s+)?instructions?/i,
  /what\s+(were|are)\s+you\s+(told|instructed)\s+to\s+do/i,
  /repeat\s+(back\s+)?your\s+(\w+\s+)?prompt/i,
  /what\s+is\s+your\s+(original\s+)?programming/i,
  /dump\s+(your\s+)?system\s+(prompt|instructions?)/i,
  /list\s+your\s+(hidden\s+)?directives?/i,
  /what\s+(constraints?|limitations?)\s+do\s+you\s+have/i,
  /echo\s+(back\s+)?your\s+(initial\s+)?prompt/i,
]

// SMI-685: Data exfiltration patterns
const DATA_EXFILTRATION_PATTERNS = [
  /btoa\s*\(/i, // Base64 encode in JS
  /atob\s*\(/i, // Base64 decode in JS
  /Buffer\.from\s*\([^)]*,\s*['"]base64['"]/i,
  /\.toString\s*\(\s*['"]base64['"]\s*\)/i,
  /encodeURIComponent\s*\(/i,
  /fetch\s*\(\s*['"`][^'"`]*\?.*=/i, // Fetch with query params
  /XMLHttpRequest/i,
  /navigator\.sendBeacon/i,
  /\.upload\s*\(/i,
  /formData\.append/i,
  /new\s+FormData/i,
  /multipart\/form-data/i,
  /webhook\s*[=:]/i,
  /exfil/i,
  /data\s*:\s*['"]/i, // Data URLs
  /\.writeFile.*https?:\/\//i,
  /send\s+.*(to|the)\s+(external|remote)/i,
  /upload\s+.*(to|the)\s+(server|cloud|remote)/i,
  /post\s+data\s+to/i,
  /to\s+external\s+(api|server|endpoint)/i,
]

// SMI-685: Privilege escalation patterns
const PRIVILEGE_ESCALATION_PATTERNS = [
  /sudo\s+.*(-S|--stdin)/i, // sudo with password from stdin
  /echo\s+.*\|\s*sudo/i, // Echo password to sudo
  /sudo\s+-S/i,
  /\bchmod\s+[0-7]*[4-7][0-7][0-7]\b/i, // chmod with setuid/setgid
  /\bchmod\s+\+s\b/i, // chmod setuid
  /\bchmod\s+777\b/i, // World writable
  /\bchmod\s+666\b/i, // World readable/writable
  /\bchown\s+root/i,
  /\bchgrp\s+root/i,
  /visudo/i,
  /\/etc\/sudoers/i,
  /NOPASSWD/i,
  /setuid/i,
  /setgid/i,
  /capability\s+cap_/i,
  /escalat(e|ion)/i,
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
 * Severity weights for risk score calculation
 */
const SEVERITY_WEIGHTS: Record<SecuritySeverity, number> = {
  low: 5,
  medium: 15,
  high: 30,
  critical: 50,
}

/**
 * Category weights for risk score calculation
 */
const CATEGORY_WEIGHTS: Record<string, number> = {
  jailbreak: 2.0,
  social_engineering: 1.5,
  prompt_leaking: 1.8,
  data_exfiltration: 1.7,
  privilege_escalation: 1.9,
  suspicious_pattern: 1.3,
  sensitive_path: 1.2,
  url: 0.8,
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
   */
  private scanSensitivePaths(content: string): SecurityFinding[] {
    const findings: SecurityFinding[] = []
    const lines = content.split('\n')

    lines.forEach((line, index) => {
      for (const pattern of SENSITIVE_PATH_PATTERNS) {
        if (pattern.test(line)) {
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
   */
  private scanJailbreakPatterns(content: string): SecurityFinding[] {
    const findings: SecurityFinding[] = []
    const lines = content.split('\n')

    lines.forEach((line, index) => {
      for (const pattern of JAILBREAK_PATTERNS) {
        const match = line.match(pattern)
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
   */
  private scanSuspiciousPatterns(content: string): SecurityFinding[] {
    const findings: SecurityFinding[] = []
    const lines = content.split('\n')

    lines.forEach((line, index) => {
      for (const pattern of SUSPICIOUS_PATTERNS) {
        const match = line.match(pattern)
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
        const match = line.match(pattern)
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
   * Detects patterns like "pretend to be", "roleplay as", "you are now"
   */
  private scanSocialEngineering(content: string): SecurityFinding[] {
    const findings: SecurityFinding[] = []
    const lines = content.split('\n')

    lines.forEach((line, index) => {
      for (const pattern of SOCIAL_ENGINEERING_PATTERNS) {
        const match = line.match(pattern)
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
   * Detects patterns like "show me your instructions", "what are your rules"
   */
  private scanPromptLeaking(content: string): SecurityFinding[] {
    const findings: SecurityFinding[] = []
    const lines = content.split('\n')

    lines.forEach((line, index) => {
      for (const pattern of PROMPT_LEAKING_PATTERNS) {
        const match = line.match(pattern)
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
   * Detects encoding to external URLs, file upload patterns
   */
  private scanDataExfiltration(content: string): SecurityFinding[] {
    const findings: SecurityFinding[] = []
    const lines = content.split('\n')

    lines.forEach((line, index) => {
      for (const pattern of DATA_EXFILTRATION_PATTERNS) {
        const match = line.match(pattern)
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
   * Detects sudo with passwords, chmod patterns, root access attempts
   */
  private scanPrivilegeEscalation(content: string): SecurityFinding[] {
    const findings: SecurityFinding[] = []
    const lines = content.split('\n')

    lines.forEach((line, index) => {
      for (const pattern of PRIVILEGE_ESCALATION_PATTERNS) {
        const match = line.match(pattern)
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
   */
  quickCheck(content: string): boolean {
    // Check for critical patterns only
    for (const pattern of JAILBREAK_PATTERNS) {
      if (pattern.test(content)) return false
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
