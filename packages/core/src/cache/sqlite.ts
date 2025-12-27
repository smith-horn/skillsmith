/**
 * SMI-585: L2 SQLite Persistent Cache
 * Persistent cache layer with configurable TTL
 */

import Database from 'better-sqlite3';
import type { SearchResult, SearchCacheEntry, CacheStats } from './lru.js';

export interface L2CacheOptions {
  dbPath: string;
  ttlSeconds?: number; // Default: 1 hour
}

export class L2Cache {
  private db: Database.Database;
  private readonly ttlSeconds: number;
  private hits = 0;
  private misses = 0;

  constructor(options: L2CacheOptions) {
    this.db = new Database(options.dbPath);
    this.ttlSeconds = options.ttlSeconds ?? 3600; // 1 hour default
    this.initTable();
  }

  private initTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS search_cache (
        cache_key TEXT PRIMARY KEY,
        results_json TEXT NOT NULL,
        total_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
    
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cache_expires 
      ON search_cache(expires_at)
    `);
  }

  /**
   * Get cached search results
   */
  get(key: string): SearchCacheEntry | undefined {
    const now = Math.floor(Date.now() / 1000);
    
    const stmt = this.db.prepare(`
      SELECT results_json, total_count, created_at
      FROM search_cache
      WHERE cache_key = ? AND expires_at > ?
    `);
    
    const row = stmt.get(key, now) as {
      results_json: string;
      total_count: number;
      created_at: number;
    } | undefined;
    
    if (row) {
      this.hits++;
      return {
        results: JSON.parse(row.results_json) as SearchResult[],
        totalCount: row.total_count,
        timestamp: row.created_at * 1000,
      };
    }
    
    this.misses++;
    return undefined;
  }

  /**
   * Store search results in cache
   */
  set(key: string, results: SearchResult[], totalCount: number): void {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + this.ttlSeconds;
    
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO search_cache 
      (cache_key, results_json, total_count, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    stmt.run(key, JSON.stringify(results), totalCount, now, expiresAt);
  }

  /**
   * Check if key exists and is not expired
   */
  has(key: string): boolean {
    const now = Math.floor(Date.now() / 1000);
    
    const stmt = this.db.prepare(`
      SELECT 1 FROM search_cache
      WHERE cache_key = ? AND expires_at > ?
    `);
    
    return stmt.get(key, now) !== undefined;
  }

  /**
   * Delete specific cache entry
   */
  delete(key: string): boolean {
    const stmt = this.db.prepare(`
      DELETE FROM search_cache WHERE cache_key = ?
    `);
    
    const result = stmt.run(key);
    return result.changes > 0;
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.db.exec('DELETE FROM search_cache');
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Invalidate all entries (called when index updates)
   */
  invalidateAll(): void {
    this.clear();
  }

  /**
   * Remove expired entries
   */
  prune(): number {
    const now = Math.floor(Date.now() / 1000);
    
    const stmt = this.db.prepare(`
      DELETE FROM search_cache WHERE expires_at <= ?
    `);
    
    const result = stmt.run(now);
    return result.changes;
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats & { expiredCount: number } {
    const total = this.hits + this.misses;
    const now = Math.floor(Date.now() / 1000);
    
    const countStmt = this.db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN expires_at <= ? THEN 1 ELSE 0 END) as expired
      FROM search_cache
    `);
    
    const counts = countStmt.get(now) as { total: number; expired: number };
    
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      size: counts.total - counts.expired,
      maxSize: Infinity, // No limit for L2
      expiredCount: counts.expired,
    };
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}

export default L2Cache;
