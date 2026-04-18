/**
 * Local Filesystem Source Adapter (SMI-591, SMI-4287)
 *
 * Scans local directories for SKILL.md files.
 * Useful for local development and testing.
 *
 * SMI-4287 hardening:
 * - Symlink targets are resolved via `fs.realpath` and checked against the
 *   adapter's `rootDir`. Targets outside root are skipped with a
 *   `symlink-escape` warning (unless `allowSymlinksOutsideRoot` is `true`).
 * - Permission (EACCES/EPERM), not-found (ENOENT), and loop (ELOOP) errors
 *   are surfaced as `AdapterError` entries on `SourceSearchResult.warnings`
 *   instead of throwing, so siblings continue to be scanned.
 * - All `fs.*` calls route through the typed `safeFs` helpers; the historic
 *   bare `try/catch` for EACCES in `scanDirectory` is removed.
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
  AdapterError,
} from './types.js'
import { createHash } from 'crypto'
import { basename, dirname, resolve, join } from 'path'
import { createLogger } from '../utils/logger.js'
import { validatePath, safePatternMatch } from '../validation/index.js'
import { safeFs } from './LocalFilesystemAdapter.helpers.js'
import {
  scanDirectoryRecursive,
  type DiscoveredSkillRecord,
} from './LocalFilesystemAdapter.scan.js'

const log = createLogger('LocalFilesystemAdapter')

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
  /**
   * Allow symlinks whose target resolves outside `rootDir` (SMI-4287).
   *
   * Default `false`: symlinks pointing outside the scan root are skipped and
   * a `symlink-escape` entry is added to `SourceSearchResult.warnings`. This
   * prevents an attacker with write access to `rootDir` from exfiltrating
   * content from arbitrary locations on the filesystem (GitHub #600).
   *
   * Set to `true` only if you trust every symlink inside `rootDir` (e.g.
   * monorepo layouts that intentionally point at sibling packages). The
   * caller accepts the security tradeoff.
   *
   * Note: this flag has no effect when `followSymlinks` is `false` — symlinks
   * are never traversed in that case.
   */
  allowSymlinksOutsideRoot?: boolean
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
 * for (const warning of result.warnings ?? []) {
 *   console.warn(`[${warning.code}] ${warning.message}`)
 * }
 * ```
 */
export class LocalFilesystemAdapter extends BaseSourceAdapter {
  private readonly rootDir: string
  private readonly maxDepth: number
  private readonly excludePatterns: string[]
  private readonly followSymlinks: boolean
  private readonly allowSymlinksOutsideRoot: boolean
  private discoveredSkills: DiscoveredSkillRecord[] = []
  /**
   * Warnings accumulated during the most recent scan. Consumed and cleared
   * by `search()` so each caller sees only the warnings from that call's
   * underlying scan.
   */
  private scanWarnings: AdapterError[] = []

  constructor(config: LocalFilesystemConfig) {
    super(config)
    this.rootDir = config.rootDir
    this.maxDepth = config.maxDepth ?? 5
    this.excludePatterns = config.excludePatterns ?? ['node_modules', '.git', '.svn', 'dist']
    this.followSymlinks = config.followSymlinks ?? false
    this.allowSymlinksOutsideRoot = config.allowSymlinksOutsideRoot ?? false
  }

  /**
   * Initialize by scanning the filesystem
   */
  protected override async doInitialize(): Promise<void> {
    this.scanWarnings = []
    await this.runScan()
  }

  /**
   * Check if root directory exists and is accessible.
   *
   * SMI-4287: routes `fs.stat(rootDir)` through `safeFs` so the raw Node
   * error is translated to a typed `AdapterError` message.
   */
  protected async doHealthCheck(): Promise<Partial<SourceHealth>> {
    const statResult = await safeFs.stat(this.rootDir)
    if (!statResult.ok) {
      return {
        healthy: false,
        error: statResult.error.message,
      }
    }
    return {
      healthy: statResult.value.isDirectory(),
      error: statResult.value.isDirectory() ? undefined : 'Root path is not a directory',
    }
  }

  /**
   * Search for skills in the scanned directories.
   *
   * SMI-4287: `warnings` collects non-fatal `AdapterError` entries from the
   * scan (symlink escapes, permission denials, loops). An empty array is
   * returned as `undefined` to keep the field strictly optional.
   */
  async search(options: SourceSearchOptions = {}): Promise<SourceSearchResult> {
    if (this.discoveredSkills.length === 0) {
      this.scanWarnings = []
      await this.runScan()
    }

    let filtered = [...this.discoveredSkills]

    if (options.query) {
      const query = options.query.toLowerCase()
      filtered = filtered.filter(
        (skill) =>
          skill.relativePath.toLowerCase().includes(query) ||
          skill.directory.toLowerCase().includes(query)
      )
    }

    const limit = options.limit ?? 100
    const limitedResults = filtered.slice(0, limit)

    const repositoriesWithWarnings = await Promise.all(
      limitedResults.map((skill) => this.skillToRepository(skill))
    )
    const repositories = repositoriesWithWarnings.map((r) => r.repo)
    const repoWarnings = repositoriesWithWarnings.flatMap((r) => r.warnings)
    const allWarnings = [...this.scanWarnings, ...repoWarnings]

    return {
      repositories,
      totalCount: filtered.length,
      hasMore: filtered.length > limit,
      warnings: allWarnings.length > 0 ? allWarnings : undefined,
    }
  }

  /**
   * Get repository info for a skill location.
   *
   * SMI-4287: `fs.stat` is routed through `safeFs`; permission errors are
   * converted to typed Error messages instead of raw Node throws.
   */
  async getRepository(location: SourceLocation): Promise<SourceRepository> {
    const skillPath = this.resolveSkillPath(location)
    const skill = this.discoveredSkills.find((s) => s.path === skillPath)

    if (skill) {
      const { repo } = await this.skillToRepository(skill)
      return repo
    }

    const statResult = await safeFs.stat(skillPath)
    if (!statResult.ok) {
      throw new Error(`Skill not found at ${skillPath}: ${statResult.error.message}`)
    }
    const stats = statResult.value
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
  }

  /**
   * Fetch skill content from local file.
   *
   * SMI-4287: both `fs.readFile` and `fs.stat` route through `safeFs`, so
   * permission errors (EACCES/EPERM) raise typed Errors with path context
   * instead of raw Node errors.
   */
  async fetchSkillContent(location: SourceLocation): Promise<SkillContent> {
    const skillPath = this.resolveSkillPath(location)

    const contentResult = await safeFs.readFile(skillPath)
    if (!contentResult.ok) {
      throw new Error(`Failed to read skill file at ${skillPath}: ${contentResult.error.message}`)
    }
    const statResult = await safeFs.stat(skillPath)
    if (!statResult.ok) {
      throw new Error(`Failed to stat skill file at ${skillPath}: ${statResult.error.message}`)
    }
    const rawContent = contentResult.value
    const stats = statResult.value
    const sha = this.generateSha(rawContent)

    return {
      rawContent,
      sha,
      location,
      filePath: skillPath,
      encoding: 'utf-8',
      lastModified: stats.mtime.toISOString(),
    }
  }

  /**
   * Check if skill exists at location
   */
  override async skillExists(location: SourceLocation): Promise<boolean> {
    const skillPath = this.resolveSkillPath(location)
    const statResult = await safeFs.stat(skillPath)
    return statResult.ok
  }

  /**
   * Rescan the filesystem for new skills.
   *
   * Returns the count of discovered skills. Warnings from the rescan are
   * available via the next call to `search()`.
   */
  async rescan(): Promise<number> {
    this.discoveredSkills = []
    this.scanWarnings = []
    await this.runScan()
    return this.discoveredSkills.length
  }

  /**
   * Get count of discovered skills
   */
  get skillCount(): number {
    return this.discoveredSkills.length
  }

  /**
   * Run the recursive scan starting at `rootDir`. Delegates to the extracted
   * `scanDirectoryRecursive` helper (see `LocalFilesystemAdapter.scan.ts`).
   */
  private async runScan(): Promise<void> {
    await scanDirectoryRecursive(this.rootDir, 0, {
      rootDir: this.rootDir,
      maxDepth: this.maxDepth,
      followSymlinks: this.followSymlinks,
      allowSymlinksOutsideRoot: this.allowSymlinksOutsideRoot,
      isExcluded: (name) => this.isExcluded(name),
      discovered: this.discoveredSkills,
      warnings: this.scanWarnings,
      log,
    })
  }

  /**
   * Check if a path/name should be excluded (SMI-722, SMI-726)
   * Uses centralized safe pattern matching to prevent RegExp injection
   */
  private isExcluded(name: string): boolean {
    return this.excludePatterns.some((pattern) => safePatternMatch(name, pattern))
  }

  /**
   * Resolve a skill location to a full filesystem path.
   *
   * Validates that the resolved path remains within rootDir to prevent path
   * traversal attacks (SMI-720, SMI-726, SMI-4287).
   *
   * SMI-4287: removes the historic absolute-path bypass — every path flows
   * through `validatePath`, including `location.path` that happens to start
   * with `/`. Absolute paths outside `rootDir` now throw `ValidationError`
   * consistently.
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

    validatePath(resolvedPath, this.rootDir)

    return resolve(resolvedPath)
  }

  /**
   * Convert discovered skill to SourceRepository.
   *
   * Returns both the repository and any warnings encountered while reading
   * the file (typically permission errors on SKILL.md after discovery).
   */
  private async skillToRepository(
    skill: DiscoveredSkillRecord
  ): Promise<{ repo: SourceRepository; warnings: AdapterError[] }> {
    const dirName = basename(skill.directory)
    const warnings: AdapterError[] = []

    let description: string | null = null
    let name = dirName

    const contentResult = await safeFs.readFile(skill.path)
    if (contentResult.ok) {
      const content = contentResult.value
      const nameMatch = content.match(/^---[\s\S]*?name:\s*["']?([^"'\n]+)["']?/m)
      if (nameMatch) {
        name = nameMatch[1].trim()
      }
      const descMatch = content.match(/^---[\s\S]*?description:\s*["']?([^"'\n]+)["']?/m)
      if (descMatch) {
        description = descMatch[1].trim()
      }
    } else {
      warnings.push(contentResult.error)
    }

    return {
      repo: {
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
      },
      warnings,
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
