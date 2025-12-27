/**
 * SMI-578: CacheRepository - Cache storage for search results and API responses
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import type { CacheEntry } from '../types/skill.js';

interface CacheRow {
  key: string;
  value: string;
  expires_at: number | null;
  created_at: string;
}

/**
 * Repository for cache operations
 */
export class CacheRepository {
  private db: DatabaseType;
  private stmts!: {
    get: { get: (key: string) => CacheRow | undefined };
    set: { run: (...args: unknown[]) => { changes: number } };
    delete: { run: (key: string) => { changes: number } };
    deleteExpired: { run: () => { changes: number } };
    clear: { run: () => { changes: number } };
    count: { get: () => { count: number } };
    keys: { all: (pattern: string) => { key: string }[] };
  };

  constructor(db: DatabaseType) {
    this.db = db;
    this.prepareStatements();
  }

  private prepareStatements(): void {
    // Cast to our custom types for better-sqlite3 compatibility
    this.stmts = {
      get: this.db.prepare(`
        SELECT * FROM cache
        WHERE key = ? AND (expires_at IS NULL OR expires_at > unixepoch())
      `) as unknown as typeof this.stmts.get,

      set: this.db.prepare(`
        INSERT OR REPLACE INTO cache (key, value, expires_at, created_at)
        VALUES (?, ?, ?, datetime('now'))
      `) as unknown as typeof this.stmts.set,

      delete: this.db.prepare(`
        DELETE FROM cache WHERE key = ?
      `) as unknown as typeof this.stmts.delete,

      deleteExpired: this.db.prepare(`
        DELETE FROM cache WHERE expires_at IS NOT NULL AND expires_at <= unixepoch()
      `) as unknown as typeof this.stmts.deleteExpired,

      clear: this.db.prepare(`
        DELETE FROM cache
      `) as unknown as typeof this.stmts.clear,

      count: this.db.prepare(`
        SELECT COUNT(*) as count FROM cache
        WHERE expires_at IS NULL OR expires_at > unixepoch()
      `) as unknown as typeof this.stmts.count,

      keys: this.db.prepare(`
        SELECT key FROM cache
        WHERE (expires_at IS NULL OR expires_at > unixepoch())
        AND key LIKE ?
      `) as unknown as typeof this.stmts.keys
    };
  }

  private rowToEntry(row: CacheRow): CacheEntry {
    return {
      key: row.key,
      value: row.value,
      expiresAt: row.expires_at,
      createdAt: row.created_at
    };
  }

  /**
   * Get a cached value by key
   */
  get<T = unknown>(key: string): T | null {
    const row = this.stmts.get.get(key) as CacheRow | undefined;
    if (!row) return null;

    try {
      return JSON.parse(row.value) as T;
    } catch {
      return row.value as unknown as T;
    }
  }

  /**
   * Get raw cache entry with metadata
   */
  getEntry(key: string): CacheEntry | null {
    const row = this.stmts.get.get(key) as CacheRow | undefined;
    return row ? this.rowToEntry(row) : null;
  }

  /**
   * Set a cached value with optional TTL in seconds
   */
  set<T>(key: string, value: T, ttlSeconds?: number): void {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    const expiresAt = ttlSeconds ? Math.floor(Date.now() / 1000) + ttlSeconds : null;

    this.stmts.set.run(key, serialized, expiresAt);
  }

  /**
   * Delete a cached value
   */
  delete(key: string): boolean {
    const result = this.stmts.delete.run(key);
    return result.changes > 0;
  }

  /**
   * Delete all expired entries
   */
  deleteExpired(): number {
    const result = this.stmts.deleteExpired.run();
    return result.changes;
  }

  /**
   * Clear all cache entries
   */
  clear(): number {
    const result = this.stmts.clear.run();
    return result.changes;
  }

  /**
   * Check if a key exists (and is not expired)
   */
  has(key: string): boolean {
    return this.get(key) !== null;
  }

  /**
   * Count active cache entries
   */
  count(): number {
    const { count } = this.stmts.count.get() as { count: number };
    return count;
  }

  /**
   * Get all keys matching a pattern
   */
  keys(pattern: string = '%'): string[] {
    const rows = this.stmts.keys.all(pattern) as { key: string }[];
    return rows.map(row => row.key);
  }

  /**
   * Get or set a cached value
   */
  getOrSet<T>(key: string, factory: () => T, ttlSeconds?: number): T {
    const cached = this.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    const value = factory();
    this.set(key, value, ttlSeconds);
    return value;
  }

  /**
   * Get or set a cached value (async version)
   */
  async getOrSetAsync<T>(
    key: string,
    factory: () => Promise<T>,
    ttlSeconds?: number
  ): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    const value = await factory();
    this.set(key, value, ttlSeconds);
    return value;
  }
}
