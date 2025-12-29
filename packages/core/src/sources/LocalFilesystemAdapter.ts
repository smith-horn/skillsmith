/**
 * Local Filesystem Source Adapter (SMI-591)
 *
 * Scans local directories for SKILL.md files.
 * Useful for local development and testing.
 */

import { BaseSourceAdapter } from './BaseSourceAdapter.js'
import type {
  SourceConfig,
  SourceLocation,
  SourceRepository,
  SourceSearchOptions,
  SourceSearchResult,
  SkillContent,
  SourceHealth,
} from './types.js'
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { join, basename, dirname, relative, resolve } from 'path'
import { createLogger } from '../utils/logger.js'
import { validatePath, safePatternMatch } from '../validation/index.js'

const log = createLogger('LocalFilesystemAdapter')

/**
 * Default skill file names to search for
 */
const SKILL_FILE_NAMES = ['SKILL.md', 'skill.md']

/**
 * Configuration for local filesystem adapter
 */
export interface LocalFilesystemConfig extends SourceConfig {
  /** Root directory to scan for skills */
  rootDir: string
  /** Maximum directory depth to search (default: 5) */
  maxDepth?: number
  /** Patterns to exclude (glob-style) */
  excludePatterns?: string[]
  /** Whether to follow symlinks (default: false) */
  followSymlinks?: boolean
}

/**
 * Discovered skill information
 */
interface DiscoveredSkill {
  /** Full path to the skill file */
  path: string
  /** Relative path from root directory */
  relativePath: string
  /** Directory containing the skill */
  directory: string
  /** File stats */
  stats: {
    size: number
    mtime: Date
    ctime: Date
  }
}

/**
 * Local Filesystem Source Adapter
 *
 * Scans local directories to discover and index skills.
 *
 * @example
 * ```typescript
 * const adapter = new LocalFilesystemAdapter({
 *   id: 'local-skills',
 *   name: 'Local Skills',
 *   type: 'local',
 *   baseUrl: 'file://',
 *   enabled: true,
 *   rootDir: '/home/user/.claude/skills'
 * })
 *
 * await adapter.initialize()
 * const result = await adapter.search({})
 * ```
 */
export class LocalFilesystemAdapter extends BaseSourceAdapter {
  private readonly rootDir: string
  private readonly maxDepth: number
  private readonly excludePatterns: string[]
  private readonly followSymlinks: boolean
  private discoveredSkills: DiscoveredSkill[] = []

  constructor(config: LocalFilesystemConfig) {
    super(config)
    this.rootDir = config.rootDir
    this.maxDepth = config.maxDepth ?? 5
    this.excludePatterns = config.excludePatterns ?? ['node_modules', '.git', '.svn', 'dist']
    this.followSymlinks = config.followSymlinks ?? false
  }

  /**
   * Initialize by scanning the filesystem
   */
  protected override async doInitialize(): Promise<void> {
    await this.scanDirectory(this.rootDir, 0)
  }

  /**
   * Check if root directory exists and is accessible
   */
  protected async doHealthCheck(): Promise<Partial<SourceHealth>> {
    try {
      const stats = await fs.stat(this.rootDir)
      return {
        healthy: stats.isDirectory(),
        error: stats.isDirectory() ? undefined : 'Root path is not a directory',
      }
    } catch (error) {
      return {
        healthy: false,
        error: error instanceof Error ? error.message : 'Directory not accessible',
      }
    }
  }

  /**
   * Search for skills in the scanned directories
   */
  async search(options: SourceSearchOptions = {}): Promise<SourceSearchResult> {
    // Re-scan if needed
    if (this.discoveredSkills.length === 0) {
      await this.scanDirectory(this.rootDir, 0)
    }

    let filtered = [...this.discoveredSkills]

    // Filter by query (search in path/directory name)
    if (options.query) {
      const query = options.query.toLowerCase()
      filtered = filtered.filter(
        (skill) =>
          skill.relativePath.toLowerCase().includes(query) ||
          skill.directory.toLowerCase().includes(query)
      )
    }

    // Apply limit
    const limit = options.limit ?? 100
    const limitedResults = filtered.slice(0, limit)

    // Convert to SourceRepository format
    const repositories = await Promise.all(
      limitedResults.map((skill) => this.skillToRepository(skill))
    )

    return {
      repositories,
      totalCount: filtered.length,
      hasMore: filtered.length > limit,
    }
  }

