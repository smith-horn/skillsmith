/**
 * Formatting Utilities
 *
 * Common formatting functions for CLI output including durations,
 * dates, and time intervals.
 */

import chalk from 'chalk'

/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted string (e.g., "500ms", "2.5s", "1.5m")
 * @example
 * formatDuration(500)    // "500ms"
 * formatDuration(2500)   // "2.5s"
 * formatDuration(90000)  // "1.5m"
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

/**
 * Format an ISO date string for display.
 *
 * @param isoString - ISO 8601 date string or null
 * @returns Formatted locale string or "Never" if null
 * @example
 * formatDate("2024-01-15T10:30:00Z")  // "1/15/2024, 10:30:00 AM"
 * formatDate(null)                     // "Never" (dimmed)
 */
export function formatDate(isoString: string | null): string {
  if (!isoString) return chalk.dim('Never')
  const date = new Date(isoString)
  return date.toLocaleString()
}

/**
 * Format the time remaining until a target date.
 *
 * @param isoString - ISO 8601 target date string or null
 * @returns Human-readable time remaining (e.g., "2h 30m", "1d 5h")
 * @example
 * formatTimeUntil("2024-01-15T12:00:00Z")  // "2h 30m" (if ~2.5h away)
 * formatTimeUntil(null)                     // "N/A" (dimmed)
 * formatTimeUntil(pastDate)                 // "Due now" (yellow)
 */
export function formatTimeUntil(isoString: string | null): string {
  if (!isoString) return chalk.dim('N/A')
  const target = new Date(isoString)
  const now = new Date()
  const diffMs = target.getTime() - now.getTime()

  if (diffMs <= 0) return chalk.yellow('Due now')

  const hours = Math.floor(diffMs / 3600000)
  const minutes = Math.floor((diffMs % 3600000) / 60000)

  if (hours > 24) {
    const days = Math.floor(hours / 24)
    return `${days}d ${hours % 24}h`
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }
  return `${minutes}m`
}
