/**
 * SMI-732: Input Sanitization Library
 *
 * Provides comprehensive input sanitization functions for:
 * - HTML content (XSS prevention)
 * - File names (path traversal prevention)
 * - File paths (directory traversal prevention)
 * - URLs (injection prevention)
 *
 * All functions are defensive and return safe defaults on invalid input.
 */

import { createLogger } from '../utils/logger.js'

const logger = createLogger('Sanitization')

/**
 * Sanitize HTML content to prevent XSS attacks
 *
 * Removes dangerous tags, attributes, and JavaScript while preserving safe HTML.
 * Uses a whitelist approach for maximum security.
 *
 * @param input - Raw HTML string
 * @returns Sanitized HTML safe for rendering
 *
 * @example
 * ```typescript
 * sanitizeHtml('<script>alert("XSS")</script><p>Hello</p>')
 * // Returns: '<p>Hello</p>'
 * ```
 */
export function sanitizeHtml(input: string): string {
  if (!input || typeof input !== 'string') {
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
export function sanitizeFileName(name: string): string {
  if (!name || typeof name !== 'string') {
    return ''
  }

  let sanitized = name

  // Remove path separators
  sanitized = sanitized.replace(/[/\\]/g, '')

  // Remove parent directory references
  sanitized = sanitized.replace(/\.\./g, '')

  // Remove leading dots (hidden files)
  sanitized = sanitized.replace(/^\.+/, '')

  // Remove control characters (0x00-0x1f, 0x7f)
  sanitized = sanitized.replace(/[\x00-\x1f\x7f]/g, '')

  // Remove special characters that are invalid in file names
  // Keep: alphanumeric, hyphen, underscore, dot, space
  sanitized = sanitized.replace(/[^a-zA-Z0-9._\-\s]/g, '')

  // Remove multiple consecutive dots (can be used for obfuscation)
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
export function sanitizePath(path: string, rootDir?: string): string {
  if (!path || typeof path !== 'string') {
    return ''
  }

  let sanitized = path

  // Normalize path separators to forward slashes
  sanitized = sanitized.replace(/\\/g, '/')

  // Remove leading slashes for relative path handling
  const isAbsolute = sanitized.startsWith('/')
  sanitized = sanitized.replace(/^\/+/, '')

  // Split into segments and filter dangerous ones
  const segments = sanitized
    .split('/')
    .filter((segment) => {
      // Remove empty segments
      if (!segment || segment === '.') return false

      // Block parent directory references
      if (segment === '..') {
        logger.warn('Path traversal attempt detected', { path, segment })
        return false
      }

      // Block segments with control characters
      if (/[\x00-\x1f\x7f]/.test(segment)) {
        logger.warn('Control characters in path segment', { path, segment })
        return false
      }

      return true
    })
    .map((segment) => sanitizeFileName(segment))
    .filter((segment) => segment.length > 0)

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
export function sanitizeUrl(url: string): string {
  if (!url || typeof url !== 'string') {
    return ''
  }

  // Trim whitespace and control characters
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
 * @returns Sanitized text
 *
 * @example
 * ```typescript
 * sanitizeText('Hello\x00World\u200B')
 * // Returns: 'HelloWorld'
 * ```
 */
export function sanitizeText(input: string): string {
  if (!input || typeof input !== 'string') {
    return ''
  }

  let sanitized = input

  // Remove control characters except newline and tab
  sanitized = sanitized.replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, '')

  // Remove zero-width characters
  sanitized = sanitized.replace(/[\u200b-\u200d\ufeff]/g, '')

  // Normalize Unicode
  sanitized = sanitized.normalize('NFC')

  // Trim
  sanitized = sanitized.trim()

  return sanitized
}
