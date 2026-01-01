/**
 * SMI-914: User Data Anonymization
 *
 * Provides one-way hashing functions to anonymize user identifiers
 * and project context without storing any PII.
 */

import { createHash } from 'crypto'

/**
 * Salt for user ID hashing - static for consistency across sessions
 */
const USER_ID_SALT = 'skillsmith-salt-v1'

/**
 * Anonymize a user identifier using SHA-256 hash
 *
 * The hash is:
 * - One-way: Cannot recover the original identifier
 * - Consistent: Same input always produces same output
 * - Truncated: 16 characters for storage efficiency
 *
 * @param identifier - The user identifier to anonymize (e.g., machine ID, username)
 * @returns Anonymized 16-character hex string
 */
export function anonymizeUserId(identifier: string): string {
  if (!identifier || identifier.trim().length === 0) {
    throw new Error('User identifier cannot be empty')
  }

  return createHash('sha256')
    .update(identifier)
    .update(USER_ID_SALT)
    .digest('hex')
    .slice(0, 16)
}

/**
 * Hash project context to avoid storing PII
 *
 * Creates a deterministic hash of the project context object,
 * allowing grouping of usage events by project type without
 * storing actual project paths or names.
 *
 * @param context - Object containing project context (framework, language, etc.)
 * @returns 8-character hex hash of the context
 */
export function hashProjectContext(context: Record<string, unknown>): string {
  if (!context || Object.keys(context).length === 0) {
    return '00000000' // Empty context hash
  }

  // Sort keys for deterministic output
  const normalized = JSON.stringify(context, Object.keys(context).sort())

  return createHash('sha256').update(normalized).digest('hex').slice(0, 8)
}
