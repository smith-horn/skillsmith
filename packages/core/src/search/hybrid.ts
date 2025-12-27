/**
 * SMI-584: Hybrid Search with Semantic Embeddings
 * Combines FTS5 keyword search with vector similarity using RRF
 */

import Database from 'better-sqlite3';
import { EmbeddingService } from '../embeddings/index.js';
import { TieredCache, L1Cache, type SearchResult } from '../cache/index.js';

export interface HybridSearchOptions {
  dbPath: string;
  cachePath?: string;
  k?: number; // RRF parameter, default 60
  ftsWeight?: number; // Weight for FTS5 results (0-1)
  semanticWeight?: number; // Weight for semantic results (0-1)
}

export interface SearchQuery {
  query: string;
  limit?: number;
  offset?: number;
  filters?: {
    source?: string;
    category?: string;
    minQuality?: number;
  };
}

export interface SearchResponse {
  results: SearchResult[];
  totalCount: number;
  cached: boolean;
  searchTimeMs: number;
}

/**
 * Reciprocal Rank Fusion (RRF) for combining search results
 */
function reciprocalRankFusion(
  rankings: Array<Map<string, number>>,
  k: number = 60
): Map<string, number> {
  const fusedScores = new Map<string, number>();
  
  for (const ranking of rankings) {
    // Convert to array and sort by score descending
    const sorted = Array.from(ranking.entries()).sort((a, b) => b[1] - a[1]);
    
    // Apply RRF formula: score = sum(1 / (k + rank))
    sorted.forEach((entry, rank) => {
      const [id, _] = entry;
      const currentScore = fusedScores.get(id) ?? 0;
      fusedScores.set(id, currentScore + 1 / (k + rank + 1));
    });
  }
  
  return fusedScores;
}

export class HybridSearch {
  private db: Database.Database;
  private embeddings: EmbeddingService;
  private cache: TieredCache;
  private readonly k: number;
  private readonly ftsWeight: number;
  private readonly semanticWeight: number;

  constructor(options: HybridSearchOptions) {
    this.db = new Database(options.dbPath);
    this.embeddings = new EmbeddingService(options.dbPath);
    this.k = options.k ?? 60;
    this.ftsWeight = options.ftsWeight ?? 0.5;
    this.semanticWeight = options.semanticWeight ?? 0.5;
    
    this.cache = new TieredCache({
      l1MaxSize: 100,
      l2Options: options.cachePath ? {
        dbPath: options.cachePath,
        ttlSeconds: 3600,
      } : undefined,
    });
    
    this.initFTS();
  }

