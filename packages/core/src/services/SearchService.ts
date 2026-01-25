/**
 * SMI-579: SearchService - FTS5 search with BM25 ranking
 *
 * Features:
 * - Full-text search using SQLite FTS5
 * - BM25 ranking for relevance scoring
 * - Phrase queries and boolean operators
 * - Result highlighting for matched terms
 * - Pagination support
 * - Search caching
 */

import type { Database as DatabaseType } from 'better-sqlite3'
import type {
  Skill,
  SearchOptions,
  SearchResult,
  PaginatedResults,
  TrustTier,
} from '../types/skill.js'
import { CacheRepository } from '../repositories/CacheRepository.js'

// Re-export types for public API
export type { FTSRow, BooleanSearchTerms, SearchCacheOptions } from './SearchService.types.js'

// Internal imports
import type { FTSRow } from './SearchService.types.js'
import {
  escapeFtsToken,
  buildFtsQuery,
  buildCacheKey,
  rowToSkill,
  buildSearchResult,
} from './SearchService.helpers.js'

// Re-export helpers for testing and advanced usage
export { escapeFtsToken, buildFtsQuery, buildHighlights } from './SearchService.helpers.js'

/**
 * Full-text search service with BM25 ranking
 */
export class SearchService {
  private db: DatabaseType
  private cache: CacheRepository
  private cacheTtl: number

  constructor(db: DatabaseType, options?: { cacheTtl?: number }) {
    this.db = db
    this.cache = new CacheRepository(db)
    this.cacheTtl = options?.cacheTtl ?? 300 // 5 minutes default
  }

  /**
   * Search skills using FTS5 with BM25 ranking
   */
  search(options: SearchOptions): PaginatedResults<SearchResult> {
    const {
      query,
      limit = 20,
      offset = 0,
      trustTier,
      minQualityScore,
      category,
      // SMI-825: Security filters
      safeOnly,
      maxRiskScore,
    } = options

    // Check cache first
    const cacheKey = buildCacheKey(options)
    const cached = this.cache.get<PaginatedResults<SearchResult>>(cacheKey)
    if (cached) {
      return cached
    }

    // ADR-019: Handle empty/whitespace-only queries with filter-only search
    const trimmedQuery = query?.trim() || ''
    if (trimmedQuery.length === 0) {
      return this.searchByFiltersOnly(options)
    }

    // Build the FTS5 query
    const ftsQuery = buildFtsQuery(query)

    // Handle case where query contains only special characters (results in empty FTS query)
    if (!ftsQuery) {
      return this.searchByFiltersOnly(options)
    }

    // Build filter conditions
    const filters: string[] = []
    const params: (string | number)[] = [ftsQuery]

    if (trustTier) {
      filters.push('s.trust_tier = ?')
      params.push(trustTier)
    }

    if (minQualityScore !== undefined) {
      filters.push('s.quality_score >= ?')
      params.push(minQualityScore)
    }

    // SMI-825: Security filters
    if (safeOnly) {
      filters.push('s.security_passed = 1')
    }

    if (maxRiskScore !== undefined) {
      filters.push('(s.risk_score IS NULL OR s.risk_score <= ?)')
      params.push(maxRiskScore)
    }

    // SMI-1787: Category filter - check both junction table AND tags JSON
    // Junction table may be empty for locally indexed skills
    if (category) {
      filters.push(`(
        EXISTS (
          SELECT 1 FROM skill_categories sc
          INNER JOIN categories c ON sc.category_id = c.id
          WHERE sc.skill_id = s.id AND c.name = ?
        )
        OR s.tags LIKE ?
      )`)
      params.push(category)
      params.push(`%"${category}"%`) // Match category in JSON tags array
    }

    const whereClause = filters.length > 0 ? `AND ${filters.join(' AND ')}` : ''

    // Count total results
    const countSql = `
      SELECT COUNT(*) as total
      FROM skills s
      INNER JOIN skills_fts f ON s.rowid = f.rowid
      WHERE skills_fts MATCH ?
      ${whereClause}
    `

    const { total } = this.db.prepare(countSql).get(...params) as { total: number }

    // Get paginated results with BM25 ranking
    const searchSql = `
      SELECT
        s.*,
        bm25(skills_fts, 10.0, 5.0, 1.0, 2.0) as rank
      FROM skills s
      INNER JOIN skills_fts f ON s.rowid = f.rowid
      WHERE skills_fts MATCH ?
      ${whereClause}
      ORDER BY rank
      LIMIT ? OFFSET ?
    `

    params.push(limit, offset)
    const rows = this.db.prepare(searchSql).all(...params) as FTSRow[]

    // Build results with highlights
    const items = rows.map((row) => buildSearchResult(row, query))

    const result: PaginatedResults<SearchResult> = {
      items,
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
    }

    // Cache the results
    this.cache.set(cacheKey, result, this.cacheTtl)

    return result
  }

