/**
 * SMI-898: Path Traversal Protection for Database Paths
 *
 * Provides secure path validation for database and file storage paths.
 * Prevents path traversal attacks by:
 * - Canonicalizing paths with path.resolve() and path.normalize()
 * - Validating that resolved paths stay within allowed directories
 * - Rejecting paths with ".." traversal attempts
 * - Blocking absolute paths outside allowed directories
 */

import { resolve, normalize, dirname, isAbsolute } from 'path'
import { homedir } from 'os'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('PathValidation')

/**
 * Configuration for path validation
 */
export interface PathValidationOptions {
  /** Allowed base directories for path resolution (default: [~/.skillsmith]) */
  allowedDirs?: string[]
  /** Allow in-memory database path ':memory:' (default: true) */
  allowInMemory?: boolean
  /** Allow paths under system temp directory (default: true for testing) */
  allowTempDir?: boolean
  /** Maximum path length (default: 4096) */
  maxLength?: number
}

/**
 * Result of path validation
 */
export interface PathValidationResult {
  /** Whether the path is valid */
  valid: boolean
  /** The sanitized and resolved path (if valid) */
  resolvedPath?: string
  /** Error message (if invalid) */
  error?: string
}

/**
 * Default allowed directories for database storage
 */
export const DEFAULT_ALLOWED_DIRS = [
  resolve(homedir(), '.skillsmith'),
  resolve(homedir(), '.claude'),
]

/**
 * System temp directory for test databases
 */
const TEMP_DIRS = ['/tmp', '/var/tmp', '/private/tmp', process.env.TMPDIR].filter(
  Boolean
) as string[]

/**
 * Validate and sanitize a database path to prevent path traversal attacks.
 *
 * Security measures:
 * 1. Rejects null bytes and control characters
 * 2. Canonicalizes path with resolve() and normalize()
 * 3. Checks for ".." traversal attempts before resolution
 * 4. Validates resolved path is within allowed directories
 * 5. Handles both absolute and relative paths
 *
 * @param inputPath - The raw path to validate
 * @param options - Validation configuration options
 * @returns Validation result with resolved path or error
 *
 * @example
 * ```typescript
 * // Valid paths
 * validateDbPath('/Users/me/.skillsmith/skills.db')
 * // => { valid: true, resolvedPath: '/Users/me/.skillsmith/skills.db' }
 *
 * validateDbPath(':memory:')
 * // => { valid: true, resolvedPath: ':memory:' }
 *
 * // Invalid paths - traversal attack
 * validateDbPath('../../../etc/passwd')
 * // => { valid: false, error: 'Path traversal detected' }
 *
 * validateDbPath('/etc/passwd')
 * // => { valid: false, error: 'Path outside allowed directories' }
 * ```
 */
