/**
 * SMI-578: SkillRepository - Type-safe CRUD operations for skills
 *
 * Provides:
 * - Create, Read, Update, Delete operations
 * - Batch insert for 1000+ skills
 * - Transaction support
 * - Type-safe queries
 */

import type { Database as DatabaseType } from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type { Skill, SkillCreateInput, SkillUpdateInput, PaginatedResults } from '../types/skill.js'

interface SkillRow {
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
}

/**
 * Repository for skill CRUD operations
 */
export class SkillRepository {
  private db: DatabaseType

  constructor(db: DatabaseType) {
    this.db = db
    this.prepareStatements()
  }

  private stmts!: {
    insert: {
      run: (...args: unknown[]) => { changes: number }
      get: (id: string) => SkillRow | undefined
    }
    selectById: { get: (id: string) => SkillRow | undefined }
    selectByRepoUrl: { get: (url: string) => SkillRow | undefined }
    selectAll: { all: (limit: number, offset: number) => SkillRow[] }
    selectCount: { get: () => { count: number } }
    update: { run: (...args: unknown[]) => { changes: number } }
    delete: { run: (id: string) => { changes: number } }
    deleteAll: { run: () => { changes: number } }
  }

  private prepareStatements(): void {
    // Cast to our custom types for better-sqlite3 compatibility
    this.stmts = {
      insert: this.db.prepare(`
        INSERT INTO skills (id, name, description, author, repo_url, quality_score, trust_tier, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `) as unknown as typeof this.stmts.insert,

      selectById: this.db.prepare(`
        SELECT * FROM skills WHERE id = ?
      `) as unknown as typeof this.stmts.selectById,

      selectByRepoUrl: this.db.prepare(`
        SELECT * FROM skills WHERE repo_url = ?
      `) as unknown as typeof this.stmts.selectByRepoUrl,

      selectAll: this.db.prepare(`
        SELECT * FROM skills ORDER BY updated_at DESC LIMIT ? OFFSET ?
      `) as unknown as typeof this.stmts.selectAll,

      selectCount: this.db.prepare(`
        SELECT COUNT(*) as count FROM skills
      `) as unknown as typeof this.stmts.selectCount,

      update: this.db.prepare(`
        UPDATE skills SET
          name = COALESCE(?, name),
          description = COALESCE(?, description),
          author = COALESCE(?, author),
          repo_url = COALESCE(?, repo_url),
          quality_score = COALESCE(?, quality_score),
          trust_tier = COALESCE(?, trust_tier),
          tags = COALESCE(?, tags),
          updated_at = datetime('now')
        WHERE id = ?
      `) as unknown as typeof this.stmts.update,

      delete: this.db.prepare(`
        DELETE FROM skills WHERE id = ?
      `) as unknown as typeof this.stmts.delete,

      deleteAll: this.db.prepare(`
        DELETE FROM skills
      `) as unknown as typeof this.stmts.deleteAll,
    }
  }

