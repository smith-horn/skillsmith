/**
 * URL Validation Utilities (SMI-721, SMI-729)
 *
 * SSRF prevention validators for URL access.
 *
 * Security Features:
 * - Protocol validation (http/https only)
 * - Private IPv4 range blocking
 * - Private IPv6 range blocking
 * - Localhost and loopback blocking
 */

import { ValidationError } from './validation-error.js'

/**
 * Get human-readable IP range name for error messages
 */
export function getIpRangeName(a: number, b: number): string {
  if (a === 10) return '10.0.0.0/8 (Private)'
  if (a === 172 && b >= 16 && b <= 31) return '172.16.0.0/12 (Private)'
  if (a === 192 && b === 168) return '192.168.0.0/16 (Private)'
  if (a === 127) return '127.0.0.0/8 (Loopback)'
  if (a === 169 && b === 254) return '169.254.0.0/16 (Link-local)'
  if (a === 0) return '0.0.0.0/8 (Current network)'
  return 'Unknown'
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
export function validateIPv6(hostname: string, url: string): void {
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
        // IPv4 in hex notation (e.g., ::ffff:7f00:1 for 127.0.0.1)
        // Parse hex format: high:low where high = (a<<8)|b, low = (c<<8)|d
        const hexMatch = ipv4Part.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
        if (hexMatch) {
          const high = parseInt(hexMatch[1]!, 16)
          const _low = parseInt(hexMatch[2]!, 16)
          const a = (high >> 8) & 0xff
          const b = high & 0xff
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
        }
        // If we can't parse it, block it to be safe
        throw new ValidationError(
          `Access to IPv4-mapped IPv6 address blocked: ${hostname}`,
          'IPV4_MAPPED_IPV6_BLOCKED',
          { hostname, url }
        )
      }
    }
  }

  // Block 6to4 addresses with embedded private IPv4 (2002::/16) - SMI-1004
  // 6to4 embeds IPv4 in bits 16-48: 2002:AABB:CCDD::/48 where IPv4 is AA.BB.CC.DD
  if (normalized.startsWith('2002:')) {
    // Extract the two hex segments after 2002:
    const segments = normalized.split(':')
    if (segments.length >= 3 && segments[1] && segments[2]) {
      // Parse hex segments: 2002:AABB:CCDD -> IPv4 is 0xAA.0xBB.0xCC.0xDD
      const highHex = segments[1].padStart(4, '0')
      const lowHex = segments[2].padStart(4, '0')
      const a = parseInt(highHex.slice(0, 2), 16)
      const b = parseInt(highHex.slice(2, 4), 16)
      const c = parseInt(lowHex.slice(0, 2), 16)
      const d = parseInt(lowHex.slice(2, 4), 16)

      // Check if embedded IPv4 is private
      if (
        a === 10 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        a === 127 ||
        (a === 169 && b === 254) ||
        a === 0
      ) {
        throw new ValidationError(
          `Access to 6to4 address with embedded private IPv4 blocked: ${hostname}`,
          'IPV6_6TO4_PRIVATE',
          { hostname, url, embeddedIPv4: `${a}.${b}.${c}.${d}`, ipRange: getIpRangeName(a, b) }
        )
      }
    }
  }

  // Block IPv4-compatible addresses (::IPv4) without ffff prefix - SMI-1005
  // Pattern: ::x.x.x.x (deprecated but still valid)
  // Note: URL parser normalizes ::192.168.1.1 to ::c0a8:101 (hex format)
  // So we need to match both dotted-decimal and the normalized hex format
  const ipv4CompatibleMatch = normalized.match(/^::(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4CompatibleMatch) {
    const [, aStr, bStr, cStr, dStr] = ipv4CompatibleMatch
    const a = parseInt(aStr!, 10)
    const b = parseInt(bStr!, 10)
    const c = parseInt(cStr!, 10)
    const d = parseInt(dStr!, 10)

    // Validate octets
    if (a <= 255 && b <= 255 && c <= 255 && d <= 255) {
      // Check if embedded IPv4 is private
      if (
        a === 10 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        a === 127 ||
        (a === 169 && b === 254) ||
        a === 0
      ) {
        throw new ValidationError(
          `Access to IPv4-compatible IPv6 address with private IPv4 blocked: ${hostname}`,
          'IPV6_COMPATIBLE_PRIVATE',
          { hostname, url, embeddedIPv4: `${a}.${b}.${c}.${d}`, ipRange: getIpRangeName(a, b) }
        )
      }
    }
  }

  // Also check for normalized hex format: ::XXXX:XXXX (without ffff: prefix)
  // URL parser normalizes ::192.168.1.1 to ::c0a8:101
  const ipv4CompatibleHexMatch = normalized.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (ipv4CompatibleHexMatch) {
    const high = parseInt(ipv4CompatibleHexMatch[1]!, 16)
    const low = parseInt(ipv4CompatibleHexMatch[2]!, 16)
    const a = (high >> 8) & 0xff
    const b = high & 0xff
    const c = (low >> 8) & 0xff
    const d = low & 0xff

    // Check if embedded IPv4 is private
    if (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 127 ||
      (a === 169 && b === 254) ||
      a === 0
    ) {
      throw new ValidationError(
        `Access to IPv4-compatible IPv6 address with private IPv4 blocked: ${hostname}`,
        'IPV6_COMPATIBLE_PRIVATE',
        { hostname, url, embeddedIPv4: `${a}.${b}.${c}.${d}`, ipRange: getIpRangeName(a, b) }
      )
    }
  }

  // Block Teredo addresses (2001:0::/32) - SMI-1006
  // Teredo tunneling can bypass firewall rules
  if (normalized.startsWith('2001:0000:') || normalized.startsWith('2001:0:')) {
    throw new ValidationError(
      `Access to Teredo tunnel address blocked: ${hostname}`,
      'IPV6_TEREDO_BLOCKED',
      { hostname, url }
    )
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
