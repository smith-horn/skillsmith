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

import type { Database as DatabaseType } from 'better-sqlite3';
import type {
  Skill,
  SearchOptions,
  SearchResult,
  PaginatedResults,
  TrustTier
} from '../types/skill.js';
import { CacheRepository } from '../repositories/CacheRepository.js';

interface FTSRow {
  id: string;
  name: string;
  description: string | null;
  author: string | null;
  repo_url: string | null;
  quality_score: number | null;
  trust_tier: string;
  tags: string;
  created_at: string;
  updated_at: string;
  rank: number;
}

/**
 * Full-text search service with BM25 ranking
 */
export class SearchService {
  private db: DatabaseType;
  private cache: CacheRepository;
  private cacheTtl: number;

  constructor(db: DatabaseType, options?: { cacheTtl?: number }) {
    this.db = db;
    this.cache = new CacheRepository(db);
    this.cacheTtl = options?.cacheTtl ?? 300; // 5 minutes default
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
      minQualityScore
    } = options;

    // Check cache first
    const cacheKey = this.buildCacheKey(options);
    const cached = this.cache.get<PaginatedResults<SearchResult>>(cacheKey);
    if (cached) {
      return cached;
    }

    // Build the FTS5 query
    const ftsQuery = this.buildFtsQuery(query);

    // Build filter conditions
    const filters: string[] = [];
    const params: (string | number)[] = [ftsQuery];

    if (trustTier) {
      filters.push('s.trust_tier = ?');
      params.push(trustTier);
    }

    if (minQualityScore !== undefined) {
      filters.push('s.quality_score >= ?');
      params.push(minQualityScore);
    }

    const whereClause = filters.length > 0 ? `AND ${filters.join(' AND ')}` : '';

    // Count total results
    const countSql = `
      SELECT COUNT(*) as total
      FROM skills s
      INNER JOIN skills_fts f ON s.rowid = f.rowid
      WHERE skills_fts MATCH ?
      ${whereClause}
    `;

