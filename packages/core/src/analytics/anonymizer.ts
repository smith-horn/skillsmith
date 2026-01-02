/**
 * SMI-914: User Data Anonymization
 * SMI-917: Per-installation salt for improved anonymization security
 *
 * Provides one-way hashing functions to anonymize user identifiers
 * and project context without storing any PII.
 */

import { createHash, randomBytes } from 'crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { CONTEXT_HASH_LENGTH, USER_ID_HASH_LENGTH } from './constants.js'

/**
 * Fallback salt used when file operations fail
 */
const FALLBACK_SALT = 'skillsmith-fallback-salt-v1'

/**
 * Cached salt buffer to avoid repeated file reads
 */
let cachedSalt: Buffer | null = null

/**
 * Get the path to the installation-specific salt file
 *
 * @returns Path to ~/.skillsmith/anonymizer-salt
 */
export function getSaltPath(): string {
  return join(homedir(), '.skillsmith', 'anonymizer-salt')
}

/**
 * Load existing salt or create a new one for this installation
 *
 * The salt is:
 * - Generated once per installation (32 random bytes)
 * - Stored at ~/.skillsmith/anonymizer-salt
 * - Cached in memory after first load
 * - Falls back to static salt if file operations fail
 *
 * @returns Buffer containing the salt
 */
export function loadOrCreateSalt(): Buffer {
  if (cachedSalt) {
    return cachedSalt
  }

  const saltPath = getSaltPath()
  try {
    if (existsSync(saltPath)) {
      cachedSalt = readFileSync(saltPath)
    } else {
      mkdirSync(join(homedir(), '.skillsmith'), { recursive: true })
      cachedSalt = randomBytes(32)
      writeFileSync(saltPath, cachedSalt)
    }
    return cachedSalt
  } catch {
    // Fallback to static salt if file operations fail
    return Buffer.from(FALLBACK_SALT)
  }
}

/**
 * Clear the cached salt (primarily for testing)
 */
export function clearSaltCache(): void {
  cachedSalt = null
}

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

  const salt = loadOrCreateSalt()
  return createHash('sha256')
    .update(identifier)
    .update(salt)
    .digest('hex')
    .slice(0, USER_ID_HASH_LENGTH)
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

  return createHash('sha256').update(normalized).digest('hex').slice(0, CONTEXT_HASH_LENGTH)
}
