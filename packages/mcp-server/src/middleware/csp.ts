/**
 * Content Security Policy middleware and utilities for MCP server
 *
 * While the MCP server currently uses stdio transport, these utilities
 * provide CSP support for potential HTTP transport scenarios.
 */

import { randomBytes } from 'node:crypto'

/**
 * CSP directive types
 */
export interface CspDirectives {
  'default-src'?: string[]
  'script-src'?: string[]
  'style-src'?: string[]
  'img-src'?: string[]
  'font-src'?: string[]
  'connect-src'?: string[]
  'media-src'?: string[]
  'object-src'?: string[]
  'frame-src'?: string[]
  'worker-src'?: string[]
  'form-action'?: string[]
  'frame-ancestors'?: string[]
  'base-uri'?: string[]
  'manifest-src'?: string[]
  sandbox?: string[]
  'report-uri'?: string[]
  'report-to'?: string
  'require-trusted-types-for'?: string[]
  'upgrade-insecure-requests'?: boolean
  'block-all-mixed-content'?: boolean
}

/**
 * CSP validation result with details
 */
export interface CspValidationResult {
  valid: boolean
  warnings: string[]
  errors: string[]
}

/**
 * HTTP request interface for CSP middleware
 * Minimal interface for HTTP request objects
 */
export interface CspHttpRequest {
  headers?: Record<string, string | string[] | undefined>
  url?: string
}

/**
 * HTTP response interface for CSP middleware
 * Minimal interface for HTTP response objects with CSP-related methods
 */
export interface CspHttpResponse {
  setHeader: (name: string, value: string) => void
  locals?: Record<string, unknown>
}

/**
 * Default CSP directives for MCP server
 */
export const DEFAULT_CSP_DIRECTIVES: CspDirectives = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'"],
  'img-src': ["'self'", 'data:', 'https:'],
  'font-src': ["'self'"],
  'connect-src': ["'self'"],
  'media-src': ["'self'"],
  'object-src': ["'none'"],
  'frame-src': ["'none'"],
  'worker-src': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
  'base-uri': ["'self'"],
  'upgrade-insecure-requests': true,
  'block-all-mixed-content': true,
}

/**
 * Strict CSP directives for maximum security
 */
export const STRICT_CSP_DIRECTIVES: CspDirectives = {
  'default-src': ["'none'"],
  'script-src': ["'self'"],
  'style-src': ["'self'"],
  'img-src': ["'self'", 'data:'],
  'font-src': ["'self'"],
  'connect-src': ["'self'"],
  'media-src': ["'none'"],
  'object-src': ["'none'"],
  'frame-src': ["'none'"],
  'worker-src': ["'none'"],
  'form-action': ["'none'"],
  'frame-ancestors': ["'none'"],
  'base-uri': ["'none'"],
  'manifest-src': ["'self'"],
  'require-trusted-types-for': ["'script'"],
  'upgrade-insecure-requests': true,
  'block-all-mixed-content': true,
}

/**
 * Generates a cryptographically secure nonce for CSP
 * @returns A 32-character base64 nonce
 */
export function generateNonce(): string {
  // Use Node.js crypto.randomBytes for cryptographically secure random bytes
  return randomBytes(16).toString('base64')
}

/**
 * Sanitize a CSP source value to prevent directive injection
 * @param source - The source value to sanitize
 * @returns Sanitized source value
 */
function sanitizeCspSource(source: string): string {
  // Remove characters that could be used for injection
  // CSP sources should not contain ; (directive separator) or newlines
  return source.replace(/[;\r\n]/g, '')
}

/**
 * Converts CSP directives object to a CSP header string
 * @param directives - The CSP directives to convert
 * @param nonce - Optional nonce to add to script-src and style-src
 * @returns The CSP header value
 */
