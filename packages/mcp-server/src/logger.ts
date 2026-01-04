/**
 * SMI-583: Logging utility for MCP server
 * SMI-883: Sanitizes sensitive data before logging to prevent data leakage
 * Logs errors to ~/.skillsmith/logs/
 */

import { existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * SMI-883: Sensitive data patterns to redact before logging
 * Prevents API keys, tokens, passwords, and secrets from being written to disk
 */
const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // GitHub tokens
  { pattern: /\b(ghp_[a-zA-Z0-9]{36})\b/g, replacement: 'ghp_[REDACTED]' },
  { pattern: /\b(github_pat_[a-zA-Z0-9_]{22,})\b/g, replacement: 'github_pat_[REDACTED]' },
  { pattern: /\b(gho_[a-zA-Z0-9]{36})\b/g, replacement: 'gho_[REDACTED]' },
  { pattern: /\b(ghs_[a-zA-Z0-9]{36})\b/g, replacement: 'ghs_[REDACTED]' },
  { pattern: /\b(ghu_[a-zA-Z0-9]{36})\b/g, replacement: 'ghu_[REDACTED]' },
  { pattern: /\b(ghr_[a-zA-Z0-9]{36})\b/g, replacement: 'ghr_[REDACTED]' },
  // Linear API keys
  { pattern: /\b(lin_api_[a-zA-Z0-9]{32,})\b/g, replacement: 'lin_api_[REDACTED]' },
  // Stripe keys
  { pattern: /\b(sk_live_[a-zA-Z0-9]{24,})\b/g, replacement: 'sk_live_[REDACTED]' },
  { pattern: /\b(sk_test_[a-zA-Z0-9]{24,})\b/g, replacement: 'sk_test_[REDACTED]' },
  { pattern: /\b(pk_live_[a-zA-Z0-9]{24,})\b/g, replacement: 'pk_live_[REDACTED]' },
  { pattern: /\b(pk_test_[a-zA-Z0-9]{24,})\b/g, replacement: 'pk_test_[REDACTED]' },
  // OpenAI API keys
  { pattern: /\b(sk-[a-zA-Z0-9]{48,})\b/g, replacement: 'sk-[REDACTED]' },
  // Anthropic API keys
  { pattern: /\b(sk-ant-[a-zA-Z0-9-]{32,})\b/g, replacement: 'sk-ant-[REDACTED]' },
  // AWS keys
  { pattern: /\b(AKIA[A-Z0-9]{16})\b/g, replacement: 'AKIA[REDACTED]' },
  // Slack tokens
  { pattern: /\b(xox[boaprs]-[a-zA-Z0-9-]{10,})\b/g, replacement: 'xox*-[REDACTED]' },
  // npm tokens
  { pattern: /\b(npm_[a-zA-Z0-9]{36})\b/g, replacement: 'npm_[REDACTED]' },
  // Bearer tokens
  { pattern: /\bBearer\s+([a-zA-Z0-9_\-.]{20,})/gi, replacement: 'Bearer [REDACTED]' },
  // Basic auth
  { pattern: /\bBasic\s+([a-zA-Z0-9+/=]{20,})/gi, replacement: 'Basic [REDACTED]' },
  // JWT tokens
  {
    pattern: /\beyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]+\b/g,
    replacement: '[JWT_REDACTED]',
  },
  // Generic API key patterns
  {
    pattern: /\b(api[_-]?key|apikey)\s*[=:]\s*["']?([a-zA-Z0-9_-]{8,})["']?/gi,
    replacement: 'api_key=[REDACTED]',
  },
  {
    pattern: /\b(token|auth[_-]?token)\s*[=:]\s*["']?([a-zA-Z0-9_-]{8,})["']?/gi,
    replacement: 'token=[REDACTED]',
  },
  {
    pattern: /\b(password|passwd|pwd)\s*[=:]\s*["']?([^"'\s]{4,})["']?/gi,
    replacement: 'password=[REDACTED]',
  },
  {
    pattern: /\b(secret|client[_-]?secret)\s*[=:]\s*["']?([a-zA-Z0-9_-]{8,})["']?/gi,
    replacement: 'secret=[REDACTED]',
  },
  // Connection strings with passwords
  { pattern: /(:\/\/[^:]+:)([^@]+)(@)/gi, replacement: '$1[REDACTED]$3' },
  // Private keys
  {
    pattern:
      /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(RSA\s+)?PRIVATE\s+KEY-----/gi,
    replacement: '-----[PRIVATE KEY REDACTED]-----',
  },
]

/**
 * SMI-883: Redact sensitive data from text before logging
 * Exported for testing purposes
 */
export function redactSensitiveData(text: string): string {
  if (!text) return text
  let redacted = text
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    // Reset lastIndex for global regex patterns to ensure all matches are found
    pattern.lastIndex = 0
    redacted = redacted.replace(pattern, replacement)
  }
  return redacted
}

/**
 * SMI-883: Recursively redact sensitive data from objects
 * Exported for testing purposes
 */
export function redactSensitiveObject(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj
  if (typeof obj === 'string') return redactSensitiveData(obj)
  if (Array.isArray(obj)) return obj.map(redactSensitiveObject)
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      result[key] = redactSensitiveObject(value)
    }
    return result
  }
  return obj
}

const LOG_DIR = join(homedir(), '.skillsmith', 'logs')

/**
 * Ensure log directory exists
 */
function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true })
  }
}

/**
 * Format date for log filename
 */
function getLogFilename(): string {
  const date = new Date()
  const dateStr = date.toISOString().split('T')[0]
  return join(LOG_DIR, 'mcp-server-' + dateStr + '.log')
}

/**
 * Format log entry
 * SMI-883: Sanitizes message and details to prevent sensitive data leakage
 */
function formatLogEntry(level: string, message: string, details?: unknown): string {
  const timestamp = new Date().toISOString()
  // SMI-883: Redact sensitive data from message
  const sanitizedMessage = redactSensitiveData(message)
  let entry = '[' + timestamp + '] [' + level + '] ' + sanitizedMessage

  if (details !== undefined) {
    try {
      // SMI-883: Redact sensitive data from details object before serialization
      const sanitizedDetails = redactSensitiveObject(details)
      entry += '\n  Details: ' + JSON.stringify(sanitizedDetails, null, 2).replace(/\n/g, '\n  ')
    } catch {
      entry += '\n  Details: [Unable to serialize]'
    }
  }

  return entry + '\n'
}

/**
 * Write log entry to file
 */
function writeLog(level: string, message: string, details?: unknown): void {
  try {
    ensureLogDir()
    const entry = formatLogEntry(level, message, details)
    appendFileSync(getLogFilename(), entry)
  } catch {
    // Silently fail if unable to write logs
    // Don't want logging failures to break the application
  }
}

/**
 * Logger interface
 */
export const logger = {
  info(message: string, details?: unknown): void {
    writeLog('INFO', message, details)
  },

  warn(message: string, details?: unknown): void {
    writeLog('WARN', message, details)
  },

  error(message: string, details?: unknown): void {
    writeLog('ERROR', message, details)
  },

  debug(message: string, details?: unknown): void {
    if (process.env.DEBUG) {
      writeLog('DEBUG', message, details)
    }
  },
}

export default logger
