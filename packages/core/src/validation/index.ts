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
 *
 * @module validation
 */

// Validation Error
export { ValidationError } from './validation-error.js'

// URL Validators (SSRF prevention)
export { validateUrl, validateIPv6, getIpRangeName } from './url-validators.js'

// Path Validators (Path traversal prevention)
export { validatePath } from './path-validators.js'

// Input Validators (General sanitization)
export { sanitizeInput, safePatternMatch, validatePatterns } from './input-validators.js'
