/**
 * SMI-579, SMI-627: SearchService - FTS5 + Vector Similarity Search
 *
 * Features:
 * - Full-text search using SQLite FTS5
 * - BM25 ranking for relevance scoring
 * - Vector similarity search with embeddings (all-MiniLM-L6-v2)
 * - Hybrid search combining FTS5 + vector scores
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
import { EmbeddingService } from '../embeddings/index.js'

interface FTSRow {
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
  rank: number
}

/**
 * Extended search options with hybrid search support
 */
export interface HybridSearchOptions extends SearchOptions {
  /**
   * Search mode: 'fts' (default), 'vector', or 'hybrid'
   */
  mode?: 'fts' | 'vector' | 'hybrid'
  /**
   * Weight for FTS5 score in hybrid mode (0-1, default: 0.7)
   */
  ftsWeight?: number
  /**
   * Weight for vector similarity score in hybrid mode (0-1, default: 0.3)
   */
  vectorWeight?: number
}

/**
 * Vector search result with similarity score
 */
export interface VectorSearchResult {
  skill: Skill
  similarityScore: number
}

/**
 * Hybrid search result combining FTS and vector scores
 */
export interface HybridSearchResult extends SearchResult {
  ftsScore?: number
  vectorScore?: number
  combinedScore: number
}

/**
 * Search service options
 */
export interface SearchServiceOptions {
  cacheTtl?: number
  enableEmbeddings?: boolean
  embeddingDbPath?: string
}

/**
 * Full-text and vector similarity search service with hybrid ranking
 */
export class SearchService {
  private db: DatabaseType
  private cache: CacheRepository
  private cacheTtl: number
  private embeddings: EmbeddingService | null = null
  private embeddingsReady: boolean = false
  private embeddingsInitPromise: Promise<void> | null = null

  constructor(db: DatabaseType, options?: SearchServiceOptions) {
    this.db = db
    this.cache = new CacheRepository(db)
    this.cacheTtl = options?.cacheTtl ?? 300 // 5 minutes default

    // Initialize embedding service if enabled
    if (options?.enableEmbeddings !== false) {
      this.embeddings = new EmbeddingService(options?.embeddingDbPath)
    }
  }

  /**
   * Initialize the embedding model (lazy loading)
   * Call this before using vector or hybrid search for faster first query
   */
  async initializeEmbeddings(): Promise<void> {
    if (this.embeddingsReady || !this.embeddings) return

    if (!this.embeddingsInitPromise) {
      this.embeddingsInitPromise = this.embeddings.loadModel().then(() => {
        this.embeddingsReady = true
      })
    }

    return this.embeddingsInitPromise
  }

  /**
   * Check if embeddings are available and ready
   */
  get hasEmbeddings(): boolean {
    return this.embeddings !== null
  }

  /**
   * Search skills using FTS5 with BM25 ranking
   */
  search(options: SearchOptions): PaginatedResults<SearchResult> {
    const { query, limit = 20, offset = 0, trustTier, minQualityScore } = options

    // Check cache first
    const cacheKey = this.buildCacheKey(options)
    const cached = this.cache.get<PaginatedResults<SearchResult>>(cacheKey)
    if (cached) {
      return cached
    }

    // Build the FTS5 query
    const ftsQuery = this.buildFtsQuery(query)

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
    const items = rows.map((row) => this.buildSearchResult(row, query))

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
      parts.push(terms.must.map((t) => this.escapeFtsToken(t)).join(' AND '))
    }

    if (terms.should?.length) {
      parts.push(`(${terms.should.map((t) => this.escapeFtsToken(t)).join(' OR ')})`)
    }

    if (terms.not?.length) {
      parts.push(terms.not.map((t) => `NOT ${this.escapeFtsToken(t)}`).join(' AND '))
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
    const query = queryParts.map((p) => this.escapeFtsToken(p)).join(' OR ')

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
    return rows.map((row) => this.buildSearchResult(row, skill.name))
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
    return rows.map((row) => this.rowToSkill(row))
  }

  /**
   * Clear the search cache
   */
  clearCache(): number {
    return this.cache.clear()
  }

  /**
   * Vector similarity search using embeddings
   * @param query - The search query text
   * @param limit - Maximum number of results
   * @param options - Additional filter options
   * @returns Array of skills sorted by similarity score
   */
  async vectorSearch(
    query: string,
    limit: number = 20,
    options?: { trustTier?: TrustTier; minQualityScore?: number }
  ): Promise<VectorSearchResult[]> {
    if (!this.embeddings) {
      throw new Error(
        'Embeddings not enabled. Initialize SearchService with enableEmbeddings: true'
      )
    }

    // Ensure embeddings are initialized
    await this.initializeEmbeddings()

    // Generate query embedding
    const queryEmbedding = await this.embeddings.embed(query)

    // Find similar skills
    const similarResults = this.embeddings.findSimilar(queryEmbedding, limit * 2)

    // Fetch skill details and apply filters
    const results: VectorSearchResult[] = []

    for (const { skillId, score } of similarResults) {
      const skill = this.db.prepare('SELECT * FROM skills WHERE id = ?').get(skillId) as
        | FTSRow
        | undefined

      if (!skill) continue

      // Apply filters
      if (options?.trustTier && skill.trust_tier !== options.trustTier) continue
      if (
        options?.minQualityScore !== undefined &&
        (skill.quality_score ?? 0) < options.minQualityScore
      )
        continue

      results.push({
        skill: this.rowToSkill(skill),
        similarityScore: score,
      })

      if (results.length >= limit) break
    }

    return results
  }