export function buildCspHeader(directives: CspDirectives, nonce?: string): string {
  const parts: string[] = []

  for (const [directive, value] of Object.entries(directives)) {
    // Sanitize directive name (should be alphanumeric with hyphens only)
    const sanitizedDirective = directive.replace(/[^a-zA-Z0-9-]/g, '')

    if (typeof value === 'boolean') {
      if (value) {
        parts.push(sanitizedDirective)
      }
    } else if (typeof value === 'string') {
      // Handle string directives like report-to
      const sanitizedValue = sanitizeCspSource(value)
      parts.push(`${sanitizedDirective} ${sanitizedValue}`)
    } else if (Array.isArray(value)) {
      const sources = value.map(sanitizeCspSource)

      // Add nonce to script-src and style-src if provided
      if (nonce && (directive === 'script-src' || directive === 'style-src')) {
        // Validate nonce format (base64)
        if (/^[A-Za-z0-9+/=]+$/.test(nonce)) {
          sources.push(`'nonce-${nonce}'`)
        }
      }

      parts.push(`${sanitizedDirective} ${sources.join(' ')}`)
    }
  }

  return parts.join('; ')
}

/**
 * Validates a CSP header string
 * @param csp - The CSP header string to validate
 * @returns true if valid, false otherwise
 */
export function validateCspHeader(csp: string): boolean {
  const result = validateCspHeaderDetailed(csp)
  return result.valid
}

/**
 * Parse CSP header into directives map
 * @param csp - The CSP header string
 * @returns Map of directive name to values
 */
function parseCspDirectives(csp: string): Map<string, string> {
  const directives = new Map<string, string>()
  const parts = csp
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

  for (const part of parts) {
    const spaceIndex = part.indexOf(' ')
    if (spaceIndex === -1) {
      // Directive without value (e.g., upgrade-insecure-requests)
      directives.set(part.toLowerCase(), '')
    } else {
      const name = part.substring(0, spaceIndex).toLowerCase()
      const value = part.substring(spaceIndex + 1)
      directives.set(name, value)
    }
  }

  return directives
}

/**
 * Validates a CSP header string with detailed results
 * @param csp - The CSP header string to validate
 * @returns Detailed validation result with warnings and errors
 */