  private initFTS(): void {
    // Create skills table if not exists
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        source TEXT,
        category TEXT,
        quality_score REAL DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch())
      )
    `);
    
    // Create FTS5 virtual table for full-text search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
        name,
        description,
        content='skills',
        content_rowid='rowid'
      )
    `);
    
    // Triggers to keep FTS in sync
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS skills_ai AFTER INSERT ON skills BEGIN
        INSERT INTO skills_fts(rowid, name, description) 
        VALUES (new.rowid, new.name, new.description);
      END
    `);
    
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS skills_ad AFTER DELETE ON skills BEGIN
        INSERT INTO skills_fts(skills_fts, rowid, name, description) 
        VALUES('delete', old.rowid, old.name, old.description);
      END
    `);
    
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS skills_au AFTER UPDATE ON skills BEGIN
        INSERT INTO skills_fts(skills_fts, rowid, name, description) 
        VALUES('delete', old.rowid, old.name, old.description);
        INSERT INTO skills_fts(rowid, name, description) 
        VALUES (new.rowid, new.name, new.description);
      END
    `);
  }

  /**
   * FTS5 keyword search
   */
  private ftsSearch(query: string, limit: number): Map<string, number> {
    const results = new Map<string, number>();
    
    // Escape special FTS5 characters and create search query
    const escaped = query.replace(/[*"]/g, '').trim();
    if (!escaped) return results;
    
    // Use prefix matching for better results
    const ftsQuery = escaped.split(/\s+/)
      .filter(term => term.length > 0)
      .map(term => `"${term}"*`)
      .join(' OR ');
    
    if (!ftsQuery) return results;
    
    try {
      const stmt = this.db.prepare(`
        SELECT s.id, bm25(skills_fts) as score
        FROM skills_fts f
        JOIN skills s ON f.rowid = s.rowid
        WHERE skills_fts MATCH ?
        ORDER BY score
        LIMIT ?
      `);
      
      const rows = stmt.all(ftsQuery, limit * 2) as Array<{ id: string; score: number }>;
      
      for (const row of rows) {
        // BM25 returns negative scores, convert to positive
        results.set(row.id, -row.score);
      }
    } catch (e) {
      // FTS query might fail on invalid input, return empty
      console.error('FTS search error:', e);
    }
    
    return results;
  }

  /**
   * Semantic similarity search using embeddings
   */
  private async semanticSearch(query: string, limit: number): Promise<Map<string, number>> {
    const results = new Map<string, number>();
    
    try {
      // Generate embedding for query
      const queryEmbedding = await this.embeddings.embed(query);
      
      // Find similar skills
      const similar = this.embeddings.findSimilar(queryEmbedding, limit * 2);
      
      for (const { skillId, score } of similar) {
        results.set(skillId, score);
      }
    } catch (e) {
      console.error('Semantic search error:', e);
    }
    
    return results;
  }

  /**
   * Main hybrid search combining FTS5 and semantic search
   */
  async search(query: SearchQuery): Promise<SearchResponse> {
    const startTime = performance.now();
    const { query: searchText, limit = 20, offset = 0, filters } = query;
    
    // Generate cache key
    const cacheKey = L1Cache.generateKey(searchText, filters);
    
    // Check cache first
    const cached = this.cache.get(cacheKey);
    if (cached) {
      const endTime = performance.now();
      return {
        results: cached.results.slice(offset, offset + limit),
        totalCount: cached.totalCount,
        cached: true,
        searchTimeMs: endTime - startTime,
      };
    }
    
    // Run FTS and semantic search in parallel
    const [ftsResults, semanticResults] = await Promise.all([
      Promise.resolve(this.ftsSearch(searchText, limit * 3)),
      this.semanticSearch(searchText, limit * 3),
    ]);
    
    // Apply RRF fusion with weights
    const weightedFts = new Map<string, number>();
    const weightedSemantic = new Map<string, number>();
    
    for (const [id, score] of ftsResults) {
      weightedFts.set(id, score * this.ftsWeight);
    }
    
    for (const [id, score] of semanticResults) {
      weightedSemantic.set(id, score * this.semanticWeight);
    }
    
    const fusedScores = reciprocalRankFusion([weightedFts, weightedSemantic], this.k);
    
    // Sort by fused score
    const sortedIds = Array.from(fusedScores.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
    
    // Fetch skill details
    const results: SearchResult[] = [];
    
    if (sortedIds.length > 0) {
      const placeholders = sortedIds.map(() => '?').join(',');
      let sql = `
        SELECT id, name, description, source
        FROM skills
        WHERE id IN (${placeholders})
      `;
      
      const params: (string | number)[] = [...sortedIds];
      
      // Apply filters
      if (filters?.source) {
        sql += ' AND source = ?';
        params.push(filters.source);
      }
      if (filters?.category) {
        sql += ' AND category = ?';
        params.push(filters.category);
      }
      if (filters?.minQuality !== undefined) {
        sql += ' AND quality_score >= ?';
        params.push(filters.minQuality);
      }
      
      const stmt = this.db.prepare(sql);
      const rows = stmt.all(...params) as Array<{
        id: string;
        name: string;
        description: string;
        source: string;
      }>;
      
      // Map to results maintaining fusion order
      const rowMap = new Map(rows.map(r => [r.id, r]));
      
      for (const id of sortedIds) {
        const row = rowMap.get(id);
        if (row) {
          results.push({
            id: row.id,
            name: row.name,
            description: row.description || '',
            score: fusedScores.get(id) ?? 0,
            source: row.source,
          });
        }
      }
    }
    
    // Cache all results (before pagination)
    this.cache.set(cacheKey, results, results.length);
    
    const endTime = performance.now();
    
    return {
      results: results.slice(offset, offset + limit),
      totalCount: results.length,
      cached: false,
      searchTimeMs: endTime - startTime,
    };
  }

  /**
   * Index a skill for searching
   */
  async indexSkill(skill: {
    id: string;
    name: string;
    description: string;
    source?: string;
    category?: string;
    qualityScore?: number;
  }): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO skills (id, name, description, source, category, quality_score)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      skill.id,
      skill.name,
      skill.description,
      skill.source ?? 'unknown',
      skill.category ?? 'general',
      skill.qualityScore ?? 0
    );
    
    // Generate and store embedding
    const text = `${skill.name} ${skill.description}`;
    const embedding = await this.embeddings.embed(text);
    this.embeddings.storeEmbedding(skill.id, embedding, text);
    
    // Invalidate cache
    this.cache.invalidateAll();
  }

  /**
   * Bulk index skills
   */
  async bulkIndex(skills: Array<{
    id: string;
    name: string;
    description: string;
    source?: string;
    category?: string;
    qualityScore?: number;
  }>): Promise<number> {
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO skills (id, name, description, source, category, quality_score)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    const insertMany = this.db.transaction((items: typeof skills) => {
      for (const skill of items) {
        insert.run(
          skill.id,
          skill.name,
          skill.description,
          skill.source ?? 'unknown',
          skill.category ?? 'general',
          skill.qualityScore ?? 0
        );
      }
      return items.length;
    });
    
    const count = insertMany(skills);
    
    // Precompute embeddings
    await this.embeddings.precomputeEmbeddings(
      skills.map(s => ({ id: s.id, name: s.name, description: s.description }))
    );
    
    // Invalidate cache
    this.cache.invalidateAll();
    
    return count;
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return this.cache.getStats();
  }

  /**
   * Close all connections
   */
  close(): void {
    this.embeddings.close();
    this.cache.close();
    this.db.close();
  }
}

export default HybridSearch;
