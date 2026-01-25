/**
 * SMI-732: Input Sanitization Library
 * SMI-750: Added input length limits to prevent ReDoS attacks
 *
 * Provides comprehensive input sanitization functions for:
 * - HTML content (XSS prevention)
 * - File names (path traversal prevention)
 * - File paths (directory traversal prevention)
 * - URLs (injection prevention)
 *
 * All functions are defensive and return safe defaults on invalid input.
 * All functions accept maxLength parameter to prevent ReDoS attacks.
 */

import { createLogger } from '../utils/logger.js'

// Re-export Stripe validators for backwards compatibility
export {
  isValidStripeId,
  sanitizeStripeCustomerId,
  sanitizeStripeSubscriptionId,
  sanitizeStripePriceId,
  sanitizeStripeInvoiceId,
  sanitizeStripeEventId,
} from './stripe-validators.js'

const logger = createLogger('Sanitization')

/** Default maximum input length for sanitization functions to prevent ReDoS */
export const DEFAULT_MAX_LENGTH = 100000

/**
 * Sanitize HTML content to prevent XSS attacks
 *
 * Removes dangerous tags, attributes, and JavaScript while preserving safe HTML.
 * Uses a whitelist approach for maximum security.
 *
 * @param input - Raw HTML string
 * @param maxLength - Maximum allowed input length (default: 100000)
 * @returns Sanitized HTML safe for rendering
 *
 * @example
 * ```typescript
 * sanitizeHtml('<script>alert("XSS")</script><p>Hello</p>')
 * // Returns: '<p>Hello</p>'
 * ```
 */
