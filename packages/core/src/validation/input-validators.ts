/**
 * Input Validation Utilities
 *
 * General input sanitization and pattern matching.
 *
 * Security Features:
 * - RegExp injection prevention (SMI-722)
 * - Input sanitization
 * - Pattern validation
 */

/**
 * Sanitize input string for safe use in various contexts
 *
 * Removes or escapes potentially dangerous characters.
 *
 * @param input - Input string to sanitize
 * @param options - Sanitization options
 * @returns Sanitized string
 *
 * @example
 * ```typescript
 * sanitizeInput('<script>alert(1)</script>')  // Returns: '&lt;script&gt;alert(1)&lt;/script&gt;'
 * sanitizeInput('../../etc/passwd')           // Returns: 'etc/passwd'
 * ```
 */
export function sanitizeInput(
  input: string,
  options: {
    /** Remove path traversal sequences like '../' (default: true) */
    removePathTraversal?: boolean
    /** HTML-escape special characters (default: true) */
    escapeHtml?: boolean
    /** Remove null bytes (default: true) */
    removeNullBytes?: boolean
  } = {}
): string {
  const { removePathTraversal = true, escapeHtml = true, removeNullBytes = true } = options

  let sanitized = input

  // Remove null bytes (security risk)
  if (removeNullBytes) {
    sanitized = sanitized.replace(/\0/g, '')
  }

  // Remove path traversal sequences
  if (removePathTraversal) {
    // Remove '../' and '..\' patterns
    sanitized = sanitized.replace(/\.\.[\\/]/g, '')
    // Remove leading '../' or '..\'
    sanitized = sanitized.replace(/^\.\.[\\/]+/, '')
  }

  // HTML escape
  if (escapeHtml) {
    sanitized = sanitized
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
  }

  return sanitized
}

/**
 * Safely test a string against a pattern, preventing RegExp injection (SMI-722)
 *
 * Tries exact match, prefix match, and regex match (with error handling).
 * Falls back to includes check if regex is invalid.
 *
 * @param value - Value to test
 * @param pattern - Pattern to match (string or regex)
 * @returns True if value matches pattern
 *
 * @example
 * ```typescript
 * safePatternMatch('node_modules', 'node_modules')  // true (exact)
 * safePatternMatch('node_modules/pkg', 'node_')     // true (prefix)
 * safePatternMatch('test.js', '\\.js$')             // true (regex)
 * safePatternMatch('test.js', '(evil')              // false (invalid regex, falls back)
 * ```
 */
export function safePatternMatch(value: string, pattern: string): boolean {
  // Exact match
  if (value === pattern) {
    return true
  }

  // Check if pattern looks like a regex (contains special chars)
  // If it's a simple alphanumeric pattern, only do prefix matching
  const isLikelyRegex = /[\\^$.*+?()[\]{}|]/.test(pattern)

  if (!isLikelyRegex) {
    // Simple pattern - only match as prefix
    return value.startsWith(pattern)
  }

  // Try regex match with error handling for patterns that look like regex
  try {
    const regex = new RegExp(pattern)
    return regex.test(value)
  } catch {
    // Invalid regex - fall back to safe includes check
    return value.includes(pattern)
  }
}

/**
 * Validate that patterns array is safe to use
 *
 * Checks for potentially dangerous regex patterns that could cause ReDoS.
 *
 * @param patterns - Array of patterns to validate
 * @returns Array of validation warnings (empty if all patterns are safe)
 *
 * @example
 * ```typescript
 * validatePatterns(['node_modules', '\\.js$'])  // []
 * validatePatterns(['(a+)+b'])                  // ['Pattern may cause ReDoS: (a+)+b']
 * ```
 */
export function validatePatterns(patterns: string[]): string[] {
  const warnings: string[] = []

  for (const pattern of patterns) {
    // Check for potentially dangerous nested quantifiers (ReDoS)
    if (/(\(.*\+.*\))\+/.test(pattern) || /(\(.*\*.*\))\*/.test(pattern)) {
      warnings.push(`Pattern may cause ReDoS (nested quantifiers): ${pattern}`)
    }

    // Check for extremely long patterns
    if (pattern.length > 1000) {
      warnings.push(
        `Pattern is suspiciously long (${pattern.length} chars): ${pattern.slice(0, 50)}...`
      )
    }

    // Try to compile as regex to check validity
    try {
      new RegExp(pattern)
    } catch {
      warnings.push(`Invalid regex pattern: ${pattern}`)
    }
  }

  return warnings
}
