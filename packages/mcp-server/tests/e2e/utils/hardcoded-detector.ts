/**
 * Hardcoded Value Detection Utility
 *
 * Scans command output and file contents for hardcoded values that
 * would fail in clean environments (Codespaces).
 *
 * @see docs/testing/e2e-testing-plan.md
 */

export interface HardcodedIssue {
  type: 'path' | 'url' | 'credential' | 'env_assumption'
  pattern: string
  value: string
  location: {
    source: 'stdout' | 'stderr' | 'file' | 'database'
    context?: string | undefined
    line?: number | undefined
  }
  command: string
  timestamp: string
  severity: 'error' | 'warning'
}

export interface DetectionResult {
  passed: boolean
  issues: HardcodedIssue[]
  scannedBytes: number
  scanDurationMs: number
}

/**
 * Patterns for detecting hardcoded values
 */
const DETECTION_PATTERNS = {
  // User-specific paths (high severity)
  userPaths: [
    { pattern: /\/Users\/[a-zA-Z0-9_-]+\//g, name: 'macOS user path' },
    { pattern: /\/home\/[a-zA-Z0-9_-]+\//g, name: 'Linux user path' },
    { pattern: /C:\\Users\\[a-zA-Z0-9_-]+\\/g, name: 'Windows user path' },
    { pattern: /~\/(?!\.claude)/g, name: 'Home directory shorthand' },
  ],

  // Localhost/dev URLs (medium severity)
  devUrls: [
    { pattern: /localhost:\d+/g, name: 'localhost with port' },
    { pattern: /127\.0\.0\.1(:\d+)?/g, name: 'IPv4 loopback' },
    { pattern: /0\.0\.0\.0(:\d+)?/g, name: 'All interfaces bind' },
    { pattern: /\[::1\](:\d+)?/g, name: 'IPv6 loopback' },
  ],

  // Hardcoded credentials (critical severity)
  credentials: [
    // AI & LLM Services
    { pattern: /sk-[a-zA-Z0-9]{32,}(?![a-zA-Z0-9])/g, name: 'OpenAI API key' },
    { pattern: /sk-ant-[a-zA-Z0-9-]+/g, name: 'Anthropic API key' },

    // Version Control & Collaboration
    { pattern: /ghp_[a-zA-Z0-9]{36}/g, name: 'GitHub personal token' },
    { pattern: /gho_[a-zA-Z0-9]{36}/g, name: 'GitHub OAuth token' },
    { pattern: /ghu_[a-zA-Z0-9]{36}/g, name: 'GitHub user-to-server token' },
    { pattern: /ghs_[a-zA-Z0-9]{36}/g, name: 'GitHub server-to-server token' },
    { pattern: /lin_api_[a-zA-Z0-9]+/g, name: 'Linear API key' },

    // Communication Platforms
    { pattern: /xoxb-[a-zA-Z0-9-]+/g, name: 'Slack bot token' },
    { pattern: /xoxp-[a-zA-Z0-9-]+/g, name: 'Slack user token' },
    { pattern: /xoxa-[a-zA-Z0-9-]+/g, name: 'Slack app token' },

    // Payment Processing
    { pattern: /sk_live_[a-zA-Z0-9]{24,}/g, name: 'Stripe secret key (live)' },
    { pattern: /sk_test_[a-zA-Z0-9]{24,}/g, name: 'Stripe secret key (test)' },
    { pattern: /pk_live_[a-zA-Z0-9]{24,}/g, name: 'Stripe publishable key (live)' },
    { pattern: /pk_test_[a-zA-Z0-9]{24,}/g, name: 'Stripe publishable key (test)' },
    { pattern: /rk_live_[a-zA-Z0-9]{24,}/g, name: 'Stripe restricted API key (live)' },
    { pattern: /rk_test_[a-zA-Z0-9]{24,}/g, name: 'Stripe restricted API key (test)' },

    // Cloud Platforms
    { pattern: /AKIA[0-9A-Z]{16}/g, name: 'AWS access key ID' },
    { pattern: /aws_secret_access_key\s*=\s*[a-zA-Z0-9/+=]{40}/g, name: 'AWS secret access key' },

    // Email & Communication Services
    { pattern: /SG\.[a-zA-Z0-9_-]{60,}/g, name: 'SendGrid API key' },

    // Telecommunications
    { pattern: /SK[a-f0-9]{32}/g, name: 'Twilio auth token' },
    { pattern: /AC[a-f0-9]{32}/g, name: 'Twilio account SID' },

    // Authentication & Tokens
    {
      pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
      name: 'JWT token',
    },

    // Generic Credential Patterns (lower confidence - check context)
    { pattern: /password\s*=\s*[^\s;'"`]+(?![.\w])/g, name: 'Hardcoded password assignment' },
    { pattern: /secret\s*=\s*[^\s;'"`]{12,}/g, name: 'Hardcoded secret assignment' },
    { pattern: /api[_-]?key\s*=\s*[^\s;'"`]{16,}/gi, name: 'Hardcoded API key assignment' },
    { pattern: /token\s*=\s*[^\s;'"`]{32,}/g, name: 'Hardcoded token assignment' },

    // Database Connection Strings with Passwords
    {
      pattern: /(?:postgres|postgresql):\/\/[^@]+:[^@]+@[^\s'"`]+/g,
      name: 'PostgreSQL connection string with password',
    },
    {
      pattern: /(?:mysql|mariadb):\/\/[^@]+:[^@]+@[^\s'"`]+/g,
      name: 'MySQL connection string with password',
    },
    {
      pattern: /(?:mongodb|mongodb\+srv):\/\/[^@]+:[^@]+@[^\s'"`]+/g,
      name: 'MongoDB connection string with password',
    },
    {
      pattern: /sqlserver:\/\/[^;]*password=[^;]+/gi,
      name: 'SQL Server connection string with password',
    },
  ],

  // Environment assumptions (medium severity)
  envAssumptions: [
    { pattern: /\.skillsmith\/skills\.db(?!['"])/g, name: 'Hardcoded DB path' },
    { pattern: /\/tmp\/skillsmith(?!-e2e)/g, name: 'Hardcoded temp path' },
  ],
}

// Allowlist for known safe patterns (e.g., in security tests, documentation, examples)
const ALLOWLIST_CONTEXTS = [
  'security.test',
  'validation.test',
  '.security.test',
  'RawUrlSourceAdapter',
  'example',
  'mock',
  'stub',
  'fixture',
  'README',
  'EXAMPLE',
  'documentation',
  'docs',
  '.md',
]

/**
 * Check if a match should be allowed based on context
 */
function isAllowlisted(context: string | undefined): boolean {
  if (!context) return false
  return ALLOWLIST_CONTEXTS.some((allowed) => context.includes(allowed))
}

/**
 * Scan text content for hardcoded values
 */
export function scanForHardcoded(
  content: string,
  command: string,
  source: 'stdout' | 'stderr' | 'file' | 'database',
  context?: string
): HardcodedIssue[] {
  const issues: HardcodedIssue[] = []
  const timestamp = new Date().toISOString()

  // Skip allowlisted contexts
  if (isAllowlisted(context)) {
    return issues
  }

  // Scan for user paths
  for (const { pattern, name } of DETECTION_PATTERNS.userPaths) {
    const matches = content.matchAll(pattern)
    for (const match of matches) {
      issues.push({
        type: 'path',
        pattern: name,
        value: match[0],
        location: { source, context },
        command,
        timestamp,
        severity: 'error',
      })
    }
  }

  // Scan for dev URLs
  for (const { pattern, name } of DETECTION_PATTERNS.devUrls) {
    const matches = content.matchAll(pattern)
    for (const match of matches) {
      issues.push({
        type: 'url',
        pattern: name,
        value: match[0],
        location: { source, context },
        command,
        timestamp,
        severity: 'warning',
      })
    }
  }

  // Scan for credentials
  for (const { pattern, name } of DETECTION_PATTERNS.credentials) {
    const matches = content.matchAll(pattern)
    for (const match of matches) {
      issues.push({
        type: 'credential',
        pattern: name,
        value: maskCredential(match[0]),
        location: { source, context },
        command,
        timestamp,
        severity: 'error',
      })
    }
  }

  // Scan for environment assumptions
  for (const { pattern, name } of DETECTION_PATTERNS.envAssumptions) {
    const matches = content.matchAll(pattern)
    for (const match of matches) {
      issues.push({
        type: 'env_assumption',
        pattern: name,
        value: match[0],
        location: { source, context },
        command,
        timestamp,
        severity: 'warning',
      })
    }
  }

  return issues
}

/**
 * Mask sensitive credential values for safe logging
 */
function maskCredential(value: string): string {
  if (value.length <= 8) return '***'
  return value.substring(0, 4) + '***' + value.substring(value.length - 4)
}

/**
 * Scan command execution result for hardcoded values
 */
export function scanCommandOutput(
  stdout: string,
  stderr: string,
  command: string
): DetectionResult {
  const startTime = Date.now()
  const issues: HardcodedIssue[] = []

  issues.push(...scanForHardcoded(stdout, command, 'stdout'))
  issues.push(...scanForHardcoded(stderr, command, 'stderr'))

  return {
    passed: issues.filter((i) => i.severity === 'error').length === 0,
    issues,
    scannedBytes: stdout.length + stderr.length,
    scanDurationMs: Date.now() - startTime,
  }
}

/**
 * Create a summary report of detected issues
 */
export function createDetectionReport(results: DetectionResult[]): string {
  const allIssues = results.flatMap((r) => r.issues)
  const errors = allIssues.filter((i) => i.severity === 'error')
  const warnings = allIssues.filter((i) => i.severity === 'warning')

  const lines: string[] = [
    '# Hardcoded Value Detection Report',
    '',
    `**Scan Time**: ${new Date().toISOString()}`,
    `**Total Scanned**: ${results.reduce((sum, r) => sum + r.scannedBytes, 0)} bytes`,
    '',
    '## Summary',
    '',
    `- **Errors**: ${errors.length}`,
    `- **Warnings**: ${warnings.length}`,
    `- **Status**: ${errors.length === 0 ? 'PASSED' : 'FAILED'}`,
    '',
  ]

  if (errors.length > 0) {
    lines.push('## Errors (Must Fix)', '')
    lines.push('| Type | Pattern | Value | Command | Source |')
    lines.push('|------|---------|-------|---------|--------|')
    for (const issue of errors) {
      lines.push(
        `| ${issue.type} | ${issue.pattern} | \`${issue.value}\` | ${issue.command} | ${issue.location.source} |`
      )
    }
    lines.push('')
  }

  if (warnings.length > 0) {
    lines.push('## Warnings (Review Required)', '')
    lines.push('| Type | Pattern | Value | Command | Source |')
    lines.push('|------|---------|-------|---------|--------|')
    for (const issue of warnings) {
      lines.push(
        `| ${issue.type} | ${issue.pattern} | \`${issue.value}\` | ${issue.command} | ${issue.location.source} |`
      )
    }
    lines.push('')
  }

  return lines.join('\n')
}

export default {
  scanForHardcoded,
  scanCommandOutput,
  createDetectionReport,
}
