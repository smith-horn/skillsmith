/**
 * SMI-628: IndexerRepository - Database operations for skill indexing
 *
 * Provides:
 * - Upsert skills with conflict resolution on repo_url
 * - Track last_indexed_at for incremental updates
 * - Store raw SKILL.md content for re-parsing
 * - Batch operations for efficient bulk indexing
 */

import type { Database as DatabaseType, Statement } from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type { Skill, SkillCreateInput, TrustTier } from '../types/skill.js'
import type { SkillMetadata } from '../indexer/GitHubIndexer.js'

/**
 * Extended skill with indexing metadata
 */
export interface IndexedSkill extends Skill {
  /**
   * When the skill was last indexed from source
   */
  lastIndexedAt: string

  /**
   * SHA of the source file for change detection
   */
  sourceSha: string | null

  /**
   * Path to the source file in the repository
   */
  sourceFilePath: string | null

  /**
   * Raw content of the SKILL.md file
   */
  rawContent: string | null
}

/**
 * Upsert result
 */
export interface UpsertResult {
  /**
   * Whether this was an insert (true) or update (false)
   */
  inserted: boolean

  /**
   * The resulting skill
   */
  skill: IndexedSkill

  /**
   * Whether the content changed (for updates)
   */
  contentChanged: boolean
}

/**
 * Batch upsert result
 */
export interface BatchUpsertResult {
  /**
   * Total skills processed
   */
  total: number

  /**
   * Number of new skills inserted
   */
  inserted: number

  /**
   * Number of existing skills updated
   */
  updated: number

  /**
   * Number of skills unchanged (same SHA)
   */
  unchanged: number

  /**
   * Any errors that occurred
   */
  errors: Array<{ repoUrl: string; error: string }>
}

interface IndexedSkillRow {
  id: string
  name: string
  description: string | null
  author: string | null
  repo_url: string | null
  quality_score: number | null
  trust_tier: string
  tags: string
  created_at: string
  updated_at: string
  last_indexed_at: string | null
  source_sha: string | null
  source_file_path: string | null
  raw_content: string | null
}

/**
 * Repository for indexer-specific database operations
 */
export class IndexerRepository {
  private db: DatabaseType
  private migrationApplied = false

  constructor(db: DatabaseType) {
    this.db = db
    this.ensureMigration()
    this.prepareStatements()
  }

  private stmts!: {
    selectByRepoUrl: Statement
    selectBySha: Statement
    insertIndexed: Statement
    updateIndexed: Statement
    selectNeedingReindex: Statement
    selectAll: Statement
    updateLastIndexed: Statement
  }