  /**
   * Convert a database row to a Skill object
   */
  private rowToSkill(row: SkillRow): Skill {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      author: row.author,
      repoUrl: row.repo_url,
      qualityScore: row.quality_score,
      trustTier: row.trust_tier as Skill['trustTier'],
      tags: JSON.parse(row.tags || '[]'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  /**
   * Create a new skill
   */
  create(input: SkillCreateInput): Skill {
    const id = input.id || randomUUID()
    const tags = JSON.stringify(input.tags || [])

    this.stmts.insert.run(
      id,
      input.name,
      input.description ?? null,
      input.author ?? null,
      input.repoUrl ?? null,
      input.qualityScore ?? null,
      input.trustTier ?? 'unknown',
      tags
    )

    const row = this.stmts.selectById.get(id) as SkillRow
    return this.rowToSkill(row)
  }

  /**
   * Create multiple skills in a batch (efficient for 1000+ skills)
   */
  createBatch(inputs: SkillCreateInput[]): Skill[] {
    const insertMany = this.db.transaction((skills: SkillCreateInput[]) => {
      const created: Skill[] = []

      for (const input of skills) {
        const id = input.id || randomUUID()
        const tags = JSON.stringify(input.tags || [])

        try {
          this.stmts.insert.run(
            id,
            input.name,
            input.description ?? null,
            input.author ?? null,
            input.repoUrl ?? null,
            input.qualityScore ?? null,
            input.trustTier ?? 'unknown',
            tags
          )

          const row = this.stmts.selectById.get(id) as SkillRow
          created.push(this.rowToSkill(row))
        } catch (error) {
          // Skip duplicates (repo_url unique constraint)
          if (!(error instanceof Error && error.message.includes('UNIQUE'))) {
            throw error
          }
        }
      }

      return created
    })

    return insertMany(inputs)
  }

  /**
   * Find a skill by ID
   */
  findById(id: string): Skill | null {
    const row = this.stmts.selectById.get(id) as SkillRow | undefined
    return row ? this.rowToSkill(row) : null
  }

  /**
   * Find a skill by repository URL
   */
  findByRepoUrl(repoUrl: string): Skill | null {
    const row = this.stmts.selectByRepoUrl.get(repoUrl) as SkillRow | undefined
    return row ? this.rowToSkill(row) : null
  }

  /**
   * SMI-976: Find all skills with pagination
   * Accepts either options object or positional parameters for backward compatibility
   */
  findAll(options?: { limit?: number; offset?: number }): PaginatedResults<Skill>
  findAll(limit?: number, offset?: number): PaginatedResults<Skill>
  findAll(
    optionsOrLimit?: { limit?: number; offset?: number } | number,
    offsetParam?: number
  ): PaginatedResults<Skill> {
    // Handle both calling conventions
    let limit: number
    let offset: number

    if (typeof optionsOrLimit === 'object' && optionsOrLimit !== null) {
      // Options object: findAll({ limit: 10, offset: 0 })
      limit = optionsOrLimit.limit ?? 20
      offset = optionsOrLimit.offset ?? 0
    } else {
      // Positional params: findAll(10, 0) or findAll()
      limit = optionsOrLimit ?? 20
      offset = offsetParam ?? 0
    }

    const rows = this.stmts.selectAll.all(limit, offset) as SkillRow[]
    const { count } = this.stmts.selectCount.get() as { count: number }

    return {
      items: rows.map((row) => this.rowToSkill(row)),
      total: count,
      limit,
      offset,
      hasMore: offset + rows.length < count,
    }
  }

  /**
   * Update a skill by ID
   */
  update(id: string, input: SkillUpdateInput): Skill | null {
    const tags = input.tags ? JSON.stringify(input.tags) : null

    const result = this.stmts.update.run(
      input.name ?? null,
      input.description ?? null,
      input.author ?? null,
      input.repoUrl ?? null,
      input.qualityScore ?? null,
      input.trustTier ?? null,
      tags,
      id
    )

    if (result.changes === 0) {
      return null
    }

    return this.findById(id)
  }

  /**
   * Delete a skill by ID
   */
  delete(id: string): boolean {
    const result = this.stmts.delete.run(id)
    return result.changes > 0
  }

  /**
   * Delete all skills
   */
  deleteAll(): number {
    const result = this.stmts.deleteAll.run()
    return result.changes
  }

  /**
   * Count all skills
   */
  count(): number {
    const { count } = this.stmts.selectCount.get() as { count: number }
    return count
  }

  /**
   * Execute a function within a transaction
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  /**
   * Check if a skill exists by ID
   */
  exists(id: string): boolean {
    const row = this.stmts.selectById.get(id)
    return !!row
  }

  /**
   * Upsert a skill (insert or update)
   */
  upsert(input: SkillCreateInput): Skill {
    if (input.repoUrl) {
      const existing = this.findByRepoUrl(input.repoUrl)
      if (existing) {
        return this.update(existing.id, input) ?? existing
      }
    }
    return this.create(input)
  }
}
