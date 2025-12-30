/**
 * Validation Utilities (SMI-726)
 *
 * Centralized validation patterns for security-critical operations.
 * Extracted from RawUrlSourceAdapter and LocalFilesystemAdapter.
 *
 * Security Features:
 * - SSRF prevention (SMI-721, SMI-729)
 * - Path traversal prevention (SMI-720)
 * - RegExp injection prevention (SMI-722)
 */

import { resolve } from 'path'

/**
 * Validation error thrown when input fails security checks
 */
export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: unknown
  ) {
    super(message)
    this.name = 'ValidationError'
  }
}

/**
 * Validate URL to prevent SSRF attacks (SMI-721, SMI-729)
 *
 * Blocks:
 * - Non-http(s) protocols
 * - Private IPv4 ranges (10.x, 172.16-31.x, 192.168.x)
 * - Private IPv6 ranges (fe80::/10, fc00::/7, ff00::/8, ::ffff:0:0/96)
 * - Localhost variants (127.x, localhost, ::1, 0.0.0.0)
 * - Link-local addresses (169.254.x, fe80::/10)
 * - Current network (0.x)
 *
 * @param url - URL to validate
 * @throws {ValidationError} if URL is not allowed
 *
 * @example
 * ```typescript
 * validateUrl('https://example.com/api')  // OK
 * validateUrl('http://localhost:3000')    // Throws ValidationError
 * validateUrl('ftp://example.com')        // Throws ValidationError
 * validateUrl('http://192.168.1.1')       // Throws ValidationError
 * validateUrl('http://[fe80::1]')         // Throws ValidationError (IPv6 link-local)
 * ```
 */
export function validateUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch (error) {
    throw new ValidationError(`Invalid URL format: ${url}`, 'INVALID_URL_FORMAT', error)
  }

  // Only allow http/https protocols
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ValidationError(
      `Invalid protocol: ${parsed.protocol}. Only http and https are allowed.`,
      'INVALID_PROTOCOL',
      { protocol: parsed.protocol, url }
    )
  }

  let hostname = parsed.hostname.toLowerCase()

  // Strip brackets from IPv6 addresses for easier comparison
  // Node.js URL keeps brackets in hostname for IPv6 (e.g., "[::1]")
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1)
  }

  // Block localhost variants
  if (hostname === 'localhost' || hostname === '::1' || hostname === '0.0.0.0') {
    throw new ValidationError(`Access to localhost is blocked: ${hostname}`, 'LOCALHOST_BLOCKED', {
      hostname,
      url,
    })
  }

  // Check for IPv4 addresses
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4Match) {
    const [, a, b, c, d] = ipv4Match.map(Number)

    // Validate IPv4 octets are in valid range
    if (a > 255 || b > 255 || c > 255 || d > 255) {
      throw new ValidationError(`Invalid IPv4 address: ${hostname}`, 'INVALID_IPV4', {
        hostname,
        url,
      })
    }

    // Block private/internal IP ranges
    if (
      a === 10 || // 10.0.0.0/8 - Private network
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 - Private network
      (a === 192 && b === 168) || // 192.168.0.0/16 - Private network
      a === 127 || // 127.0.0.0/8 - Loopback
      (a === 169 && b === 254) || // 169.254.0.0/16 - Link-local
      a === 0 // 0.0.0.0/8 - Current network
    ) {
      throw new ValidationError(
        `Access to private/internal network blocked: ${hostname}`,
        'PRIVATE_NETWORK_BLOCKED',
        { hostname, url, ipRange: getIpRangeName(a, b) }
      )
    }
  }

  // Check for IPv6 addresses (SMI-729)
  // IPv6 addresses in URLs are enclosed in square brackets, but hostname strips them
  if (hostname.includes(':')) {
    validateIPv6(hostname, url)
  }
}

/**
 * Validate IPv6 address to prevent SSRF attacks (SMI-729)
 *
 * Blocks:
 * - Link-local: fe80::/10
 * - Unique local addresses (ULA): fc00::/7
 * - Multicast: ff00::/8
 * - IPv4-mapped IPv6: ::ffff:0:0/96
 * - Loopback ::1 (already blocked above)
 *
 * @param hostname - IPv6 hostname to validate
 * @param url - Full URL for error context
 * @throws {ValidationError} if IPv6 address is not allowed
 */
