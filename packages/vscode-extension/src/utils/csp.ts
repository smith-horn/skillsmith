/**
 * Content Security Policy utilities for VS Code extension webviews
 */

/**
 * CSP configuration for different webview contexts
 */
export interface WebviewCspConfig {
  /** Allow inline styles */
  allowInlineStyles?: boolean
  /** Allow VS Code resource URIs */
  allowVscodeResources?: boolean
  /** Additional script sources */
  scriptSrc?: string[]
  /** Additional style sources */
  styleSrc?: string[]
  /** Additional image sources */
  imgSrc?: string[]
  /** Additional font sources */
  fontSrc?: string[]
}

/**
 * Generates a cryptographically secure nonce for CSP
 * @returns A 32-character base64 nonce
 */
export function generateCspNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const values = new Uint8Array(32)

  // Use crypto.getRandomValues if available
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(values)
    return Array.from(values)
      .map((v) => possible.charAt(v % possible.length))
      .join('')
  }

  // Fallback to Math.random
  let text = ''
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length))
  }
  return text
}

/**
 * Builds a CSP meta tag for webviews
 * @param nonce - The nonce to use for scripts
 * @param config - Optional CSP configuration
 * @returns The CSP meta tag content attribute value
 */
export function buildWebviewCsp(nonce: string, config: WebviewCspConfig = {}): string {
  const {
    allowInlineStyles = false,
    allowVscodeResources = true,
    scriptSrc = [],
    styleSrc = [],
    imgSrc = [],
    fontSrc = [],
  } = config

  const directives: string[] = []

  // Default-src: Deny all by default
  directives.push("default-src 'none'")

  // Script-src: Only nonce-based scripts
  const scriptSources = ["'nonce-" + nonce + "'", ...scriptSrc]
  directives.push(`script-src ${scriptSources.join(' ')}`)

  // Style-src: Nonce-based or inline styles
  const styleSources = allowInlineStyles
    ? ["'unsafe-inline'", ...styleSrc]
    : ["'nonce-" + nonce + "'", ...styleSrc]
  directives.push(`style-src ${styleSources.join(' ')}`)

  // Img-src: Self, data URIs, HTTPS, and optional VS Code resources
  const imgSources = allowVscodeResources
    ? ['https:', 'data:', 'vscode-resource:', ...imgSrc]
    : ['https:', 'data:', ...imgSrc]
  directives.push(`img-src ${imgSources.join(' ')}`)

  // Font-src: Self and optional VS Code resources
  const fontSources = allowVscodeResources
    ? ['vscode-resource:', ...fontSrc]
    : [...fontSrc]
  if (fontSources.length > 0) {
    directives.push(`font-src ${fontSources.join(' ')}`)
  }

  // Connect-src: Deny all external connections
  directives.push("connect-src 'none'")

  // Object-src: Deny all objects/embeds
  directives.push("object-src 'none'")

  // Frame-src: Deny all frames
  directives.push("frame-src 'none'")

  // Form-action: Deny all form submissions
  directives.push("form-action 'none'")

  return directives.join('; ')
}

/**
 * Validates that a nonce meets security requirements
 * @param nonce - The nonce to validate
 * @returns true if valid, false otherwise
 */
export function isValidNonce(nonce: string): boolean {
  // Must be non-empty
  if (!nonce || nonce.length < 16) {
    return false
  }

  // Must be alphanumeric
  if (!/^[A-Za-z0-9]+$/.test(nonce)) {
    return false
  }

  // Should be at least 16 characters for security
  return nonce.length >= 16
}

/**
 * Creates a CSP meta tag element
 * @param nonce - The nonce for the CSP
 * @param config - Optional CSP configuration
 * @returns The complete meta tag HTML string
 */
export function createCspMetaTag(nonce: string, config?: WebviewCspConfig): string {
  if (!isValidNonce(nonce)) {
    throw new Error('Invalid CSP nonce: must be at least 16 alphanumeric characters')
  }

  const cspContent = buildWebviewCsp(nonce, config)
  return `<meta http-equiv="Content-Security-Policy" content="${cspContent}">`
}

/**
 * Gets CSP configuration for skill detail webview
 * This is a pre-configured CSP for the skill detail panel
 */
export function getSkillDetailCsp(nonce: string): string {
  return buildWebviewCsp(nonce, {
    allowInlineStyles: true, // VS Code uses CSS variables that require this
    allowVscodeResources: true,
    scriptSrc: [], // No additional script sources
    styleSrc: [], // No additional style sources
    imgSrc: [], // Uses defaults (https:, data:)
  })
}

/**
 * Gets CSP configuration for search results webview
 */
export function getSearchResultsCsp(nonce: string): string {
  return buildWebviewCsp(nonce, {
    allowInlineStyles: true,
    allowVscodeResources: true,
  })
}

/**
 * Validates a CSP header for common security issues
 * @param csp - The CSP header to validate
 * @returns Validation result with any warnings
 */
export function validateCsp(csp: string): { valid: boolean; warnings: string[] } {
  const warnings: string[] = []

  // Check for unsafe-eval
  if (csp.includes("'unsafe-eval'")) {
    warnings.push("CSP contains 'unsafe-eval' which allows code execution")
  }

  // Check for unsafe-inline without nonce
  if (csp.includes("'unsafe-inline'")) {
    if (!csp.includes("'nonce-")) {
      warnings.push("CSP contains 'unsafe-inline' without nonce")
    }
  }

  // Check for wildcard sources
  if (csp.includes("* ") || csp.includes(" *;") || csp.endsWith(" *")) {
    warnings.push("CSP contains wildcard (*) source which is too permissive")
  }

  // Should have script-src
  if (!csp.includes('script-src')) {
    warnings.push("CSP missing script-src directive")
  }

  // Should have default-src
  if (!csp.includes('default-src')) {
    warnings.push("CSP missing default-src directive")
  }

  return {
    valid: warnings.length === 0,
    warnings,
  }
}