  /**
   * Search with phrase query support
   */
  searchPhrase(
    phrase: string,
    options?: Omit<SearchOptions, 'query'>
  ): PaginatedResults<SearchResult> {
    // Wrap in quotes for exact phrase matching
    const query = `"${phrase.replace(/"/g, '""')}"`
    return this.search({ ...options, query })
  }

  /**
   * Search with boolean operators (AND, OR, NOT)
   */
  searchBoolean(
    terms: { must?: string[]; should?: string[]; not?: string[] },
    options?: Omit<SearchOptions, 'query'>
  ): PaginatedResults<SearchResult> {
    const parts: string[] = []

    if (terms.must?.length) {
      parts.push(terms.must.map((t) => escapeFtsToken(t)).join(' AND '))
    }

    if (terms.should?.length) {
      parts.push(`(${terms.should.map((t) => escapeFtsToken(t)).join(' OR ')})`)
    }

    if (terms.not?.length) {
      parts.push(terms.not.map((t) => `NOT ${escapeFtsToken(t)}`).join(' AND '))
    }

    const query = parts.join(' AND ')
    return this.search({ ...options, query })
  }

  /**
   * Get search suggestions based on partial input
   */
  suggest(prefix: string, limit: number = 5): string[] {
    const sql = `
      SELECT DISTINCT name
      FROM skills
      WHERE name LIKE ? || '%'
      ORDER BY quality_score DESC NULLS LAST
      LIMIT ?
    `

    const rows = this.db.prepare(sql).all(prefix, limit) as { name: string }[]
    return rows.map((row) => row.name)
  }

  /**
   * Find similar skills based on a skill's content
   */
  findSimilar(skillId: string, limit: number = 5): SearchResult[] {
    const skill = this.db.prepare('SELECT * FROM skills WHERE id = ?').get(skillId) as
      | FTSRow
      | undefined
    if (!skill) return []

    // Build a query from the skill's name and tags
    const tags = JSON.parse(skill.tags || '[]') as string[]
    const queryParts = [skill.name, ...tags].filter(Boolean)
    const query = queryParts.map((p) => escapeFtsToken(p)).join(' OR ')

    const sql = `
      SELECT
        s.*,
        bm25(skills_fts, 10.0, 5.0, 1.0, 2.0) as rank
      FROM skills s
      INNER JOIN skills_fts f ON s.rowid = f.rowid
      WHERE skills_fts MATCH ?
        AND s.id != ?
      ORDER BY rank
      LIMIT ?
    `

    const rows = this.db.prepare(sql).all(query, skillId, limit) as FTSRow[]
    return rows.map((row) => buildSearchResult(row, skill.name))
  }

  /**
   * Get popular skills by trust tier
   */
  getPopular(trustTier?: TrustTier, limit: number = 10): Skill[] {
    let sql = `
      SELECT * FROM skills
      WHERE quality_score IS NOT NULL
    `

    const params: (string | number)[] = []

    if (trustTier) {
      sql += ' AND trust_tier = ?'
      params.push(trustTier)
    }

    sql += ' ORDER BY quality_score DESC LIMIT ?'
    params.push(limit)

    const rows = this.db.prepare(sql).all(...params) as FTSRow[]
    return rows.map((row) => rowToSkill(row))
  }