  /**
   * Get repository info for a skill location
   */
  async getRepository(location: SourceLocation): Promise<SourceRepository> {
    const skillPath = this.resolveSkillPath(location)
    const skill = this.discoveredSkills.find((s) => s.path === skillPath)

    if (skill) {
      return this.skillToRepository(skill)
    }

    // Try to get info even if not in discovered list
    try {
      const stats = await fs.stat(skillPath)
      return {
        id: this.generateId(skillPath),
        name: basename(dirname(skillPath)),
        url: `file://${skillPath}`,
        description: null,
        owner: 'local',
        defaultBranch: 'main',
        stars: 0,
        forks: 0,
        topics: ['local'],
        updatedAt: stats.mtime.toISOString(),
        createdAt: stats.ctime.toISOString(),
        license: null,
        metadata: {
          sourceType: 'local',
          path: skillPath,
        },
      }
    } catch (error) {
      throw new Error(
        `Skill not found at ${skillPath}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /**
   * Fetch skill content from local file
   */
  async fetchSkillContent(location: SourceLocation): Promise<SkillContent> {
    const skillPath = this.resolveSkillPath(location)

    try {
      const rawContent = await fs.readFile(skillPath, 'utf-8')
      const stats = await fs.stat(skillPath)
      const sha = this.generateSha(rawContent)

      return {
        rawContent,
        sha,
        location,
        filePath: skillPath,
        encoding: 'utf-8',
        lastModified: stats.mtime.toISOString(),
      }
    } catch (error) {
      throw new Error(
        `Failed to read skill file at ${skillPath}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /**
   * Check if skill exists at location
   */
  override async skillExists(location: SourceLocation): Promise<boolean> {
    const skillPath = this.resolveSkillPath(location)
    try {
      await fs.access(skillPath)
      return true
    } catch {
      return false
    }
  }

  /**
   * Rescan the filesystem for new skills
   */
  async rescan(): Promise<number> {
    this.discoveredSkills = []
    await this.scanDirectory(this.rootDir, 0)
    return this.discoveredSkills.length
  }

  /**
   * Get count of discovered skills
   */
  get skillCount(): number {
    return this.discoveredSkills.length
  }

  /**
   * Scan a directory recursively for skill files
   */
  private async scanDirectory(dirPath: string, depth: number): Promise<void> {
    if (depth > this.maxDepth) return

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = join(dirPath, entry.name)

        // Skip excluded patterns
        if (this.isExcluded(entry.name)) continue

        // Handle symlinks
        let isDirectory = entry.isDirectory()
        let isFile = entry.isFile()

        if (entry.isSymbolicLink()) {
          if (!this.followSymlinks) continue
          try {
            const stats = await fs.stat(fullPath)
            isDirectory = stats.isDirectory()
            isFile = stats.isFile()
          } catch {
            continue // Skip broken symlinks
          }
        }

        // Check for skill files
        if (isFile && SKILL_FILE_NAMES.includes(entry.name)) {
          const stats = await fs.stat(fullPath)
          this.discoveredSkills.push({
            path: fullPath,
            relativePath: relative(this.rootDir, fullPath),
            directory: dirname(fullPath),
            stats: {
              size: stats.size,
              mtime: stats.mtime,
              ctime: stats.ctime,
            },
          })
        }

        // Recurse into directories
        if (isDirectory) {
          await this.scanDirectory(fullPath, depth + 1)
        }
      }
    } catch (error) {
      // Ignore permission errors and continue scanning
      if ((error as NodeJS.ErrnoException).code !== 'EACCES') {
        log.warn(`Error scanning directory ${dirPath}: ${error}`)
      }
    }
  }

  /**
   * Check if a path/name should be excluded (SMI-722, SMI-726)
   * Uses centralized safe pattern matching to prevent RegExp injection
   */
  private isExcluded(name: string): boolean {
    return this.excludePatterns.some((pattern) => safePatternMatch(name, pattern))
  }

  /**
   * Resolve a skill location to a full filesystem path
   * Validates that the resolved path remains within rootDir to prevent path traversal attacks (SMI-720, SMI-726)
   */
  private resolveSkillPath(location: SourceLocation): string {
    let resolvedPath: string

    if (location.path?.startsWith('/')) {
      resolvedPath = location.path
    } else if (location.path) {
      resolvedPath = join(this.rootDir, location.path)
    } else if (location.owner && location.repo) {
      resolvedPath = join(this.rootDir, location.owner, location.repo, 'SKILL.md')
    } else if (location.repo) {
      resolvedPath = join(this.rootDir, location.repo, 'SKILL.md')
    } else {
      throw new Error('Invalid location: must specify path or repo')
    }

    // Use centralized path validation to prevent path traversal attacks
    validatePath(resolvedPath, this.rootDir)

    return resolve(resolvedPath)
  }

  /**
   * Convert discovered skill to SourceRepository
   */
  private async skillToRepository(skill: DiscoveredSkill): Promise<SourceRepository> {
    const dirName = basename(skill.directory)

    // Try to extract metadata from the skill file
    let description: string | null = null
    let name = dirName

    try {
      const content = await fs.readFile(skill.path, 'utf-8')
      // Try to extract name from frontmatter
      const nameMatch = content.match(/^---[\s\S]*?name:\s*["']?([^"'\n]+)["']?/m)
      if (nameMatch) {
        name = nameMatch[1].trim()
      }
      // Try to extract description from frontmatter
      const descMatch = content.match(/^---[\s\S]*?description:\s*["']?([^"'\n]+)["']?/m)
      if (descMatch) {
        description = descMatch[1].trim()
      }
    } catch {
      // Use defaults
    }

    return {
      id: this.generateId(skill.path),
      name,
      url: `file://${skill.path}`,
      description,
      owner: 'local',
      defaultBranch: 'main',
      stars: 0,
      forks: 0,
      topics: ['local'],
      updatedAt: skill.stats.mtime.toISOString(),
      createdAt: skill.stats.ctime.toISOString(),
      license: null,
      metadata: {
        sourceType: 'local',
        path: skill.path,
        relativePath: skill.relativePath,
        size: skill.stats.size,
      },
    }
  }

  /**
   * Generate a deterministic ID from a path
   */
  private generateId(path: string): string {
    return createHash('sha256').update(path).digest('hex').slice(0, 16)
  }

  /**
   * Generate SHA hash for content
   */
  private generateSha(content: string): string {
    return createHash('sha256').update(content).digest('hex')
  }
}

/**
 * Factory function for creating local filesystem adapters
 */
export function createLocalFilesystemAdapter(
  config: LocalFilesystemConfig
): LocalFilesystemAdapter {
  return new LocalFilesystemAdapter({
    ...config,
    type: 'local',
    baseUrl: config.baseUrl ?? 'file://',
  })
}
