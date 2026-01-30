/**
 * GitHub Releases API utility for changelog page
 * @module lib/github-releases
 *
 * SMI-2071: Fetch changelog from GitHub Releases at build time
 *
 * Fetches public releases from GitHub API (no auth required for public repos).
 * Parses release body markdown into structured changelog format.
 */

const GITHUB_REPO = 'smith-horn/skillsmith'
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases`

export interface ChangelogEntry {
  version: string
  date: string
  title?: string
  added?: string[]
  changed?: string[]
  fixed?: string[]
  deprecated?: string[]
  removed?: string[]
  security?: string[]
}

interface GitHubRelease {
  tag_name: string
  name: string | null
  published_at: string
  body: string | null
  draft: boolean
  prerelease: boolean
}

/**
 * Parse release body markdown into structured sections
 *
 * Handles multiple formats:
 * - Standard: "## Added", "## Fixed"
 * - Variations: "### New:", "### Bug Fixes:", "## Security Fixes"
 * - With colons: "## Added:", "### Changed:"
 */
function parseReleaseBody(body: string | null): Partial<ChangelogEntry> {
  if (!body) return {}

  const result: Partial<ChangelogEntry> = {}

  // Map of section names to their possible header variations
  const sectionPatterns: Record<
    keyof Omit<ChangelogEntry, 'version' | 'date' | 'title'>,
    string[]
  > = {
    added: ['added', 'new', 'features', "what's new"],
    changed: ['changed', 'changes', 'updated', 'improvements'],
    fixed: ['fixed', 'bug fix', 'bug fixes', 'fixes', 'bugfixes'],
    deprecated: ['deprecated'],
    removed: ['removed', 'breaking changes', 'breaking'],
    security: ['security', 'security fixes', 'security fix'],
  }

  for (const [section, patterns] of Object.entries(sectionPatterns)) {
    const patternGroup = patterns.join('|')
    // Match ## or ### headers with optional colon, followed by content until next header
    const regex = new RegExp(`#{2,3}\\s*(?:${patternGroup}):?\\s*\\n([\\s\\S]*?)(?=#{2,3}|$)`, 'i')
    const match = body.match(regex)

    if (match) {
      const content = match[1]
      // Extract list items (lines starting with - or *)
      const items = content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('-') || line.startsWith('*'))
        .map((line) => line.replace(/^[-*]\s*/, '').trim())
        // Filter out empty items and markdown formatting artifacts
        .filter(
          (item) =>
            item.length > 0 &&
            !item.startsWith('|') &&
            !item.startsWith('```') &&
            item !== '--' &&
            item !== '---'
        )

      if (items.length > 0) {
        // Type-safe assignment to result
        switch (section) {
          case 'added':
            result.added = items
            break
          case 'changed':
            result.changed = items
            break
          case 'fixed':
            result.fixed = items
            break
          case 'deprecated':
            result.deprecated = items
            break
          case 'removed':
            result.removed = items
            break
          case 'security':
            result.security = items
            break
        }
      }
    }
  }

  return result
}

/**
 * Format date from ISO string to readable format
 */
function formatDate(isoDate: string): string {
  const date = new Date(isoDate)
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

/**
 * Convert GitHub release to ChangelogEntry
 */
function releaseToEntry(release: GitHubRelease): ChangelogEntry {
  const version = release.tag_name.replace(/^v/, '')
  const parsedBody = parseReleaseBody(release.body)

  const entry: ChangelogEntry = {
    version,
    date: formatDate(release.published_at),
    ...parsedBody,
  }

  // Only add title if present (exactOptionalPropertyTypes compliance)
  if (release.name) {
    entry.title = release.name
  }

  return entry
}

/**
 * Fetch releases from GitHub API
 *
 * @param limit - Maximum number of releases to fetch (default: 20)
 * @returns Array of ChangelogEntry objects
 */
export async function fetchGitHubReleases(limit = 20): Promise<ChangelogEntry[]> {
  try {
    const response = await fetch(`${GITHUB_API_URL}?per_page=${limit}`, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'skillsmith-website/1.0',
      },
    })

    if (!response.ok) {
      console.error(`GitHub API error: ${response.status} ${response.statusText}`)
      return []
    }

    const releases: GitHubRelease[] = await response.json()

    // Filter out drafts and convert to entries
    return releases.filter((release) => !release.draft).map(releaseToEntry)
  } catch (error) {
    console.error('Failed to fetch GitHub releases:', error)
    return []
  }
}

/**
 * Hardcoded fallback entries for pre-release history
 * These are kept for historical context when there were no GitHub releases
 */
export const fallbackEntries: ChangelogEntry[] = [
  {
    version: '1.0.0',
    date: 'January 17, 2026',
    title: 'Initial Public Release',
    added: [
      'Skill discovery with semantic search powered by embeddings',
      'MCP server integration for Claude Code',
      'CLI tool for command-line skill management',
      'Four-tier pricing: Community, Individual, Team, Enterprise',
      'Trust tier system: verified, community, experimental, unknown',
      'Quality scoring (0-100) based on documentation, tests, and maintenance',
      'Skill comparison feature for side-by-side evaluation',
      'Personalized recommendations based on project context',
      'API access with rate limiting per tier',
      'Website with documentation, pricing, and legal pages',
    ],
    changed: ['License updated to Elastic License 2.0 (ELv2)'],
  },
  {
    version: '0.9.0',
    date: 'January 10, 2026',
    title: 'Beta Release',
    added: [
      'Beta API endpoint at api.skillsmith.app',
      'Initial skill database with 14,000+ curated skills',
      'Basic search functionality',
      'Skill installation to ~/.claude/skills/',
      'PostHog analytics integration (anonymized)',
    ],
    fixed: [
      'Rate limiting edge cases for anonymous users',
      'Skill metadata parsing for non-standard YAML frontmatter',
    ],
  },
  {
    version: '0.8.0',
    date: 'December 15, 2025',
    title: 'Alpha Release',
    added: [
      'Core skill registry architecture',
      'SQLite-based local database',
      'Embedding service for semantic search',
      'Basic CLI commands: search, install, list',
      'Initial MCP tool definitions',
    ],
    changed: [
      'Migrated from PostgreSQL to SQLite for local-first architecture',
      'Restructured as monorepo with @skillsmith/* packages',
    ],
  },
]

/**
 * Get changelog entries, fetching from GitHub with fallback to hardcoded entries
 *
 * @returns Array of ChangelogEntry objects (GitHub releases + historical fallback)
 */
export async function getChangelogEntries(): Promise<ChangelogEntry[]> {
  const githubReleases = await fetchGitHubReleases()

  if (githubReleases.length === 0) {
    console.warn('No GitHub releases found, using fallback entries')
    return fallbackEntries
  }

  // Get versions from GitHub releases
  const githubVersions = new Set(githubReleases.map((r) => r.version))

  // Add historical entries that aren't in GitHub releases
  const historicalEntries = fallbackEntries.filter((entry) => !githubVersions.has(entry.version))

  // Combine and sort by version (newest first)
  const allEntries = [...githubReleases, ...historicalEntries]

  // Sort by semver (simple string comparison works for x.y.z format)
  allEntries.sort((a, b) => {
    const aParts = a.version.split('.').map(Number)
    const bParts = b.version.split('.').map(Number)

    for (let i = 0; i < 3; i++) {
      if ((bParts[i] || 0) !== (aParts[i] || 0)) {
        return (bParts[i] || 0) - (aParts[i] || 0)
      }
    }
    return 0
  })

  return allEntries
}