  /**
   * Clear the search cache
   */
  clearCache(): number {
    return this.cache.clear()
  }

  /**
   * ADR-019: Filter-only search when query is empty
   * Queries the skills table directly instead of using FTS5
   */
  private searchByFiltersOnly(options: SearchOptions): PaginatedResults<SearchResult> {
    const {
      limit = 20,
      offset = 0,
      trustTier,
      minQualityScore,
      category,
      // SMI-825: Security filters
      safeOnly,
      maxRiskScore,
    } = options

    // Check cache first
    const cacheKey = buildCacheKey(options)
    const cached = this.cache.get<PaginatedResults<SearchResult>>(cacheKey)
    if (cached) {
      return cached
    }

    // Build base query
    const params: (string | number)[] = []
    let countSql: string
    let searchSql: string

    if (category) {
      // SMI-1787: Category filter - check both junction table AND tags JSON
      // Junction table may be empty for locally indexed skills
      // Tags array stores category from skill metadata
      const baseWhere = `
        FROM skills s
        WHERE (
          EXISTS (
            SELECT 1 FROM skill_categories sc
            INNER JOIN categories c ON sc.category_id = c.id
            WHERE sc.skill_id = s.id AND c.name = ?
          )
          OR s.tags LIKE ?
        )`

      const filters: string[] = []
      params.push(category)
      params.push(`%"${category}"%`) // Match category in JSON tags array

      if (trustTier) {
        filters.push('s.trust_tier = ?')
        params.push(trustTier)
      }

      if (minQualityScore !== undefined) {
        filters.push('s.quality_score >= ?')
        params.push(minQualityScore)
      }

      // SMI-825: Security filters
      if (safeOnly) {
        filters.push('s.security_passed = 1')
      }

      if (maxRiskScore !== undefined) {
        filters.push('(s.risk_score IS NULL OR s.risk_score <= ?)')
        params.push(maxRiskScore)
      }

      const whereClause = filters.length > 0 ? ` AND ${filters.join(' AND ')}` : ''

      countSql = `SELECT COUNT(*) as total ${baseWhere}${whereClause}`
      searchSql = `
        SELECT s.*, 1.0 as rank
        ${baseWhere}${whereClause}
        ORDER BY s.quality_score DESC NULLS LAST
        LIMIT ? OFFSET ?`
    } else {
      // No category filter - simpler query
      const filters: string[] = []

      if (trustTier) {
        filters.push('s.trust_tier = ?')
        params.push(trustTier)
      }

      if (minQualityScore !== undefined) {
        filters.push('s.quality_score >= ?')
        params.push(minQualityScore)
      }

      // SMI-825: Security filters
      if (safeOnly) {
        filters.push('s.security_passed = 1')
      }

      if (maxRiskScore !== undefined) {
        filters.push('(s.risk_score IS NULL OR s.risk_score <= ?)')
        params.push(maxRiskScore)
      }

      const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''

      countSql = `SELECT COUNT(*) as total FROM skills s ${whereClause}`
      searchSql = `
        SELECT s.*, 1.0 as rank
        FROM skills s
        ${whereClause}
        ORDER BY s.quality_score DESC NULLS LAST
        LIMIT ? OFFSET ?`
    }

    // Get total count (using params without limit/offset)
    const { total } = this.db.prepare(countSql).get(...params) as { total: number }

    // Get paginated results
    params.push(limit, offset)
    const rows = this.db.prepare(searchSql).all(...params) as FTSRow[]

    // Build results (no highlights for filter-only search)
    const items = rows.map((row) => ({
      skill: rowToSkill(row),
      rank: 1.0,
      highlights: {},
    }))

    const result: PaginatedResults<SearchResult> = {
      items,
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
    }

    // Cache the results
    this.cache.set(cacheKey, result, this.cacheTtl)

    return result
  }
}
