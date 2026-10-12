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
  return sanitizePath(error instanceof Error ? error.message : String(error))
}

/**
 * Fold user-specific home paths in arbitrary text to `~`.
 *
 * Extracted from `sanitizeError` (ADR-175 § Implementation, SMI-6946) so a
 * caller holding a bare path rather than an Error can redact it through the
 * same implementation. `sanitizeError` now delegates here, so the two cannot
 * drift — the alternative was a second copy of these four substitutions, which
 * is how one of them ends up fixed and the other not.
 *
 * @param text - Any text that may embed an absolute home path
 * @returns The text with home directory prefixes replaced by `~`
 */
export function sanitizePath(text: string): string {
  const home = homedir()

  // Escape special regex characters in the home path
  const escapedHome = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  // Replace home directory path with ~ (Unix-like systems)
  let sanitized = text.replace(new RegExp(escapedHome, 'g'), '~')

  // Also handle generic patterns for other systems if not already caught
  sanitized = sanitized.replace(/\/Users\/[^/]+\//g, '~/')
  sanitized = sanitized.replace(/\/home\/[^/]+\//g, '~/')
  sanitized = sanitized.replace(/C:\\Users\\[^\\]+\\/gi, '~\\')

  return sanitized
}
