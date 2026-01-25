/**
 * API Utility Functions
 * @module api/utils
 *
 * Helper functions for API client operations
 */

// ============================================================================
// Backoff Calculation
// ============================================================================

/**
 * Calculate delay with exponential backoff and jitter
 *
 * @param attempt - Current attempt number (0-indexed)
 * @param baseDelay - Base delay in milliseconds (default: 1000)
 * @returns Delay in milliseconds (capped at 30000)
 */
export function calculateBackoff(attempt: number, baseDelay = 1000): number {
  const exponentialDelay = baseDelay * Math.pow(2, attempt)
  const jitter = Math.random() * 0.3 * exponentialDelay
  return Math.min(exponentialDelay + jitter, 30000) // Max 30s
}

// ============================================================================
// Anonymous ID Generation
// ============================================================================

/**
 * Generate anonymous ID for telemetry using cryptographic randomness.
 * Returns a UUID v4 format string (e.g., "550e8400-e29b-41d4-a716-446655440000").
 *
 * Note: This generates a fresh ID per session - it is NOT stored persistently.
 * For persistent anonymous IDs, the caller must handle storage.
 */
export function generateAnonymousId(): string {
  // Use Node.js crypto.randomUUID() for cryptographically secure random IDs
  // This is available in Node.js 14.17.0+ and all modern browsers
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  // Fallback for older environments: use crypto.getRandomValues if available
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    // Set version (4) and variant (RFC4122) bits
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }

  // Last resort fallback (not cryptographically secure, but functional)
  const chars = 'abcdef0123456789'
  let id = ''
  for (let i = 0; i < 32; i++) {
    id += chars[Math.floor(Math.random() * chars.length)]
  }
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`
}

// ============================================================================
// Request Header Builder
// ============================================================================

/**
 * Build request headers for API calls
 *
 * @param anonKey - Optional Supabase anon key for authentication
 * @returns Headers object
 */
export function buildRequestHeaders(anonKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-request-id': `client-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  }

  if (anonKey) {
    headers['Authorization'] = `Bearer ${anonKey}`
    headers['apikey'] = anonKey
  }

  return headers
}

// ============================================================================
// URL Constants
// ============================================================================

/**
 * Default base URL constructed from SUPABASE_URL environment variable.
 * Falls back to undefined to fail explicitly if not configured.
 */
export const DEFAULT_BASE_URL = process.env.SUPABASE_URL
  ? `${process.env.SUPABASE_URL}/functions/v1`
  : undefined
