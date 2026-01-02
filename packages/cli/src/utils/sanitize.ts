/**
 * Error output sanitization utilities
 *
 * Removes user-specific paths from error messages to prevent exposing
 * home directory paths in CLI output (prevents E2E hardcoded value detection).
 */

import { homedir } from 'os'

/**
 * Sanitize error messages to remove user-specific paths
 *
 * Replaces home directory paths with ~ for macOS/Linux/Windows systems.
 * Handles multiple path formats:
 * - Unix/Linux: /home/username/
 * - macOS: /Users/username/
 * - Windows: C:\Users\username\
 *
 * @param error - The error to sanitize (Error object or string)
 * @returns Sanitized error message without user-specific paths
 */
export function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const home = homedir()

  // Escape special regex characters in the home path
  const escapedHome = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  // Replace home directory path with ~ (Unix-like systems)
  let sanitized = message.replace(new RegExp(escapedHome, 'g'), '~')

  // Also handle generic patterns for other systems if not already caught
  sanitized = sanitized.replace(/\/Users\/[^/]+\//g, '~/')
  sanitized = sanitized.replace(/\/home\/[^/]+\//g, '~/')
  sanitized = sanitized.replace(/C:\\Users\\[^\\]+\\/gi, '~\\')

  return sanitized
}

/**
 * Log error with sanitization
 *
 * Convenience function to log errors with automatic sanitization.
 * Useful for consistent error logging across the CLI.
 *
 * @param prefix - Prefix text before the error (e.g., "Import failed:")
 * @param error - The error to log
 */
export function logSanitizedError(prefix: string, error: unknown): void {
  console.error(prefix, sanitizeError(error))
}