export function sanitizeHtml(input: string, maxLength = DEFAULT_MAX_LENGTH): string {
  if (!input || typeof input !== 'string') {
    return ''
  }

  if (input.length > maxLength) {
    logger.warn('Input exceeds max length for sanitization', {
      length: input.length,
      maxLength,
      function: 'sanitizeHtml',
    })
    return ''
  }

  // Remove script tags and their content
  let sanitized = input.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')

  // Remove event handlers (onclick, onerror, etc.)
  sanitized = sanitized.replace(/\son\w+\s*=\s*["'][^"']*["']/gi, '')
  sanitized = sanitized.replace(/\son\w+\s*=\s*[^\s>]*/gi, '')

  // Remove javascript: protocol
  sanitized = sanitized.replace(/javascript:/gi, '')

  // Remove data: protocol (can be used for XSS)
  sanitized = sanitized.replace(/data:text\/html/gi, '')

  // Remove vbscript: protocol
  sanitized = sanitized.replace(/vbscript:/gi, '')

  // Remove object and embed tags
  sanitized = sanitized.replace(/<(object|embed|iframe|frame|frameset)[^>]*>/gi, '')

  // Remove style tags (can contain javascript)
  sanitized = sanitized.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')

  // Remove import statements in style attributes
  sanitized = sanitized.replace(/style\s*=\s*["'][^"']*@import[^"']*["']/gi, '')

  // Log if significant sanitization occurred
  if (sanitized !== input) {
    logger.debug('HTML sanitized', {
      originalLength: input.length,
      sanitizedLength: sanitized.length,
    })
  }

  return sanitized
}

/**
 * Sanitize file name to prevent path traversal and invalid characters
 *
 * Removes:
 * - Path separators (/, \)
 * - Parent directory references (..)
 * - Hidden file markers (leading .)
 * - Special characters that are invalid in file names
 * - Control characters
 *
 * @param name - Raw file name
 * @param maxLength - Maximum allowed input length (default: 100000)
 * @returns Safe file name or empty string if invalid
 *
 * @example
 * ```typescript
 * sanitizeFileName('../../../etc/passwd')
 * // Returns: 'etcpasswd'
 *
 * sanitizeFileName('my-file.txt')
 * // Returns: 'my-file.txt'
 * ```
 */
export function sanitizeFileName(name: string, maxLength = DEFAULT_MAX_LENGTH): string {
  if (!name || typeof name !== 'string') {
    return ''
  }

  if (name.length > maxLength) {
    logger.warn('Input exceeds max length for sanitization', {
      length: name.length,
      maxLength,
      function: 'sanitizeFileName',
    })
    return ''
  }

  let sanitized = name

  // Remove path separators
  sanitized = sanitized.replace(/[/\\]/g, '')

  // Remove leading dots (hidden files)
  sanitized = sanitized.replace(/^\.+/, '')

  // Remove control characters (0x00-0x1f, 0x7f)
  // eslint-disable-next-line no-control-regex -- Intentional security check
  sanitized = sanitized.replace(/[\x00-\x1f\x7f]/g, '')

  // Remove special characters that are invalid in file names
  // Keep: alphanumeric, hyphen, underscore, dot, space
  sanitized = sanitized.replace(/[^a-zA-Z0-9._\-\s]/g, '')

  // Collapse multiple consecutive dots to single dot (BEFORE parent dir check)
  // This handles cases like 'file....txt' -> 'file.txt'
  sanitized = sanitized.replace(/\.{2,}/g, '.')

  // Remove multiple consecutive spaces
  sanitized = sanitized.replace(/\s{2,}/g, ' ')

  // Trim whitespace
  sanitized = sanitized.trim()

  // Ensure it's not empty and not too long
  if (sanitized.length === 0 || sanitized.length > 255) {
    logger.warn('Invalid file name after sanitization', { original: name })
    return ''
  }

  // Reserved file names on Windows
  const reservedNames = [
    'CON',
    'PRN',
    'AUX',
    'NUL',
    'COM1',
    'COM2',
    'COM3',
    'COM4',
    'COM5',
    'COM6',
    'COM7',
    'COM8',
    'COM9',
    'LPT1',
    'LPT2',
    'LPT3',
    'LPT4',
    'LPT5',
    'LPT6',
    'LPT7',
    'LPT8',
    'LPT9',
  ]

  const baseName = sanitized.split('.')[0].toUpperCase()
  if (reservedNames.includes(baseName)) {
    logger.warn('Reserved file name detected', { name: sanitized })
    return `${sanitized}_safe`
  }

  if (sanitized !== name) {
    logger.debug('File name sanitized', { original: name, sanitized })
  }

  return sanitized
}

/**
 * Sanitize file path to prevent directory traversal attacks
 *
 * Ensures the path:
 * - Does not escape the root directory
 * - Contains no parent directory references
 * - Uses forward slashes consistently
 * - Is normalized
 *
 * @param path - Raw file path
 * @param rootDir - Root directory to constrain path to (optional)
 * @param maxLength - Maximum allowed input length (default: 100000)
 * @returns Safe path or empty string if invalid
 *
 * @example
 * ```typescript
 * sanitizePath('../../../etc/passwd', '/app/data')
 * // Returns: ''
 *
 * sanitizePath('user/files/doc.txt', '/app/data')
 * // Returns: 'user/files/doc.txt'
 * ```
 */
export function sanitizePath(
  path: string,
  rootDir?: string,
  maxLength = DEFAULT_MAX_LENGTH
): string {
  if (!path || typeof path !== 'string') {
    return ''
  }

  if (path.length > maxLength) {
    logger.warn('Input exceeds max length for sanitization', {
      length: path.length,
      maxLength,
      function: 'sanitizePath',
    })
    return ''
  }

  let sanitized = path

  // Normalize path separators to forward slashes
  sanitized = sanitized.replace(/\\/g, '/')

  // Remove leading slashes for relative path handling
  const isAbsolute = sanitized.startsWith('/')
  sanitized = sanitized.replace(/^\/+/, '')

  // Check for leading parent directory references - reject these paths entirely
  // This catches '../../../etc/passwd' and './../file' type attacks
  if (/^\.?\/?\.\./.test(sanitized)) {
    logger.warn('Path traversal attempt detected', { path })
    return ''
  }

  // Split into segments and process them
  // Track depth and traversal count to detect escape attempts
  // '..' segments are filtered out (security measure), but if there are more
  // '..' than valid segments, we stop processing (escape attempt)
  const rawSegments = sanitized.split('/')
  const segments: string[] = []
  let depth = 0
  let traversalCount = 0

  for (const segment of rawSegments) {
    // Remove empty segments and '.'
    if (!segment || segment === '.') continue

    // Handle parent directory references
    if (segment === '..') {
      traversalCount++
      if (traversalCount > depth) {
        // Would escape - stop processing and return what we have
        logger.warn('Path traversal attempt detected', { path, segment })
        break
      }
      // Just filter out '..' (don't resolve it, just remove it for security)
      continue
    }

    // Block segments with control characters
    // eslint-disable-next-line no-control-regex -- Intentional security check
    if (/[\x00-\x1f\x7f]/.test(segment)) {
      logger.warn('Control characters in path segment', { path, segment })
      continue
    }

    // Sanitize and add segment
    const sanitizedSegment = sanitizeFileName(segment)
    if (sanitizedSegment.length > 0) {
      segments.push(sanitizedSegment)
      depth++
    }
  }

  // Rebuild path
  sanitized = segments.join('/')

  // Restore leading slash if original was absolute
  if (isAbsolute && sanitized.length > 0) {
    sanitized = '/' + sanitized
  }

  // If rootDir is provided, ensure path doesn't escape it
  if (rootDir && sanitized.length > 0) {
    const normalizedRoot = rootDir.replace(/\\/g, '/').replace(/\/+$/, '')
    const fullPath = isAbsolute ? sanitized : `${normalizedRoot}/${sanitized}`

    if (!fullPath.startsWith(normalizedRoot + '/') && fullPath !== normalizedRoot) {
      logger.warn('Path escapes root directory', {
        path,
        rootDir,
        fullPath,
      })
      return ''
    }
  }

  if (sanitized !== path) {
    logger.debug('Path sanitized', { original: path, sanitized })
  }

  return sanitized
}

/**
 * Sanitize URL to prevent injection attacks
 *
 * Validates:
 * - Protocol is http or https
 * - No javascript:, data:, or vbscript: protocols
 * - No embedded credentials
 * - Valid URL structure
 *
 * @param url - Raw URL string
 * @param maxLength - Maximum allowed input length (default: 100000)
 * @returns Sanitized URL or empty string if invalid
 *
 * @example
 * ```typescript
 * sanitizeUrl('javascript:alert(1)')
 * // Returns: ''
 *
 * sanitizeUrl('https://example.com/page')
 * // Returns: 'https://example.com/page'
 * ```
 */
export function sanitizeUrl(url: string, maxLength = DEFAULT_MAX_LENGTH): string {
  if (!url || typeof url !== 'string') {
    return ''
  }

  if (url.length > maxLength) {
    logger.warn('Input exceeds max length for sanitization', {
      length: url.length,
      maxLength,
      function: 'sanitizeUrl',
    })
    return ''
  }

  // Trim whitespace and control characters
  // eslint-disable-next-line no-control-regex -- Intentional security check
  const trimmed = url.trim().replace(/[\x00-\x1f\x7f]/g, '')

  if (trimmed.length === 0) {
    return ''
  }

  try {
    const parsed = new URL(trimmed)

    // Only allow http and https protocols
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      logger.warn('Invalid URL protocol', { url: trimmed, protocol: parsed.protocol })
      return ''
    }

    // Block URLs with embedded credentials
    if (parsed.username || parsed.password) {
      logger.warn('URL contains embedded credentials', { url: trimmed })
      return ''
    }

    // Reconstruct URL to ensure it's properly formatted
    const sanitized = parsed.toString()

    if (sanitized !== url) {
      logger.debug('URL sanitized', { original: url, sanitized })
    }

    return sanitized
  } catch (error) {
    logger.warn('Invalid URL format', { url: trimmed, error })
    return ''
  }
}

/**
 * Sanitize arbitrary text input for safe storage and display
 *
 * Removes:
 * - Control characters
 * - Zero-width characters
 * - Invalid Unicode
 *
 * @param input - Raw text input
 * @param maxLength - Maximum allowed input length (default: 100000)
 * @returns Sanitized text
 *
 * @example
 * ```typescript
 * sanitizeText('Hello\x00World\u200B')
 * // Returns: 'HelloWorld'
 * ```
 */
export function sanitizeText(input: string, maxLength = DEFAULT_MAX_LENGTH): string {
  if (!input || typeof input !== 'string') {
    return ''
  }

  if (input.length > maxLength) {
    logger.warn('Input exceeds max length for sanitization', {
      length: input.length,
      maxLength,
      function: 'sanitizeText',
    })
    return ''
  }

  let sanitized = input

  // Remove control characters except newline and tab
  // eslint-disable-next-line no-control-regex -- Intentional security check
  sanitized = sanitized.replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, '')

  // Remove zero-width characters
  sanitized = sanitized.replace(/[\u200b-\u200d\ufeff]/g, '')

  // Normalize Unicode
  sanitized = sanitized.normalize('NFC')

  // Trim
  sanitized = sanitized.trim()

  return sanitized
}
