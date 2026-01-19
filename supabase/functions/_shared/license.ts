/**
 * License key utilities
 * @module _shared/license
 *
 * SMI-1164: License key delivery after payment
 *
 * Shared utilities for license key generation and validation.
 */

// License key prefix - indicates production keys
export const LICENSE_KEY_PREFIX = 'sk_live_'

// Max keys per user by tier
export const MAX_KEYS_BY_TIER: Record<string, number> = {
  community: 1,
  individual: 3,
  team: 10,
  enterprise: 50,
}

// Rate limits per minute by tier
export const RATE_LIMITS_BY_TIER: Record<string, number> = {
  community: 30,
  individual: 60,
  team: 120,
  enterprise: 300,
}

/**
 * Generate a secure license key
 * Uses crypto.getRandomValues for cryptographically secure randomness
 *
 * @returns Object with key and display prefix
 */
export function generateLicenseKey(): { key: string; prefix: string } {
  // Generate 32 random bytes for the key
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)

  // Convert to base64url (URL-safe)
  const keyBody = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')

  const key = `${LICENSE_KEY_PREFIX}${keyBody}`
  const prefix = key.substring(0, 16) + '...'

  return { key, prefix }
}

/**
 * Compute SHA-256 hash of a license key
 * Only the hash is stored in the database, never the raw key
 *
 * @param key - The license key to hash
 * @returns Hex-encoded SHA-256 hash
 */
export async function hashLicenseKey(key: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(key)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Get rate limit for a tier
 *
 * @param tier - User's subscription tier
 * @returns Requests per minute limit
 */
export function getRateLimitForTier(tier: string): number {
  return RATE_LIMITS_BY_TIER[tier] || RATE_LIMITS_BY_TIER.community
}

/**
 * Get maximum allowed keys for a tier
 *
 * @param tier - User's subscription tier
 * @returns Maximum number of active keys allowed
 */
export function getMaxKeysForTier(tier: string): number {
  return MAX_KEYS_BY_TIER[tier] || MAX_KEYS_BY_TIER.community
}

/**
 * Validate license key format
 *
 * @param key - Key to validate
 * @returns True if format is valid
 */
export function isValidKeyFormat(key: string): boolean {
  return key.startsWith(LICENSE_KEY_PREFIX) && key.length >= 40
}