export function validateDbPath(
  inputPath: string | undefined,
  options: PathValidationOptions = {}
): PathValidationResult {
  const {
    allowedDirs = DEFAULT_ALLOWED_DIRS,
    allowInMemory = true,
    allowTempDir = true,
    maxLength = 4096,
  } = options

  // Null/undefined check
  if (!inputPath || typeof inputPath !== 'string') {
    return { valid: false, error: 'Path is required' }
  }

  // Length check
  if (inputPath.length > maxLength) {
    logger.warn('Path exceeds maximum length', { length: inputPath.length, maxLength })
    return { valid: false, error: `Path exceeds maximum length of ${maxLength}` }
  }

  // Allow in-memory database
  if (inputPath === ':memory:') {
    if (allowInMemory) {
      return { valid: true, resolvedPath: ':memory:' }
    }
    return { valid: false, error: 'In-memory database not allowed' }
  }

  // Check for null bytes (path injection)
  if (inputPath.includes('\0')) {
    logger.warn('Null byte detected in path', { path: inputPath.substring(0, 50) })
    return { valid: false, error: 'Invalid characters in path' }
  }

  // Check for control characters
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(inputPath)) {
    logger.warn('Control characters detected in path', { path: inputPath.substring(0, 50) })
    return { valid: false, error: 'Invalid characters in path' }
  }

  // Check for obvious traversal attempts before normalization
  // This catches encoded traversal and various bypass attempts
  if (inputPath.includes('..')) {
    // Check if the path segments contain ".."
    const segments = inputPath.split(/[/\\]/)
    const hasTraversal = segments.some((seg) => seg === '..' || seg === '...')
    if (hasTraversal) {
      logger.warn('Path traversal attempt detected', { path: inputPath.substring(0, 100) })
      return { valid: false, error: 'Path traversal detected' }
    }
  }

  // Normalize and resolve the path
  let resolvedPath: string
  try {
    // Normalize first to handle various path formats
    const normalized = normalize(inputPath)

    // If the path is absolute, use it directly
    // If relative, resolve from home directory's .skillsmith
    if (isAbsolute(normalized)) {
      resolvedPath = resolve(normalized)
    } else {
      // Relative paths are resolved from the first allowed directory
      resolvedPath = resolve(allowedDirs[0] || homedir(), normalized)
    }
  } catch (error) {
    logger.warn('Path resolution failed', {
      path: inputPath.substring(0, 100),
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    return { valid: false, error: 'Invalid path format' }
  }

  // After resolution, verify no traversal occurred by checking resolved path
  // doesn't contain ".." (should be resolved away, but double-check)
  if (resolvedPath.includes('..')) {
    logger.warn('Path traversal after resolution', { path: resolvedPath.substring(0, 100) })
    return { valid: false, error: 'Path traversal detected' }
  }

  // Build list of allowed directories including temp dirs if enabled
  const effectiveAllowedDirs = [...allowedDirs]
  if (allowTempDir) {
    effectiveAllowedDirs.push(...TEMP_DIRS)
  }

  // Check if resolved path is within any allowed directory
  const isAllowed = effectiveAllowedDirs.some((allowedDir) => {
    const resolvedAllowed = resolve(allowedDir)
    // Path must be exactly the allowed dir or start with allowed dir + separator
    return (
      resolvedPath === resolvedAllowed ||
      resolvedPath.startsWith(resolvedAllowed + '/') ||
      resolvedPath.startsWith(resolvedAllowed + '\\')
    )
  })

  if (!isAllowed) {
    logger.warn('Path outside allowed directories', {
      path: resolvedPath.substring(0, 100),
      allowedDirs: effectiveAllowedDirs,
    })
    return { valid: false, error: 'Path outside allowed directories' }
  }

  // Ensure parent directory path is also valid
  const parentDir = dirname(resolvedPath)
  const parentAllowed = effectiveAllowedDirs.some((allowedDir) => {
    const resolvedAllowed = resolve(allowedDir)
    return (
      parentDir === resolvedAllowed ||
      parentDir.startsWith(resolvedAllowed + '/') ||
      parentDir.startsWith(resolvedAllowed + '\\')
    )
  })

  if (!parentAllowed) {
    logger.warn('Parent directory outside allowed directories', {
      parentDir: parentDir.substring(0, 100),
    })
    return { valid: false, error: 'Parent directory outside allowed directories' }
  }

  logger.debug('Path validated successfully', {
    input: inputPath.substring(0, 100),
    resolved: resolvedPath,
  })

  return { valid: true, resolvedPath }
}

/**
 * Validate a database path and throw an error if invalid.
 * Convenience wrapper for validateDbPath that throws instead of returning error.
 *
 * @param inputPath - The raw path to validate
 * @param options - Validation configuration options
 * @returns The validated and resolved path
 * @throws Error if path validation fails
 *
 * @example
 * ```typescript
 * const safePath = validateDbPathOrThrow(process.env.DB_PATH);
 * // Either returns valid path or throws
 * ```
 */
export function validateDbPathOrThrow(
  inputPath: string | undefined,
  options: PathValidationOptions = {}
): string {
  const result = validateDbPath(inputPath, options)
  if (!result.valid) {
    throw new Error(`Invalid database path: ${result.error}`)
  }
  return result.resolvedPath!
}

/**
 * Check if a path is safe for database usage without modifying it.
 * Quick check that doesn't resolve the path.
 *
 * @param inputPath - The path to check
 * @returns True if the path appears safe (no obvious traversal)
 */
export function isPathSafe(inputPath: string): boolean {
  if (!inputPath || typeof inputPath !== 'string') {
    return false
  }

  // Allow in-memory
  if (inputPath === ':memory:') {
    return true
  }

  // Quick checks for obvious attacks
  if (inputPath.includes('\0')) return false
  if (inputPath.includes('..')) {
    const segments = inputPath.split(/[/\\]/)
    if (segments.some((seg) => seg === '..' || seg === '...')) {
      return false
    }
  }

  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(inputPath)) return false

  return true
}