    const { total } = this.db.prepare(countSql).get(...params) as { total: number };

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
    `;

    params.push(limit, offset);
    const rows = this.db.prepare(searchSql).all(...params) as FTSRow[];

    // Build results with highlights
    const items = rows.map(row => this.buildSearchResult(row, query));

    const result: PaginatedResults<SearchResult> = {
      items,
      total,
      limit,
      offset,
      hasMore: offset + items.length < total
    };

    // Cache the results
    this.cache.set(cacheKey, result, this.cacheTtl);

    return result;
  }

  /**
   * Search with phrase query support
   */
  searchPhrase(phrase: string, options?: Omit<SearchOptions, 'query'>): PaginatedResults<SearchResult> {
    // Wrap in quotes for exact phrase matching
    const query = `"${phrase.replace(/"/g, '""')}"`;
    return this.search({ ...options, query });
  }

  /**
   * Search with boolean operators (AND, OR, NOT)
   */
  searchBoolean(
    terms: { must?: string[]; should?: string[]; not?: string[] },
    options?: Omit<SearchOptions, 'query'>
  ): PaginatedResults<SearchResult> {
    const parts: string[] = [];

    if (terms.must?.length) {
      parts.push(terms.must.map(t => this.escapeFtsToken(t)).join(' AND '));
    }

    if (terms.should?.length) {
      parts.push(`(${terms.should.map(t => this.escapeFtsToken(t)).join(' OR ')})`);
    }

    if (terms.not?.length) {
      parts.push(terms.not.map(t => `NOT ${this.escapeFtsToken(t)}`).join(' AND '));
    }

    const query = parts.join(' AND ');
    return this.search({ ...options, query });
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
    `;

    const rows = this.db.prepare(sql).all(prefix, limit) as { name: string }[];
    return rows.map(row => row.name);
  }

  /**
   * Find similar skills based on a skill's content
   */
  findSimilar(skillId: string, limit: number = 5): SearchResult[] {
    const skill = this.db.prepare('SELECT * FROM skills WHERE id = ?').get(skillId) as FTSRow | undefined;
    if (!skill) return [];

    // Build a query from the skill's name and tags
    const tags = JSON.parse(skill.tags || '[]') as string[];
    const queryParts = [skill.name, ...tags].filter(Boolean);
    const query = queryParts.map(p => this.escapeFtsToken(p)).join(' OR ');

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
    `;

    const rows = this.db.prepare(sql).all(query, skillId, limit) as FTSRow[];
    return rows.map(row => this.buildSearchResult(row, skill.name));
  }

  /**
   * Get popular skills by trust tier
   */
  getPopular(trustTier?: TrustTier, limit: number = 10): Skill[] {
    let sql = `
      SELECT * FROM skills
      WHERE quality_score IS NOT NULL
    `;

    const params: (string | number)[] = [];

    if (trustTier) {
      sql += ' AND trust_tier = ?';
      params.push(trustTier);
    }

    sql += ' ORDER BY quality_score DESC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as FTSRow[];
    return rows.map(row => this.rowToSkill(row));
  }

  /**
   * Clear the search cache
   */
  clearCache(): number {
    return this.cache.clear();
  }

  /**
   * Build FTS5 query with proper escaping
   */
  private buildFtsQuery(query: string): string {
    // Handle special FTS5 syntax
    if (query.includes('"') || query.includes('AND') || query.includes('OR') || query.includes('NOT')) {
      return query;
    }

    // Split into tokens and escape each
    const tokens = query.trim().split(/\s+/).filter(Boolean);
    return tokens.map(t => this.escapeFtsToken(t) + '*').join(' ');
  }

  /**
   * Escape a single FTS token
   */
  private escapeFtsToken(token: string): string {
    // Escape special characters
    return token.replace(/["-]/g, match => `"${match}"`);
  }

  /**
   * Build cache key from search options
   */
  private buildCacheKey(options: SearchOptions): string {
    return `search:${JSON.stringify(options)}`;
  }

  /**
   * Build a search result with highlights
   */
  private buildSearchResult(row: FTSRow, query: string): SearchResult {
    const skill = this.rowToSkill(row);
    const highlights = this.buildHighlights(skill, query);

    return {
      skill,
      rank: Math.abs(row.rank), // BM25 returns negative values
      highlights
    };
  }

  /**
   * Build highlighted snippets for matched terms
   */
  private buildHighlights(skill: Skill, query: string): SearchResult['highlights'] {
    const highlights: SearchResult['highlights'] = {};

    // Extract query terms (ignoring operators)
    const terms = query
      .replace(/["()]/g, '')
      .split(/\s+/)
      .filter(t => !['AND', 'OR', 'NOT'].includes(t.toUpperCase()))
      .map(t => t.replace(/\*$/, '').toLowerCase());

    // Build regex for matching
    if (terms.length === 0) return highlights;

    const regex = new RegExp(`(${terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');

    // Highlight in name
    if (skill.name && regex.test(skill.name)) {
      highlights.name = skill.name.replace(regex, '<mark>$1</mark>');
    }

    // Highlight in description
    if (skill.description && regex.test(skill.description)) {
      // Find the first match and extract surrounding context
      const match = skill.description.match(regex);
      if (match) {
        const index = skill.description.toLowerCase().indexOf(match[0].toLowerCase());
        const start = Math.max(0, index - 50);
        const end = Math.min(skill.description.length, index + match[0].length + 50);

        let snippet = skill.description.slice(start, end);
        if (start > 0) snippet = '...' + snippet;
        if (end < skill.description.length) snippet = snippet + '...';

        highlights.description = snippet.replace(regex, '<mark>$1</mark>');
      }
    }

    return highlights;
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
      updatedAt: row.updated_at
    };
  }
}
