/**
 * Path Validation Utilities (SMI-720)
 *
 * Path traversal prevention validators.
 */

import { resolve } from 'path'
import { ValidationError } from './validation-error.js'

/**
 * Validate file path to prevent path traversal attacks (SMI-720)
 *
 * Ensures the resolved path remains within the allowed root directory.
 *
 * @param path - Path to validate (can be relative or absolute)
 * @param rootDir - Root directory that must contain the path
 * @throws {ValidationError} if path escapes root directory
 *
 * @example
 * ```typescript
 * validatePath('skills/my-skill', '/home/user/.claude')  // OK
 * validatePath('../etc/passwd', '/home/user/.claude')    // Throws ValidationError
 * validatePath('/etc/passwd', '/home/user/.claude')      // Throws ValidationError
 * ```
 */
export function validatePath(path: string, rootDir: string): void {
  if (!path) {
    throw new ValidationError('Path cannot be empty', 'EMPTY_PATH')
  }

  if (!rootDir) {
    throw new ValidationError('Root directory cannot be empty', 'EMPTY_ROOT_DIR')
  }

  // Normalize both paths to resolve '..' and '.'
  // Resolve path relative to rootDir so relative paths work correctly
  const normalizedPath = resolve(rootDir, path)
  const normalizedRoot = resolve(rootDir)

  // Check that normalized path is within root directory
  // Handle edge case where path equals root exactly
  const isWithinRoot =
    normalizedPath.startsWith(normalizedRoot + '/') || normalizedPath === normalizedRoot

  if (!isWithinRoot) {
    throw new ValidationError(`Path traversal detected: ${path}`, 'PATH_TRAVERSAL', {
      originalPath: path,
      normalizedPath,
      rootDir,
      normalizedRoot,
    })
  }
}