function validateIPv6(hostname: string, url: string): void {
  // Normalize IPv6 address
  const normalized = hostname.toLowerCase()

  // Block IPv6 loopback (::1 and its full form)
  // This is defense-in-depth since line 76 should also catch ::1
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    throw new ValidationError(`Access to localhost is blocked: ${hostname}`, 'LOCALHOST_BLOCKED', {
      hostname,
      url,
    })
  }

  // Block link-local addresses (fe80::/10)
  // fe80 to febf range
  if (
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  ) {
    throw new ValidationError(
      `Access to IPv6 link-local address blocked: ${hostname}`,
      'IPV6_LINK_LOCAL_BLOCKED',
      { hostname, url }
    )
  }

  // Block unique local addresses (fc00::/7)
  // fc00 to fdff range
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
    throw new ValidationError(
      `Access to IPv6 unique local address blocked: ${hostname}`,
      'IPV6_ULA_BLOCKED',
      { hostname, url }
    )
  }

  // Block multicast addresses (ff00::/8)
  if (normalized.startsWith('ff')) {
    throw new ValidationError(
      `Access to IPv6 multicast address blocked: ${hostname}`,
      'IPV6_MULTICAST_BLOCKED',
      { hostname, url }
    )
  }

  // Block IPv4-mapped IPv6 addresses (::ffff:0:0/96)
  // These map IPv4 addresses into IPv6 space
  if (normalized.includes('::ffff:')) {
    // Extract the IPv4 part and validate it
    const ipv4Part = normalized.split('::ffff:')[1]
    if (ipv4Part) {
      // Check if it's in dotted decimal notation
      const ipv4Match = ipv4Part.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})/)
      if (ipv4Match) {
        const [, a, b] = ipv4Match.map(Number)
        // Apply same private IP checks as IPv4
        if (
          a === 10 ||
          (a === 172 && b >= 16 && b <= 31) ||
          (a === 192 && b === 168) ||
          a === 127 ||
          (a === 169 && b === 254) ||
          a === 0
        ) {
          throw new ValidationError(
            `Access to IPv4-mapped IPv6 private address blocked: ${hostname}`,
            'IPV4_MAPPED_IPV6_BLOCKED',
            { hostname, url, ipRange: getIpRangeName(a, b) }
          )
        }
      } else {
        // IPv4 in hex notation (e.g., ::ffff:c0a8:0001)
        // Block all ::ffff: to be safe
        throw new ValidationError(
          `Access to IPv4-mapped IPv6 address blocked: ${hostname}`,
          'IPV4_MAPPED_IPV6_BLOCKED',
          { hostname, url }
        )
      }
    }
  }
}

/**
 * Get human-readable IP range name for error messages
 */
function getIpRangeName(a: number, b: number): string {
  if (a === 10) return '10.0.0.0/8 (Private)'
  if (a === 172 && b >= 16 && b <= 31) return '172.16.0.0/12 (Private)'
  if (a === 192 && b === 168) return '192.168.0.0/16 (Private)'
  if (a === 127) return '127.0.0.0/8 (Loopback)'
  if (a === 169 && b === 254) return '169.254.0.0/16 (Link-local)'
  if (a === 0) return '0.0.0.0/8 (Current network)'
  return 'Unknown'
}

/**
 * Validate file path to prevent path traversal attacks (SMI-720)
 *
 * Ensures the resolved path remains within the allowed root directory.
 *
 * @param path - Path to validate (can be relative or absolute)
 * @param rootDir - Root directory that must contain the path
 * @throws {ValidationError} if path escapes root directory
 *
 * @example
 * ```typescript
 * validatePath('skills/my-skill', '/home/user/.claude')  // OK
 * validatePath('../etc/passwd', '/home/user/.claude')    // Throws ValidationError
 * validatePath('/etc/passwd', '/home/user/.claude')      // Throws ValidationError
 * ```
 */
export function validatePath(path: string, rootDir: string): void {
  if (!path) {
    throw new ValidationError('Path cannot be empty', 'EMPTY_PATH')
  }

  if (!rootDir) {
    throw new ValidationError('Root directory cannot be empty', 'EMPTY_ROOT_DIR')
  }

  // Normalize both paths to resolve '..' and '.'
  // Resolve path relative to rootDir so relative paths work correctly
  const normalizedPath = resolve(rootDir, path)
  const normalizedRoot = resolve(rootDir)

  // Check that normalized path is within root directory
  // Handle edge case where path equals root exactly
  const isWithinRoot =
    normalizedPath.startsWith(normalizedRoot + '/') || normalizedPath === normalizedRoot

  if (!isWithinRoot) {
    throw new ValidationError(`Path traversal detected: ${path}`, 'PATH_TRAVERSAL', {
      originalPath: path,
      normalizedPath,
      rootDir,
      normalizedRoot,
    })
  }
}

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
    } catch (error) {
      warnings.push(`Invalid regex pattern: ${pattern}`)
    }
  }

  return warnings
}
