/**
 * GitHub parameter validation (Node port)
 * @module scripts/indexer/_shared/validation
 *
 * SMI-4852: Node-flavored sibling of `supabase/functions/_shared/validation.ts`.
 * Body is byte-identical — pure functions with no Deno-only APIs. Parity is
 * guarded by `scripts/indexer/tests/parity.test.ts`.
 *
 * Original SMI-2271: Prevents SSRF, path traversal, and injection attacks by
 * validating GitHub owner, repo, and path parameters before URL construction.
 */

/**
 * Error thrown when GitHub parameter validation fails.
 * Extends Error with a distinct name for catch-block filtering.
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

/**
 * Validate a GitHub owner or repository name.
 */
export function isValidGitHubIdentifier(value: string): boolean {
  if (!value || typeof value !== 'string') {
    return false
  }

  return (
    /^[a-zA-Z0-9_.-]+$/.test(value) &&
    value.length <= 100 &&
    !value.includes('..') &&
    !value.startsWith('-') &&
    !value.startsWith('.') &&
    !value.endsWith('.')
  )
}

/**
 * Validate a GitHub file path (e.g., path within a repository).
 */
export function validateGitHubPath(path: string): boolean {
  if (!path || typeof path !== 'string') {
    return false
  }

  return (
    !path.includes('..') &&
    !path.includes('\0') &&
    !path.includes('\\') &&
    !path.includes('//') &&
    !path.startsWith('/') &&
    path.length <= 500
  )
}

/**
 * Validate GitHub owner, repo, and optional path parameters.
 *
 * This function MUST be called before constructing any GitHub URL
 * from user-supplied or external data.
 *
 * @throws {ValidationError} if any parameter is invalid
 */
export function validateGitHubParams(owner: string, repo: string, path?: string): void {
  if (!isValidGitHubIdentifier(owner)) {
    throw new ValidationError(`Invalid GitHub owner: ${sanitizeForLog(owner)}`)
  }
  if (!isValidGitHubIdentifier(repo)) {
    throw new ValidationError(`Invalid GitHub repo: ${sanitizeForLog(repo)}`)
  }
  if (path !== undefined && path !== null && !validateGitHubPath(path)) {
    throw new ValidationError(`Invalid GitHub path`)
  }
}

/**
 * Validate a GitHub topic string for search queries.
 */
export function isValidGitHubTopic(topic: string): boolean {
  if (!topic || typeof topic !== 'string') {
    return false
  }

  return /^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(topic) && topic.length <= 50
}

/**
 * Validate a git branch name (from GitHub API default_branch).
 */
export function isValidBranchName(branch: string): boolean {
  if (!branch || typeof branch !== 'string') return false
  return (
    branch.length <= 256 &&
    !branch.includes('..') &&
    !branch.includes('\0') &&
    !branch.includes('~') &&
    !branch.includes('^') &&
    !branch.includes(':') &&
    !branch.includes('\\') &&
    !branch.includes(' ') &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x1f\x7f]/.test(branch) &&
    !branch.startsWith('/') &&
    !branch.endsWith('/') &&
    !branch.endsWith('.lock') &&
    !branch.startsWith('.')
  )
}

/**
 * Sanitize a string for safe inclusion in log messages.
 * Truncates to 80 characters, removes control characters.
 */
export function sanitizeForLog(value: unknown): string {
  if (value === null || value === undefined) {
    return '<empty>'
  }
  const str = String(value)
  // eslint-disable-next-line no-control-regex
  const cleaned = str.replace(/[\x00-\x1f\x7f]/g, '')
  return cleaned.substring(0, 80)
}
