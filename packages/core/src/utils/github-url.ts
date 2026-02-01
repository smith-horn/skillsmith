/**
 * GitHub URL Parsing Utilities
 * @module @skillsmith/core/utils/github-url
 *
 * SMI-2171: Extracted from mcp-server for shared use across codebase.
 * Used by:
 * - packages/mcp-server/src/tools/install.helpers.ts (skill installation)
 * - scripts/batch-transform-skills.ts (batch transformation)
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Parsed repository URL components
 */
export interface ParsedRepoUrl {
  /** GitHub username or organization */
  owner: string
  /** Repository name */
  repo: string
  /** Path within the repository (e.g., "skills/commit" for monorepo skills) */
  path: string
  /** Branch name (defaults to "main" if not specified) */
  branch: string
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Allowed hostnames for skill installation
 * SMI-1533: Restrict to trusted code hosting platforms
 */
const ALLOWED_HOSTS = ['github.com', 'www.github.com']

// ============================================================================
// Functions
// ============================================================================

/**
 * Parse repo_url from registry to extract GitHub components.
 *
 * Handles various URL formats:
 * - Plain repo: `https://github.com/owner/repo`
 * - Tree path: `https://github.com/owner/repo/tree/branch/path`
 * - Blob path: `https://github.com/owner/repo/blob/branch/path`
 *
 * @example
 * ```typescript
 * // Plain repo URL
 * parseRepoUrl('https://github.com/user/skill')
 * // => { owner: 'user', repo: 'skill', path: '', branch: 'main' }
 *
 * // Monorepo skill with tree path
 * parseRepoUrl('https://github.com/ruvnet/claude-code/tree/main/skills/commit')
 * // => { owner: 'ruvnet', repo: 'claude-code', path: 'skills/commit', branch: 'main' }
 * ```
 *
 * @param repoUrl - GitHub repository URL
 * @returns Parsed URL components
 * @throws Error if hostname is not GitHub
 *
 * @since SMI-1491
 * @see SMI-2171 - Extracted to @skillsmith/core for shared use
 */
export function parseRepoUrl(repoUrl: string): ParsedRepoUrl {
  const url = new URL(repoUrl)

  // SMI-1533: Validate hostname to prevent fetching from malicious sources
  if (!ALLOWED_HOSTS.includes(url.hostname.toLowerCase())) {
    throw new Error(
      `Invalid repository host: ${url.hostname}. ` +
        `Only GitHub repositories are supported (${ALLOWED_HOSTS.join(', ')})`
    )
  }

  const parts = url.pathname.split('/').filter(Boolean)

  const owner = parts[0]
  const repo = parts[1]

  // /owner/repo (skill at repo root)
  if (parts.length === 2) {
    return { owner, repo, path: '', branch: 'main' }
  }

  // /owner/repo/tree/branch/path... or /owner/repo/blob/branch/path...
  if (parts[2] === 'tree' || parts[2] === 'blob') {
    return {
      owner,
      repo,
      branch: parts[3],
      path: parts.slice(4).join('/'),
    }
  }

  // Unknown format - assume path starts at index 2, default to main branch
  return { owner, repo, path: parts.slice(2).join('/'), branch: 'main' }
}

/**
 * Check if a URL is a valid GitHub repository URL
 *
 * @param url - URL to check
 * @returns true if the URL is a valid GitHub URL
 */
export function isGitHubUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return ALLOWED_HOSTS.includes(parsed.hostname.toLowerCase())
  } catch {
    return false
  }
}