  /**
   * Hybrid search combining FTS5 keyword search with vector similarity
   * Uses weighted scoring: combinedScore = ftsWeight * ftsScore + vectorWeight * vectorScore
   *
   * @param options - Hybrid search options including mode and weights
   * @returns Paginated results with combined scoring
   */
  async hybridSearch(options: HybridSearchOptions): Promise<PaginatedResults<HybridSearchResult>> {
    const {
      query,
      limit = 20,
      offset = 0,
      trustTier,
      minQualityScore,
      mode = 'hybrid',
      ftsWeight = 0.7,
      vectorWeight = 0.3,
    } = options

    // Check cache first
    const cacheKey = `hybrid:${JSON.stringify(options)}`
    const cached = this.cache.get<PaginatedResults<HybridSearchResult>>(cacheKey)
    if (cached) {
      return cached
    }

    // For FTS-only mode, delegate to regular search
    if (mode === 'fts') {
      const ftsResults = this.search({ query, limit, offset, trustTier, minQualityScore })
      const items: HybridSearchResult[] = ftsResults.items.map((r) => ({
        ...r,
        ftsScore: r.rank,
        combinedScore: r.rank,
      }))
      return { ...ftsResults, items }
    }

    // For vector-only mode
    if (mode === 'vector') {
      const vectorResults = await this.vectorSearch(query, limit + offset, {
        trustTier,
        minQualityScore,
      })
      const items: HybridSearchResult[] = vectorResults.slice(offset, offset + limit).map((r) => ({
        skill: r.skill,
        rank: r.similarityScore,
        highlights: {},
        vectorScore: r.similarityScore,
        combinedScore: r.similarityScore,
      }))
      return {
        items,
        total: vectorResults.length,
        limit,
        offset,
        hasMore: offset + items.length < vectorResults.length,
      }
    }

    // Hybrid mode: combine FTS and vector results
    // Get all FTS results (no pagination, we'll merge and paginate later)
    const ftsResults = this.search({
      query,
      limit: 100,
      offset: 0,
      trustTier,
      minQualityScore,
    })

    // Get vector results
    const vectorResults = await this.vectorSearch(query, 100, { trustTier, minQualityScore })

    // Create score maps
    const ftsScoreMap = new Map<
      string,
      { skill: Skill; score: number; highlights: SearchResult['highlights'] }
    >()
    const vectorScoreMap = new Map<string, { skill: Skill; score: number }>()

    // Normalize FTS scores (BM25 scores can vary widely)
    const maxFtsScore = Math.max(...ftsResults.items.map((r) => r.rank), 1)
    for (const result of ftsResults.items) {
      ftsScoreMap.set(result.skill.id, {
        skill: result.skill,
        score: result.rank / maxFtsScore, // Normalize to 0-1
        highlights: result.highlights,
      })
    }

    // Vector scores are already normalized (cosine similarity is 0-1)
    for (const result of vectorResults) {
      vectorScoreMap.set(result.skill.id, {
        skill: result.skill,
        score: result.similarityScore,
      })
    }

    // Merge results with combined scoring
    const allSkillIds = new Set([...ftsScoreMap.keys(), ...vectorScoreMap.keys()])
    const combinedResults: HybridSearchResult[] = []

    for (const skillId of allSkillIds) {
      const ftsData = ftsScoreMap.get(skillId)
      const vectorData = vectorScoreMap.get(skillId)

      const ftsScore = ftsData?.score ?? 0
      const vectorScore = vectorData?.score ?? 0

      // Weighted combination
      const combinedScore = ftsWeight * ftsScore + vectorWeight * vectorScore

      const skill = ftsData?.skill ?? vectorData?.skill
      if (!skill) continue

      combinedResults.push({
        skill,
        rank: combinedScore,
        highlights: ftsData?.highlights ?? {},
        ftsScore,
        vectorScore,
        combinedScore,
      })
    }

    // Sort by combined score descending
    combinedResults.sort((a, b) => b.combinedScore - a.combinedScore)

    // Apply pagination
    const paginatedItems = combinedResults.slice(offset, offset + limit)

    const result: PaginatedResults<HybridSearchResult> = {
      items: paginatedItems,
      total: combinedResults.length,
      limit,
      offset,
      hasMore: offset + paginatedItems.length < combinedResults.length,
    }

    // Cache the results
    this.cache.set(cacheKey, result, this.cacheTtl)

    return result
  }

