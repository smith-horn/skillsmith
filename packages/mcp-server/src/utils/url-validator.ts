/**
 * @fileoverview SSRF protection: validate external URLs
 * @module @skillsmith/mcp-server/utils/url-validator
 * @see SMI-3914: Wave 0 Shared Infrastructure
 *
 * Blocks private/loopback/link-local addresses, requires HTTPS.
 */

import { URL } from 'node:url'
import { isIP } from 'node:net'

const BLOCKED_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^fe80:/i,
  /^fc00:/i,
  /^fd00:/i,
]

/**
 * Validate that a URL is safe for external requests (SSRF protection).
 *
 * Rules:
 * - Must be a valid URL
 * - Protocol must be HTTPS
 * - Hostname must not be localhost or 0.0.0.0
 * - If hostname is an IP, it must not be in a private/loopback/link-local range
 *
 * @param urlString - The URL string to validate
 * @returns Object with `valid` boolean and optional `error` message
 */
export function validateExternalUrl(urlString: string): { valid: boolean; error?: string } {
  let parsed: URL
  try {
    parsed = new URL(urlString)
  } catch {
    return { valid: false, error: 'Invalid URL format' }
  }

  if (parsed.protocol !== 'https:') {
    return { valid: false, error: 'Only HTTPS URLs are allowed' }
  }

  const hostname = parsed.hostname
  if (hostname === 'localhost' || hostname === '0.0.0.0') {
    return { valid: false, error: 'Localhost URLs are not allowed' }
  }

  // Check if hostname is an IP address in blocked ranges
  if (isIP(hostname)) {
    for (const range of BLOCKED_RANGES) {
      if (range.test(hostname)) {
        return { valid: false, error: 'Private/internal IP addresses are not allowed' }
      }
    }
  }

  return { valid: true }
}
