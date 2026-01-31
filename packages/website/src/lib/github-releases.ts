/**
 * GitHub Releases API utility for changelog page
 * @module lib/github-releases
 *
 * SMI-2071: Fetch changelog from GitHub Releases at build time
 * SMI-2073: Parse CHANGELOG.md for structured changelog entries
 *
 * Fetches public releases from GitHub API (no auth required for public repos).
 * Parses release body markdown into structured changelog format.
 * Also parses local CHANGELOG.md file for complete history.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

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
 * Parse CHANGELOG.md content into structured ChangelogEntry objects
 *
 * Handles Keep a Changelog format:
 * - Version headers: ## [0.3.6] - 2026-01-18
 * - Optional title: ### CLI Hotfix Release (SMI-1575)
 * - Sections: ### Added, ### Changed, ### Fixed, #### Bug Fixes, etc.
 * - Nested bullets with bold text: - **Feature** (SMI-XXX)
 */
export function parseChangelogFile(content: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = []

  // Match version headers: ## [0.3.6] - 2026-01-18
  const versionRegex = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})/gm
  const matches = [...content.matchAll(versionRegex)]

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]
    const version = match[1]
    const dateStr = match[2]
    const startIndex = match.index!
    const endIndex = i < matches.length - 1 ? matches[i + 1].index! : content.length

    // Extract content for this version
    const versionContent = content.slice(startIndex, endIndex)

    // Parse date
    const date = formatDate(new Date(dateStr).toISOString())

    // Extract optional title (first ### heading after version)
    let title: string | undefined
    const titleMatch = versionContent.match(/^###\s+(.+?)(?:\s+\(SMI-\d+\))?$/m)
    if (
      titleMatch &&
      !titleMatch[1]
        .toLowerCase()
        .match(
          /^(added|changed|fixed|deprecated|removed|security|bug fixes?|documentation|infrastructure|performance|testing)/
        )
    ) {
      title = titleMatch[1].trim()
    }

    // Parse sections
    const entry: ChangelogEntry = {
      version,
      date,
    }

    if (title) {
      entry.title = title
    }

    // Map section headers to entry fields
    const sectionMappings: Record<
      string,
      keyof Omit<ChangelogEntry, 'version' | 'date' | 'title'>
    > = {
      added: 'added',
      changed: 'changed',
      fixed: 'fixed',
      'bug fixes': 'fixed',
      deprecated: 'deprecated',
      removed: 'removed',
      security: 'security',
    }

    // Parse each section type
    for (const [pattern, field] of Object.entries(sectionMappings)) {
      const items = extractSectionItems(versionContent, pattern)
      if (items.length > 0) {
        entry[field] = items
      }
    }

    entries.push(entry)
  }

  return entries
}

/**
 * Extract bullet items from a section in CHANGELOG.md
 * Handles both ### and #### headers
 */
function extractSectionItems(content: string, sectionName: string): string[] {
  const items: string[] = []

  // Match ### or #### section headers (case-insensitive)
  const headerRegex = new RegExp(`^#{3,4}\\s+${sectionName}\\s*$`, 'im')
  const headerMatch = content.match(headerRegex)

  if (!headerMatch) return items

  const headerIndex = content.indexOf(headerMatch[0])
  const afterHeader = content.slice(headerIndex + headerMatch[0].length)

  // Find the end of this section (next header or end)
  const nextHeaderMatch = afterHeader.match(/^#{2,4}\s+/m)
  const sectionEnd = nextHeaderMatch ? afterHeader.indexOf(nextHeaderMatch[0]) : afterHeader.length
  const sectionContent = afterHeader.slice(0, sectionEnd)

  // Extract bullet points
  const lines = sectionContent.split('\n')
  let currentItem = ''

  for (const line of lines) {
    const trimmed = line.trim()

    // Top-level bullet (starts with -)
    if (trimmed.startsWith('- ')) {
      // Save previous item if exists
      if (currentItem) {
        items.push(cleanItem(currentItem))
      }
      currentItem = trimmed.slice(2).trim()
    }
    // Nested bullet (indented)
    else if (trimmed.startsWith('-') && currentItem) {
      // Append nested content to current item
      const nestedText = trimmed.slice(1).trim()
      currentItem += ' ' + nestedText
    }
    // Continuation line (not a bullet)
    else if (trimmed && currentItem && !trimmed.startsWith('#')) {
      currentItem += ' ' + trimmed
    }
  }

  // Add last item
  if (currentItem) {
    items.push(cleanItem(currentItem))
  }

  return items
}

/**
 * Clean and normalize changelog item text
 * - Remove excessive whitespace
 * - Remove markdown bold/italic markers
 * - Preserve issue references like (SMI-XXX)
 */
function cleanItem(item: string): string {
  return item
    .replace(/\*\*([^*]+)\*\*/g, '$1') // Remove bold markers
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim()
}

/**
 * Parse local CHANGELOG.md file
 */
export async function parseChangelogFromFile(): Promise<ChangelogEntry[]> {
  try {
    // Get path to CHANGELOG.md from project root
    // From packages/website/src/lib/ or dist location, traverse up to find root
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = dirname(__filename)

    // Try multiple possible paths (handles both src and dist locations)
    const possiblePaths = [
      join(__dirname, '../../../..', 'CHANGELOG.md'), // From src/lib
      join(__dirname, '../../../../..', 'CHANGELOG.md'), // From dist location
      join(__dirname, '../../../../../..', 'CHANGELOG.md'), // Deep dist nesting
    ]

    let content: string | null = null
    let changelogPath = ''

    for (const path of possiblePaths) {
      try {
        content = await readFile(path, 'utf-8')
        changelogPath = path
        break
      } catch {
        // Try next path
      }
    }

    if (!content) {
      console.error('CHANGELOG.md not found in any expected location')
      return []
    }

    console.log(`Loaded CHANGELOG.md from: ${changelogPath}`)
    return parseChangelogFile(content)
  } catch (error) {
    console.error('Failed to parse CHANGELOG.md:', error)
    return []
  }
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
 * These fictional entries are commented out and replaced by CHANGELOG.md parsing (SMI-2073)
 */
/*
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
*/

/**
 * Get changelog entries from CHANGELOG.md with GitHub releases as supplementary
 *
 * @returns Array of ChangelogEntry objects (CHANGELOG.md + GitHub releases)
 */
export async function getChangelogEntries(): Promise<ChangelogEntry[]> {
  // Primary source: CHANGELOG.md
  const changelogEntries = await parseChangelogFromFile()

  // Secondary source: GitHub releases
  const githubReleases = await fetchGitHubReleases()

  if (changelogEntries.length === 0 && githubReleases.length === 0) {
    console.warn('No changelog sources found')
    return []
  }

  // Use CHANGELOG.md as primary source
  if (changelogEntries.length > 0) {
    console.log(`Loaded ${changelogEntries.length} entries from CHANGELOG.md`)
    return changelogEntries
  }

  // Fallback to GitHub releases if CHANGELOG.md parsing failed
  console.warn('CHANGELOG.md parsing failed, using GitHub releases')
  return githubReleases
}