  /**
   * Index a skill's embedding for vector search
   * Should be called when adding or updating skills
   */
  async indexSkillEmbedding(skill: Skill): Promise<void> {
    if (!this.embeddings) return

    await this.initializeEmbeddings()

    // Create text representation for embedding
    const text = [skill.name, skill.description, ...(skill.tags || [])].filter(Boolean).join(' ')

    const embedding = await this.embeddings.embed(text)
    this.embeddings.storeEmbedding(skill.id, embedding, text)
  }

  /**
   * Batch index embeddings for multiple skills
   */
  async indexSkillEmbeddingsBatch(skills: Skill[]): Promise<number> {
    if (!this.embeddings) return 0

    await this.initializeEmbeddings()

    return this.embeddings.precomputeEmbeddings(
      skills.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description ?? '',
      }))
    )
  }

  /**
   * Find semantically similar skills using vector embeddings
   * @param skillId - The source skill ID
   * @param limit - Maximum number of similar skills to return
   */
  async findSimilarByEmbedding(skillId: string, limit: number = 5): Promise<VectorSearchResult[]> {
    if (!this.embeddings) {
      // Fall back to FTS-based similarity
      return this.findSimilar(skillId, limit).map((r) => ({
        skill: r.skill,
        similarityScore: 1 / (1 + r.rank), // Convert rank to similarity-like score
      }))
    }

    await this.initializeEmbeddings()

    // Get the source skill's embedding
    const skillEmbedding = this.embeddings.getEmbedding(skillId)

    if (!skillEmbedding) {
      // If no embedding exists, fall back to FTS
      return this.findSimilar(skillId, limit).map((r) => ({
        skill: r.skill,
        similarityScore: 1 / (1 + r.rank),
      }))
    }

    // Find similar embeddings
    const similar = this.embeddings.findSimilar(skillEmbedding, limit + 1)

    // Fetch skill details, excluding the source skill
    const results: VectorSearchResult[] = []

    for (const { skillId: similarId, score } of similar) {
      if (similarId === skillId) continue // Skip source skill

      const skill = this.db.prepare('SELECT * FROM skills WHERE id = ?').get(similarId) as
        | FTSRow
        | undefined
      if (!skill) continue

      results.push({
        skill: this.rowToSkill(skill),
        similarityScore: score,
      })

      if (results.length >= limit) break
    }

    return results
  }

  /**
   * Close embedding service resources
   */
  closeEmbeddings(): void {
    this.embeddings?.close()
  }

  /**
   * Build FTS5 query with proper escaping
   */
  private buildFtsQuery(query: string): string {
    // Handle special FTS5 syntax
    if (
      query.includes('"') ||
      query.includes('AND') ||
      query.includes('OR') ||
      query.includes('NOT')
    ) {
      return query
    }

    // Split into tokens and escape each
    const tokens = query.trim().split(/\s+/).filter(Boolean)
    return tokens.map((t) => this.escapeFtsToken(t) + '*').join(' ')
  }

  /**
   * Escape a single FTS token
   */
  private escapeFtsToken(token: string): string {
    // Escape special characters
    return token.replace(/["-]/g, (match) => `"${match}"`)
  }

  /**
   * Build cache key from search options
   */
  private buildCacheKey(options: SearchOptions): string {
    return `search:${JSON.stringify(options)}`
  }

  /**
   * Build a search result with highlights
   */
  private buildSearchResult(row: FTSRow, query: string): SearchResult {
    const skill = this.rowToSkill(row)
    const highlights = this.buildHighlights(skill, query)

    return {
      skill,
      rank: Math.abs(row.rank), // BM25 returns negative values
      highlights,
    }
  }

  /**
   * Build highlighted snippets for matched terms
   */
  private buildHighlights(skill: Skill, query: string): SearchResult['highlights'] {
    const highlights: SearchResult['highlights'] = {}

    // Extract query terms (ignoring operators)
    const terms = query
      .replace(/["()]/g, '')
      .split(/\s+/)
      .filter((t) => !['AND', 'OR', 'NOT'].includes(t.toUpperCase()))
      .map((t) => t.replace(/\*$/, '').toLowerCase())

    // Build regex for matching
    if (terms.length === 0) return highlights

    const regex = new RegExp(
      `(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
      'gi'
    )

    // Highlight in name
    if (skill.name && regex.test(skill.name)) {
      highlights.name = skill.name.replace(regex, '<mark>$1</mark>')
    }

    // Highlight in description
    if (skill.description && regex.test(skill.description)) {
      // Find the first match and extract surrounding context
      const match = skill.description.match(regex)
      if (match) {
        const index = skill.description.toLowerCase().indexOf(match[0].toLowerCase())
        const start = Math.max(0, index - 50)
        const end = Math.min(skill.description.length, index + match[0].length + 50)

        let snippet = skill.description.slice(start, end)
        if (start > 0) snippet = '...' + snippet
        if (end < skill.description.length) snippet = snippet + '...'

        highlights.description = snippet.replace(regex, '<mark>$1</mark>')
      }
    }

    return highlights
  }

  /**
   * Convert database row to Skill object
   */
  private rowToSkill(row: FTSRow): Skill {
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
    }
  }
}