export function validateCspHeaderDetailed(csp: string): CspValidationResult {
  const result: CspValidationResult = {
    valid: true,
    warnings: [],
    errors: [],
  }

  if (!csp || typeof csp !== 'string') {
    result.valid = false
    result.errors.push('CSP header must be a non-empty string')
    return result
  }

  // Parse directives for per-directive analysis
  const directives = parseCspDirectives(csp)
  const _lowercaseCsp = csp.toLowerCase()

  // Check for unsafe-eval in script-src or default-src (per-directive check)
  const scriptSrc = directives.get('script-src') || ''
  const defaultSrc = directives.get('default-src') || ''

  if (scriptSrc.includes("'unsafe-eval'") || defaultSrc.includes("'unsafe-eval'")) {
    result.warnings.push(
      'unsafe-eval detected in script-src or default-src - allows arbitrary code execution'
    )
    console.warn('[CSP] Warning: unsafe-eval detected in CSP policy')
  }

  // Check for unsafe-inline WITHOUT nonce in the SAME directive (per-directive check)
  // This is the correct check - unsafe-inline in script-src is only mitigated by nonce in script-src
  if (scriptSrc.includes("'unsafe-inline'") && !scriptSrc.includes("'nonce-")) {
    result.warnings.push('unsafe-inline without nonce in script-src - vulnerable to XSS')
    console.warn('[CSP] Warning: unsafe-inline without nonce detected in script-src')
  }

  const styleSrc = directives.get('style-src') || ''
  if (styleSrc.includes("'unsafe-inline'") && !styleSrc.includes("'nonce-")) {
    result.warnings.push('unsafe-inline without nonce in style-src - vulnerable to CSS injection')
    console.warn('[CSP] Warning: unsafe-inline without nonce detected in style-src')
  }

  // Check for wildcard sources in sensitive directives
  const sensitiveDirectives = ['script-src', 'style-src', 'object-src', 'base-uri']
  for (const directive of sensitiveDirectives) {
    const directiveValue = directives.get(directive) || ''
    // Check for standalone wildcard (not part of *.example.com)
    if (/(?:^|\s)\*(?:\s|$)/.test(directiveValue)) {
      result.warnings.push(`Wildcard (*) in ${directive} is overly permissive`)
    }
  }

  // Check for data: URI in script-src (XSS risk)
  if (scriptSrc.includes('data:')) {
    result.warnings.push('data: URI in script-src allows XSS attacks')
  }

  // Check for blob: and filesystem: in script-src (XSS risk)
  if (scriptSrc.includes('blob:')) {
    result.warnings.push('blob: URI in script-src can be used for XSS')
  }
  if (scriptSrc.includes('filesystem:')) {
    result.warnings.push('filesystem: URI in script-src can be used for XSS')
  }

  // Verify object-src is properly restricted (Flash/plugin attacks)
  const objectSrc = directives.get('object-src') || ''
  if (directives.has('object-src')) {
    if (!objectSrc.includes("'none'") && !objectSrc.includes("'self'")) {
      // Check if it has potentially dangerous values
      if (objectSrc.includes('*') || objectSrc.includes('data:') || objectSrc.includes('blob:')) {
        result.warnings.push(
          'object-src has permissive values - vulnerable to plugin-based attacks'
        )
      } else if (objectSrc.trim() !== '') {
        result.warnings.push('object-src should be restricted to prevent plugin-based attacks')
      }
    }
  }

  // Check for missing default-src (fallback for other directives)
  if (!directives.has('default-src')) {
    result.warnings.push(
      'Missing default-src - other directives may fall back to permissive defaults'
    )
  }

  // Should have at least one directive
  if (
    !csp.includes('-src') &&
    !csp.includes('upgrade-insecure-requests') &&
    !csp.includes('sandbox')
  ) {
    result.valid = false
    result.errors.push('CSP must contain at least one valid directive')
  }

  return result
}

/**
 * HTTP middleware function for adding CSP headers
 * This can be used if the MCP server adds HTTP transport in the future
 */
export function cspMiddleware(directives: CspDirectives = DEFAULT_CSP_DIRECTIVES) {
  return (_req: CspHttpRequest, res: CspHttpResponse, next: () => void): void => {
    const nonce = generateNonce()
    const cspHeader = buildCspHeader(directives, nonce)

    // Set CSP header
    res.setHeader('Content-Security-Policy', cspHeader)

    // Add nonce to response locals for use in templates
    if (!res.locals) {
      res.locals = {}
    }
    res.locals.cspNonce = nonce

    next()
  }
}

/**
 * Gets CSP configuration for different environments
 *
 * NOTE: Test environment uses relaxed CSP for testing purposes.
 * Production code should always use STRICT_CSP_DIRECTIVES.
 *
 * @param env - The environment (development, production, test)
 * @returns The appropriate CSP directives
 */
export function getCspForEnvironment(env: string = 'production'): CspDirectives {
  switch (env) {
    case 'development':
      // Slightly relaxed for development - only unsafe-eval for dev tools
      // Still maintains object-src: 'none' for plugin protection
      return {
        ...DEFAULT_CSP_DIRECTIVES,
        'script-src': ["'self'", "'unsafe-eval'"], // Allow eval for dev tools
        'object-src': ["'none'"], // Always restrict plugins
      }

    case 'test':
      // More permissive for testing, but maintain critical security restrictions
      // Note: Tests requiring unsafe-inline should use nonces instead for better security testing
      return {
        ...DEFAULT_CSP_DIRECTIVES,
        'script-src': ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'object-src': ["'none'"], // Always restrict plugins even in test
        'frame-ancestors': ["'none'"], // Prevent clickjacking even in test
      }

    case 'production':
    default:
      // Strict for production
      return STRICT_CSP_DIRECTIVES
  }
}