  /**
   * Ensure the indexer columns exist
   */
  private ensureMigration(): void {
    if (this.migrationApplied) return

    // Check if columns exist
    const columns = this.db.pragma('table_info(skills)') as Array<{ name: string }>
    const columnNames = columns.map((c) => c.name)

    // Add missing columns
    if (!columnNames.includes('last_indexed_at')) {
      this.db.exec('ALTER TABLE skills ADD COLUMN last_indexed_at TEXT')
    }

    if (!columnNames.includes('source_sha')) {
      this.db.exec('ALTER TABLE skills ADD COLUMN source_sha TEXT')
    }

    if (!columnNames.includes('source_file_path')) {
      this.db.exec('ALTER TABLE skills ADD COLUMN source_file_path TEXT')
    }

    if (!columnNames.includes('raw_content')) {
      this.db.exec('ALTER TABLE skills ADD COLUMN raw_content TEXT')
    }

    // Add index for faster lookups
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_skills_last_indexed ON skills(last_indexed_at);
      CREATE INDEX IF NOT EXISTS idx_skills_source_sha ON skills(source_sha);
    `)

    this.migrationApplied = true
  }

  private prepareStatements(): void {
    this.stmts = {
      selectByRepoUrl: this.db.prepare(`
        SELECT * FROM skills WHERE repo_url = ?
      `),

      selectBySha: this.db.prepare(`
        SELECT * FROM skills WHERE source_sha = ?
      `),

      insertIndexed: this.db.prepare(`
        INSERT INTO skills (
          id, name, description, author, repo_url, quality_score,
          trust_tier, tags, created_at, updated_at,
          last_indexed_at, source_sha, source_file_path, raw_content
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, datetime('now'), datetime('now'),
          datetime('now'), ?, ?, ?
        )
      `),

      updateIndexed: this.db.prepare(`
        UPDATE skills SET
          name = ?,
          description = ?,
          author = ?,
          quality_score = ?,
          trust_tier = ?,
          tags = ?,
          updated_at = datetime('now'),
          last_indexed_at = datetime('now'),
          source_sha = ?,
          source_file_path = ?,
          raw_content = ?
        WHERE repo_url = ?
      `),

      selectNeedingReindex: this.db.prepare(`
        SELECT * FROM skills
        WHERE last_indexed_at IS NULL
           OR last_indexed_at < datetime('now', ?)
        ORDER BY last_indexed_at ASC NULLS FIRST
        LIMIT ?
      `),

      selectAll: this.db.prepare(`
        SELECT * FROM skills
        WHERE last_indexed_at IS NOT NULL
        ORDER BY last_indexed_at DESC
        LIMIT ? OFFSET ?
      `),

      updateLastIndexed: this.db.prepare(`
        UPDATE skills SET last_indexed_at = datetime('now') WHERE id = ?
      `),
    }
  }

  /**
   * Convert a database row to an IndexedSkill object
   */
  private rowToSkill(row: IndexedSkillRow): IndexedSkill {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      author: row.author,
      repoUrl: row.repo_url,
      qualityScore: row.quality_score,
      trustTier: row.trust_tier as TrustTier,
      tags: JSON.parse(row.tags || '[]'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastIndexedAt: row.last_indexed_at ?? row.updated_at,
      sourceSha: row.source_sha,
      sourceFilePath: row.source_file_path,
      rawContent: row.raw_content,
    }
  }

  /**
   * Upsert a skill from indexer metadata
   */
  upsertFromMetadata(metadata: SkillMetadata, trustTier?: TrustTier): UpsertResult {
    const existing = this.stmts.selectByRepoUrl.get(metadata.repoUrl) as IndexedSkillRow | undefined

    if (existing) {
      // Check if content changed
      if (existing.source_sha === metadata.sha) {
        // Just update the timestamp
        this.stmts.updateLastIndexed.run(existing.id)
        return {
          inserted: false,
          skill: this.rowToSkill({ ...existing, last_indexed_at: new Date().toISOString() }),
          contentChanged: false,
        }
      }

      // Update with new content
      const tags = JSON.stringify(metadata.tags)
      this.stmts.updateIndexed.run(
        metadata.name,
        metadata.description,
        metadata.author ?? metadata.owner,
        this.calculateQualityScore(metadata),
        trustTier ?? 'unknown',
        tags,
        metadata.sha,
        metadata.filePath,
        metadata.rawContent,
        metadata.repoUrl
      )

      const updated = this.stmts.selectByRepoUrl.get(metadata.repoUrl) as IndexedSkillRow
      return {
        inserted: false,
        skill: this.rowToSkill(updated),
        contentChanged: true,
      }
    }

    // Insert new skill
    const id = randomUUID()
    const tags = JSON.stringify(metadata.tags)

    this.stmts.insertIndexed.run(
      id,
      metadata.name,
      metadata.description,
      metadata.author ?? metadata.owner,
      metadata.repoUrl,
      this.calculateQualityScore(metadata),
      trustTier ?? 'unknown',
      tags,
      metadata.sha,
      metadata.filePath,
      metadata.rawContent
    )

    const inserted = this.stmts.selectByRepoUrl.get(metadata.repoUrl) as IndexedSkillRow
    return {
      inserted: true,
      skill: this.rowToSkill(inserted),
      contentChanged: true,
    }
  }

  /**
   * Batch upsert skills from indexer metadata
   */
  batchUpsertFromMetadata(metadataList: SkillMetadata[]): BatchUpsertResult {
    const result: BatchUpsertResult = {
      total: metadataList.length,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      errors: [],
    }

    const transaction = this.db.transaction((items: SkillMetadata[]) => {
      for (const metadata of items) {
        try {
          const upsertResult = this.upsertFromMetadata(metadata)

          if (upsertResult.inserted) {
            result.inserted++
          } else if (upsertResult.contentChanged) {
            result.updated++
          } else {
            result.unchanged++
          }
        } catch (error) {
          result.errors.push({
            repoUrl: metadata.repoUrl,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    })

    transaction(metadataList)
    return result
  }

  /**
   * Find skills that need reindexing
   */
  findNeedingReindex(olderThan: string = '-7 days', limit = 100): IndexedSkill[] {
    const rows = this.stmts.selectNeedingReindex.all(olderThan, limit) as IndexedSkillRow[]
    return rows.map((row) => this.rowToSkill(row))
  }

  /**
   * Find skill by repository URL
   */
  findByRepoUrl(repoUrl: string): IndexedSkill | null {
    const row = this.stmts.selectByRepoUrl.get(repoUrl) as IndexedSkillRow | undefined
    return row ? this.rowToSkill(row) : null
  }

  /**
   * Find skill by source SHA
   */
  findBySha(sha: string): IndexedSkill | null {
    const row = this.stmts.selectBySha.get(sha) as IndexedSkillRow | undefined
    return row ? this.rowToSkill(row) : null
  }

  /**
   * Get all indexed skills with pagination
   */
  findAllIndexed(limit = 20, offset = 0): IndexedSkill[] {
    const rows = this.stmts.selectAll.all(limit, offset) as IndexedSkillRow[]
    return rows.map((row) => this.rowToSkill(row))
  }

  /**
   * Calculate quality score from metadata
   */
  private calculateQualityScore(metadata: SkillMetadata): number {
    let score = 0

    // Has description (20 points)
    if (metadata.description && metadata.description.length > 0) {
      score += 10
      if (metadata.description.length > 100) score += 10
    }

    // Has tags (15 points)
    if (metadata.tags.length > 0) {
      score += 5
      if (metadata.tags.length >= 3) score += 5
      if (metadata.tags.length >= 5) score += 5
    }

    // Has version (10 points)
    if (metadata.version) score += 10

    // Has author (10 points)
    if (metadata.author) score += 10

    // Has license (10 points)
    if (metadata.license) score += 10

    // Has dependencies (10 points)
    if (metadata.dependencies.length > 0) score += 10

    // Has category (10 points)
    if (metadata.category) score += 10

    // Has documentation (15 points)
    if (metadata.rawContent.length > 500) {
      score += 10
      if (metadata.rawContent.length > 1000) score += 5
    }

    return Math.min(score, 100) / 100
  }
}

export default IndexerRepository
