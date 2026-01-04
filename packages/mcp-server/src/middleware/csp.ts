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
 * Converts CSP directives object to a CSP header string
 * @param directives - The CSP directives to convert
 * @param nonce - Optional nonce to add to script-src and style-src
 * @returns The CSP header value
 */
export function buildCspHeader(directives: CspDirectives, nonce?: string): string {
  const parts: string[] = []

  for (const [directive, value] of Object.entries(directives)) {
    if (typeof value === 'boolean') {
      if (value) {
        parts.push(directive)
      }
    } else if (typeof value === 'string') {
      // Handle string directives like report-to
      parts.push(`${directive} ${value}`)
    } else if (Array.isArray(value)) {
      const sources = [...value]

      // Add nonce to script-src and style-src if provided
      if (nonce && (directive === 'script-src' || directive === 'style-src')) {
        sources.push(`'nonce-${nonce}'`)
      }

      parts.push(`${directive} ${sources.join(' ')}`)
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

  const lowercaseCsp = csp.toLowerCase()

  // Should not allow 'unsafe-eval' in production
  if (lowercaseCsp.includes("'unsafe-eval'")) {
    result.warnings.push('unsafe-eval detected - allows arbitrary code execution')
    console.warn('[CSP] Warning: unsafe-eval detected in CSP policy')
  }

  // Should not allow 'unsafe-inline' without nonces
  if (lowercaseCsp.includes("'unsafe-inline'") && !lowercaseCsp.includes("'nonce-")) {
    result.warnings.push('unsafe-inline without nonce detected - vulnerable to XSS')
    console.warn('[CSP] Warning: unsafe-inline without nonce detected in CSP policy')
  }

  // Check for wildcard sources in sensitive directives
  const sensitiveDirectives = ['script-src', 'style-src', 'object-src', 'base-uri']
  for (const directive of sensitiveDirectives) {
    const directiveMatch = lowercaseCsp.match(new RegExp(`${directive}\\s+([^;]+)`))
    if (directiveMatch && directiveMatch[1].includes('*')) {
      result.warnings.push(`Wildcard (*) in ${directive} is overly permissive`)
    }
  }

  // Check for data: URI in script-src (XSS risk)
  if (lowercaseCsp.includes('script-src') && lowercaseCsp.includes('data:')) {
    const scriptSrcMatch = lowercaseCsp.match(/script-src\s+([^;]+)/)
    if (scriptSrcMatch && scriptSrcMatch[1].includes('data:')) {
      result.warnings.push('data: URI in script-src allows XSS attacks')
    }
  }

  // Verify object-src is restricted (Flash/plugin attacks)
  if (!lowercaseCsp.includes("object-src 'none'") && !lowercaseCsp.includes("object-src 'self'")) {
    if (lowercaseCsp.includes('object-src')) {
      result.warnings.push('object-src should be restricted to prevent plugin-based attacks')
    }
  }

  // Check for missing default-src (fallback for other directives)
  if (!lowercaseCsp.includes('default-src')) {
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
  return (req: any, res: any, next: () => void) => {
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
 * @param env - The environment (development, production, test)
 * @returns The appropriate CSP directives
 */
export function getCspForEnvironment(env: string = 'production'): CspDirectives {
  switch (env) {
    case 'development':
      // Slightly relaxed for development
      return {
        ...DEFAULT_CSP_DIRECTIVES,
        'script-src': ["'self'", "'unsafe-eval'"], // Allow eval for dev tools
      }

    case 'test':
      // More permissive for testing
      return {
        ...DEFAULT_CSP_DIRECTIVES,
        'script-src': ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        'style-src': ["'self'", "'unsafe-inline'"],
      }

    case 'production':
    default:
      // Strict for production
      return STRICT_CSP_DIRECTIVES
  }
}
