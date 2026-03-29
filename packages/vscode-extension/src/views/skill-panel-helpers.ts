/**
 * Helper functions for skill panel HTML generation.
 * Extracted from skill-panel-html.ts to keep file size under 500 lines.
 */

/** Valid GitHub username/repo segment: alphanumeric, dots, hyphens, underscores */
const GITHUB_SEGMENT_RE = /^[a-zA-Z0-9._-]+$/

/** UUID v1-v5 pattern (case-insensitive) */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Infer a GitHub repository URL from a skill ID with author/name pattern.
 * Returns the URL string if the ID looks like a valid GitHub owner/repo,
 * or null if inference should be skipped.
 *
 * Rejects IDs that don't match the GitHub owner/repo pattern:
 * - No slash or multiple slashes (e.g., "no-slash", "a/b/c")
 * - Segments that are UUIDs (e.g., "claude-plugins/550e8400-...")
 * - Segments with characters invalid for GitHub names
 */
export function inferRepositoryUrl(skillId: string): string | null {
  const segments = skillId.split('/')
  // Only infer for exactly two segments (owner/repo).
  // Source-prefixed IDs like "claude-plugins/UUID" or nested paths are rejected.
  if (segments.length !== 2) return null

  const owner = segments[0]!
  const repo = segments[1]!
  if (
    !GITHUB_SEGMENT_RE.test(owner) ||
    !GITHUB_SEGMENT_RE.test(repo) ||
    UUID_RE.test(owner) ||
    UUID_RE.test(repo)
  ) {
    return null
  }

  const candidate = `https://github.com/${skillId}`
  try {
    const parsed = new URL(candidate)
    if (parsed.hostname === 'github.com') return candidate
  } catch {
    // Malformed URL — skip inference
  }
  return null
}
