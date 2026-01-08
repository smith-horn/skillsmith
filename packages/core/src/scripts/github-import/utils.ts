/**
 * SMI-860: Utility functions for GitHub skill import
 */

import { GitHubSearchResponse } from './types.js'

/** Sleep for a given number of milliseconds */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** Log with timestamp */
export function log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  const timestamp = new Date().toISOString()
  const prefix = { info: '[INFO]', warn: '[WARN]', error: '[ERROR]' }[level]
  console.log(`${timestamp} ${prefix} ${message}`)
}

/** Progress bar helper */
export function progressBar(current: number, total: number, width = 30): string {
  const percent = Math.round((current / total) * 100)
  const filled = Math.round((current / total) * width)
  const empty = width - filled
  return `[${'='.repeat(filled)}${' '.repeat(empty)}] ${percent}% (${current}/${total})`
}

/** Type guard for GitHub search response */
export function isGitHubSearchResponse(data: unknown): data is GitHubSearchResponse {
  if (typeof data !== 'object' || data === null) return false
  const obj = data as Record<string, unknown>
  return (
    typeof obj.total_count === 'number' &&
    typeof obj.incomplete_results === 'boolean' &&
    Array.isArray(obj.items)
  )
}
