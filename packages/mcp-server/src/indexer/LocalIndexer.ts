/**
 * @fileoverview LocalIndexer - Scans and indexes skills from ~/.claude/skills/
 * @module @skillsmith/mcp-server/indexer/LocalIndexer
 * @see SMI-1809: Local skill indexing for MCP server
 *
 * Provides local skill discovery by scanning the user's skills directory,
 * parsing SKILL.md files for metadata, and returning searchable skill objects.
 *
 * @example
 * const indexer = new LocalIndexer();
 * const skills = await indexer.index();
 * console.log(`Indexed ${skills.length} local skills`);
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

/**
 * Local skill metadata extracted from SKILL.md
 */
export interface LocalSkill {
  /** Unique ID: local/{name} */
  id: string
  /** Skill name from frontmatter or directory name */
  name: string
  /** Description from frontmatter */
  description: string | null
  /** Author from frontmatter (defaults to "local") */
  author: string
  /** Tags from frontmatter */
  tags: string[]
  /** Calculated quality score (0-100) */
  qualityScore: number
  /** Trust tier is always "local" for local skills */
  trustTier: 'local'
  /** Source identifier */
  source: 'local'
  /** Full path to the skill directory */
  path: string
  /** Whether SKILL.md was found */
  hasSkillMd: boolean
  /** Last modified timestamp */
  lastModified: string | null
}

/**
 * Parsed SKILL.md frontmatter fields
 */
interface SkillFrontmatter {
  name: string | null
  description: string | null
  author: string | null
  tags: string[]
  version: string | null
  triggers: string[]
}

/**
 * Quality scoring weights for local skills
 */
const QUALITY_WEIGHTS = {
  hasSkillMd: 20,
  hasName: 10,
  hasDescription: 20,
  hasTags: 15,
  hasAuthor: 5,
  descriptionLength: 15, // Longer descriptions score higher (up to 200 chars)
  tagCount: 15, // More tags score higher (up to 5 tags)
}

/**
 * LocalIndexer class for scanning and indexing local skills
 */
export class LocalIndexer {
  private skillsDir: string
  private cachedSkills: LocalSkill[] | null = null
  private lastIndexTime: number = 0
  private cacheTtl: number

  /**
   * Create a new LocalIndexer
   * @param skillsDir - Custom skills directory (defaults to ~/.claude/skills/)
   * @param cacheTtl - Cache TTL in milliseconds (defaults to 60000 = 1 minute)
   */
  constructor(skillsDir?: string, cacheTtl: number = 60000) {
    this.skillsDir = skillsDir || path.join(os.homedir(), '.claude', 'skills')
    this.cacheTtl = cacheTtl
  }

  /**
   * Parse SKILL.md frontmatter to extract metadata.
   *
   * Supports YAML frontmatter delimited by `---` lines.
   * Extracts name, description, author, tags, version, and triggers.
   *
   * @param content - Content of the SKILL.md file
   * @returns Parsed frontmatter fields
   */
  parseFrontmatter(content: string): SkillFrontmatter {
    const result: SkillFrontmatter = {
      name: null,
      description: null,
      author: null,
      tags: [],
      version: null,
      triggers: [],
    }

    // Check for frontmatter (starts with ---)
    if (!content.startsWith('---')) {
      return result
    }

    // Find the closing --- delimiter
    const secondDelimiterIndex = content.indexOf('---', 3)
    if (secondDelimiterIndex === -1) {
      return result
    }

    // Extract frontmatter content
    const frontmatter = content.substring(3, secondDelimiterIndex).trim()

    // Parse YAML-like frontmatter (simple key: value parsing)
    const lines = frontmatter.split('\n')
    let currentKey: string | null = null
    let inArray = false

    for (const line of lines) {
      const trimmedLine = line.trim()

      // Skip empty lines
      if (!trimmedLine) continue

      // Check for array item (starts with -)
      if (trimmedLine.startsWith('- ') && currentKey && inArray) {
        const value = trimmedLine.substring(2).trim().replace(/^["']|["']$/g, '')
        if (currentKey === 'tags' && value) {
          result.tags.push(value)
        } else if (currentKey === 'triggers' && value) {
          result.triggers.push(value)
        }
        continue
      }

      // Check for key: value pair
      const colonIndex = trimmedLine.indexOf(':')
      if (colonIndex === -1) continue

      const key = trimmedLine.substring(0, colonIndex).trim().toLowerCase()
      const value = trimmedLine.substring(colonIndex + 1).trim()

      // Handle empty value (might be start of array)
      if (!value) {
        currentKey = key
        inArray = true
        continue
      }

      // Parse inline arrays: tags: [testing, development]
      if (value.startsWith('[') && value.endsWith(']')) {
        const arrayContent = value.slice(1, -1)
        const items = arrayContent.split(',').map((item) => item.trim().replace(/^["']|["']$/g, ''))

        if (key === 'tags') {
          result.tags = items.filter(Boolean)
        } else if (key === 'triggers') {
          result.triggers = items.filter(Boolean)
        }
        currentKey = null
        inArray = false
        continue
      }

      // Clean quoted values
      const cleanValue = value.replace(/^["']|["']$/g, '')

      // Assign to appropriate field
      switch (key) {
        case 'name':
          result.name = cleanValue
          break
        case 'description':
          result.description = cleanValue
          break
        case 'author':
          result.author = cleanValue
          break
        case 'version':
          result.version = cleanValue
          break
      }

      currentKey = key
      inArray = false
    }

    return result
  }

  /**
   * Calculate quality score for a local skill.
   *
   * Scoring is based on:
   * - Presence of SKILL.md file (20 points)
   * - Has name in frontmatter (10 points)
   * - Has description (20 points)
   * - Description length up to 200 chars (15 points)
   * - Has tags (15 points)
   * - Tag count up to 5 (15 points)
   * - Has author (5 points)
   *
   * @param frontmatter - Parsed frontmatter
   * @param hasSkillMd - Whether SKILL.md exists
   * @returns Quality score from 0-100
   */
  calculateQualityScore(frontmatter: SkillFrontmatter, hasSkillMd: boolean): number {
    let score = 0

    // Base score for having SKILL.md
    if (hasSkillMd) {
      score += QUALITY_WEIGHTS.hasSkillMd
    }

    // Name presence
    if (frontmatter.name) {
      score += QUALITY_WEIGHTS.hasName
    }

    // Description presence and length
    if (frontmatter.description) {
      score += QUALITY_WEIGHTS.hasDescription
      // Bonus for longer descriptions (up to 200 chars)
      const descLength = Math.min(frontmatter.description.length, 200)
      score += Math.round((descLength / 200) * QUALITY_WEIGHTS.descriptionLength)
    }

    // Tags presence and count
    if (frontmatter.tags.length > 0) {
      score += QUALITY_WEIGHTS.hasTags
      // Bonus for more tags (up to 5)
      const tagBonus = Math.min(frontmatter.tags.length, 5) / 5
      score += Math.round(tagBonus * QUALITY_WEIGHTS.tagCount)
    }

    // Author presence
    if (frontmatter.author) {
      score += QUALITY_WEIGHTS.hasAuthor
    }

    return Math.min(score, 100)
  }

  /**
   * Index a single skill directory.
   *
   * @param skillDir - Path to the skill directory
   * @param dirName - Name of the directory
   * @returns LocalSkill object or null if directory should be skipped
   */
  indexSkillDir(skillDir: string, dirName: string): LocalSkill | null {
    const skillMdPath = path.join(skillDir, 'SKILL.md')
    let hasSkillMd = false
    let content = ''
    let lastModified: string | null = null

    try {
      // Get directory stats
      const stats = fs.statSync(skillDir)
      lastModified = stats.mtime.toISOString()

      // Try to read SKILL.md
      if (fs.existsSync(skillMdPath)) {
        hasSkillMd = true
        content = fs.readFileSync(skillMdPath, 'utf-8')
      }
    } catch (error) {
      // If we can't read the directory, skip it
      console.warn(
        '[LocalIndexer] Failed to read skill directory:',
        skillDir,
        error instanceof Error ? error.message : String(error)
      )
      return null
    }

    // Parse frontmatter
    const frontmatter = this.parseFrontmatter(content)

    // Determine skill name
    const name = frontmatter.name || dirName

    // Calculate quality score
    const qualityScore = this.calculateQualityScore(frontmatter, hasSkillMd)

    return {
      id: `local/${name}`,
      name,
      description: frontmatter.description,
      author: frontmatter.author || 'local',
      tags: frontmatter.tags,
      qualityScore,
      trustTier: 'local',
      source: 'local',
      path: skillDir,
      hasSkillMd,
      lastModified,
    }
  }

  /**
   * Index all skills in the skills directory.
   *
   * Scans ~/.claude/skills/ for subdirectories, parses SKILL.md files,
   * and returns an array of LocalSkill objects.
   *
   * @param force - Force re-index even if cache is valid
   * @returns Promise resolving to array of LocalSkill objects
   */
  async index(force: boolean = false): Promise<LocalSkill[]> {
    // Check cache
    const now = Date.now()
    if (!force && this.cachedSkills && now - this.lastIndexTime < this.cacheTtl) {
      return this.cachedSkills
    }

    // Check if directory exists
    if (!fs.existsSync(this.skillsDir)) {
      this.cachedSkills = []
      this.lastIndexTime = now
      return []
    }

    const skills: LocalSkill[] = []

    try {
      const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true })

      for (const entry of entries) {
        // Skip non-directories and hidden directories
        if (!entry.isDirectory() || entry.name.startsWith('.')) {
          continue
        }

        const skillDir = path.join(this.skillsDir, entry.name)
        const skill = this.indexSkillDir(skillDir, entry.name)

        if (skill) {
          skills.push(skill)
        }
      }
    } catch (error) {
      console.warn(
        '[LocalIndexer] Failed to read skills directory:',
        this.skillsDir,
        error instanceof Error ? error.message : String(error)
      )
    }

    // Sort by name for consistent ordering
    skills.sort((a, b) => a.name.localeCompare(b.name))

    // Update cache
    this.cachedSkills = skills
    this.lastIndexTime = now

    return skills
  }

  /**
   * Synchronous version of index for use in non-async contexts.
   *
   * @param force - Force re-index even if cache is valid
   * @returns Array of LocalSkill objects
   */
  indexSync(force: boolean = false): LocalSkill[] {
    // Check cache
    const now = Date.now()
    if (!force && this.cachedSkills && now - this.lastIndexTime < this.cacheTtl) {
      return this.cachedSkills
    }

    // Check if directory exists
    if (!fs.existsSync(this.skillsDir)) {
      this.cachedSkills = []
      this.lastIndexTime = now
      return []
    }

    const skills: LocalSkill[] = []

    try {
      const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true })

      for (const entry of entries) {
        // Skip non-directories and hidden directories
        if (!entry.isDirectory() || entry.name.startsWith('.')) {
          continue
        }

        const skillDir = path.join(this.skillsDir, entry.name)
        const skill = this.indexSkillDir(skillDir, entry.name)

        if (skill) {
          skills.push(skill)
        }
      }
    } catch (error) {
      console.warn(
        '[LocalIndexer] Failed to read skills directory:',
        this.skillsDir,
        error instanceof Error ? error.message : String(error)
      )
    }

    // Sort by name for consistent ordering
    skills.sort((a, b) => a.name.localeCompare(b.name))

    // Update cache
    this.cachedSkills = skills
    this.lastIndexTime = now

    return skills
  }

  /**
   * Clear the internal cache.
   * Forces re-indexing on next call to index().
   */
  clearCache(): void {
    this.cachedSkills = null
    this.lastIndexTime = 0
  }

  /**
   * Get the skills directory path.
   */
  getSkillsDir(): string {
    return this.skillsDir
  }

  /**
   * Search local skills by query.
   *
   * Performs case-insensitive search across name, description, and tags.
   *
   * @param query - Search query string
   * @param skills - Array of skills to search (optional, uses cached if not provided)
   * @returns Filtered array of matching skills
   */
  search(query: string, skills?: LocalSkill[]): LocalSkill[] {
    const skillsToSearch = skills || this.cachedSkills || []
    const lowerQuery = query.toLowerCase()

    return skillsToSearch.filter((skill) => {
      // Search in name
      if (skill.name.toLowerCase().includes(lowerQuery)) {
        return true
      }

      // Search in description
      if (skill.description?.toLowerCase().includes(lowerQuery)) {
        return true
      }

      // Search in tags
      if (skill.tags.some((tag) => tag.toLowerCase().includes(lowerQuery))) {
        return true
      }

      // Search in author
      if (skill.author.toLowerCase().includes(lowerQuery)) {
        return true
      }

      return false
    })
  }
}

// Export singleton instance for convenience
let defaultIndexer: LocalIndexer | null = null

/**
 * Get the default LocalIndexer instance.
 * Creates one if it doesn't exist.
 */
export function getLocalIndexer(): LocalIndexer {
  if (!defaultIndexer) {
    defaultIndexer = new LocalIndexer()
  }
  return defaultIndexer
}

/**
 * Reset the default LocalIndexer instance (for testing).
 */
export function resetLocalIndexer(): void {
  defaultIndexer = null
}
