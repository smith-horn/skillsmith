/**
 * SMI-644: Enhanced Tiered Cache with TTL Management
 * L1 (memory) + L2 (SQLite) with automatic promotion/demotion
 */

import { LRUCache } from 'lru-cache';
import Database from 'better-sqlite3';
import type { SearchResult } from './lru.js';
import {
  type CacheEntry,
  type SerializedCacheEntry,
  TTLTier,
  createCacheEntry,
  recordHit,
  isExpired,
  shouldRefresh,
  serializeCacheEntry,
  deserializeCacheEntry,
  isValidCacheKey,
} from './CacheEntry.js';

/** L1 cache configuration */
export interface L1Config {
  maxEntries?: number;      // Maximum entries (default: 1000)
  maxMemoryBytes?: number;  // Maximum memory in bytes (default: 100MB)
}

/** L2 cache configuration */
export interface L2Config {
  dbPath: string;           // Path to SQLite database
  pruneIntervalMs?: number; // Prune interval in ms (default: 5 minutes)
}

/** Combined tiered cache configuration */
export interface TieredCacheConfig {
  l1?: L1Config;
  l2?: L2Config;
  enablePromotion?: boolean; // Enable automatic tier promotion (default: true)
  enableDemotion?: boolean;  // Enable automatic tier demotion (default: true)
}

/** Cache statistics */
export interface TieredCacheStats {
  l1Hits: number;       l1Misses: number;
  l2Hits: number;       l2Misses: number;
  totalHits: number;    totalMisses: number;
  hitRate: number;      l1Size: number;       l2Size: number;
  promotions: number;   demotions: number;    evictions: number;
  popularEntries: number; rareEntries: number;
}

/**
 * Entry size estimator for memory bounds
 */
function estimateEntrySize(entry: CacheEntry): number {
  // Rough estimation: key + JSON data + overhead
  const keySize = entry.key.length * 2; // UTF-16
  const dataSize = JSON.stringify(entry.data).length * 2;
  const overhead = 200; // Object overhead + metadata
  return keySize + dataSize + overhead;
}

/**
 * Resolved cache configuration
 */
interface ResolvedCacheConfig {
  l1: Required<L1Config>;
  l2?: L2Config;
  enablePromotion: boolean;
  enableDemotion: boolean;
}

/**
 * Enhanced two-tier cache with TTL management
 */
export class EnhancedTieredCache {
  private l1: LRUCache<string, CacheEntry>;
  private db: Database.Database | null = null;
  private readonly config: ResolvedCacheConfig;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  // Statistics
  private stats = {
    l1Hits: 0,
    l1Misses: 0,
    l2Hits: 0,
    l2Misses: 0,
    promotions: 0,
    demotions: 0,
    evictions: 0,
  };

  // Prepared statements for L2
  private stmts: {
    get: Database.Statement<[string, number]>;
    set: Database.Statement<unknown[]>;
    has: Database.Statement<[string, number]>;
    delete: Database.Statement<[string]>;
    prune: Database.Statement<[number]>;
    count: Database.Statement<[number]>;
    updateHit: Database.Statement<[number, number, number, string]>;
    countByTier: Database.Statement<[number, number]>;
  } | null = null;

  constructor(config: TieredCacheConfig = {}) {
    const l1MaxEntries = config.l1?.maxEntries ?? 1000;
    const l1MaxMemoryBytes = config.l1?.maxMemoryBytes ?? 100 * 1024 * 1024; // 100MB

    this.config = {
      l1: {
        maxEntries: l1MaxEntries,
        maxMemoryBytes: l1MaxMemoryBytes,
      },
      l2: config.l2 ?? undefined,
      enablePromotion: config.enablePromotion ?? true,
      enableDemotion: config.enableDemotion ?? true,
    };

    // Initialize L1 with memory-bounded LRU
    this.l1 = new LRUCache<string, CacheEntry>({
      max: l1MaxEntries,
      maxSize: l1MaxMemoryBytes,
      sizeCalculation: estimateEntrySize,
      dispose: (entry, key) => {
        // On L1 eviction, demote to L2 if popular enough
        if (this.config.enableDemotion && this.db && !isExpired(entry)) {
          this.demoteToL2(key, entry);
        }
        this.stats.evictions++;
      },
    });

    // Initialize L2 if configured
    if (config.l2?.dbPath) {
      this.initL2(config.l2.dbPath);

      // Set up periodic pruning (unref to not block process exit)
      const pruneInterval = config.l2.pruneIntervalMs ?? 5 * 60 * 1000;
      this.pruneTimer = setInterval(() => this.prune(), pruneInterval);
      this.pruneTimer.unref();
    }
  }

  private initL2(dbPath: string): void {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('cache_size = -16000'); // 16MB cache

    // Create table with enhanced schema for TTL management
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache_entries (
        key TEXT PRIMARY KEY,
        data_json TEXT NOT NULL,
        total_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at INTEGER NOT NULL,
        ttl_tier INTEGER NOT NULL
      )
    `);

    // Index for expiration pruning
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cache_expires
      ON cache_entries(expires_at)
    `);

    // Index for TTL tier queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cache_tier
      ON cache_entries(ttl_tier)
    `);

    // Prepare statements
    this.stmts = {
      get: this.db.prepare(`
        SELECT key, data_json, total_count, created_at, expires_at,
               hit_count, last_accessed_at, ttl_tier
        FROM cache_entries
        WHERE key = ? AND expires_at > ?
      `),
      set: this.db.prepare(`
        INSERT OR REPLACE INTO cache_entries
        (key, data_json, total_count, created_at, expires_at,
         hit_count, last_accessed_at, ttl_tier)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
      has: this.db.prepare(`
        SELECT 1 FROM cache_entries
        WHERE key = ? AND expires_at > ?
      `),
      delete: this.db.prepare(`
        DELETE FROM cache_entries WHERE key = ?
      `),
      prune: this.db.prepare(`
        DELETE FROM cache_entries WHERE expires_at <= ?
      `),
      count: this.db.prepare(`
        SELECT COUNT(*) as count FROM cache_entries
        WHERE expires_at > ?
      `),
      updateHit: this.db.prepare(`
        UPDATE cache_entries
        SET hit_count = ?, last_accessed_at = ?, ttl_tier = ?
        WHERE key = ?
      `),
      countByTier: this.db.prepare(`
        SELECT COUNT(*) as count FROM cache_entries
        WHERE ttl_tier = ? AND expires_at > ?
      `),
    };
  }

  /**
   * Get entry from cache (L1 first, then L2)
   */
  get(key: string): { results: SearchResult[]; totalCount: number } | undefined {
    if (!isValidCacheKey(key)) {
      return undefined;
    }

    const now = Date.now();

    // Check L1 first
    const l1Entry = this.l1.get(key);
    if (l1Entry) {
      if (isExpired(l1Entry, now)) {
        this.l1.delete(key);
        this.stats.l1Misses++;
      } else {
        this.stats.l1Hits++;
        // Update hit count
        const updated = recordHit(l1Entry);
        this.l1.set(key, updated);
        return { results: updated.data as SearchResult[], totalCount: updated.totalCount };
      }
    } else {
      this.stats.l1Misses++;
    }

    // Check L2 if available
    if (this.db && this.stmts) {
      const row = this.stmts.get.get(key, now) as SerializedCacheEntry | undefined;
      if (row) {
        this.stats.l2Hits++;
        try {
          const entry = deserializeCacheEntry<SearchResult[]>(row);
          const updated = recordHit(entry);

          // Update L2 hit stats
          this.stmts.updateHit.run(
            updated.hitCount,
            updated.lastAccessedAt,
            updated.ttlTier,
            key
          );

          // Promote to L1
          if (this.config.enablePromotion) {
            this.l1.set(key, updated);
            this.stats.promotions++;
          }

          return { results: updated.data, totalCount: updated.totalCount };
        } catch {
          // Corrupted entry, remove it
          this.stmts.delete.run(key);
        }
      } else {
        this.stats.l2Misses++;
      }
    }

    return undefined;
  }

  /**
   * Store entry in cache
   */
  set(
    key: string,
    results: SearchResult[],
    totalCount: number,
    ttlTier: TTLTier = TTLTier.STANDARD
  ): void {
    if (!isValidCacheKey(key)) {
      throw new Error('Invalid cache key');
    }

    const entry = createCacheEntry(key, results, totalCount, ttlTier);

    // Store in L1
    this.l1.set(key, entry);

    // Store in L2 if available
    if (this.db && this.stmts) {
      const serialized = serializeCacheEntry(entry);
      this.stmts.set.run(
        serialized.key,
        serialized.data_json,
        serialized.total_count,
        serialized.created_at,
        serialized.expires_at,
        serialized.hit_count,
        serialized.last_accessed_at,
        serialized.ttl_tier
      );
    }
  }

  /**
   * Check if key exists in cache
   */
  has(key: string): boolean {
    if (!isValidCacheKey(key)) {
      return false;
    }

    const now = Date.now();

    // Check L1
    const l1Entry = this.l1.get(key);
    if (l1Entry && !isExpired(l1Entry, now)) {
      return true;
    }

    // Check L2
    if (this.db && this.stmts) {
      return this.stmts.has.get(key, now) !== undefined;
    }

    return false;
  }

  /**
   * Delete specific entry
   */
  delete(key: string): boolean {
    let deleted = false;

    if (this.l1.has(key)) {
      this.l1.delete(key);
      deleted = true;
    }

    if (this.db && this.stmts) {
      const result = this.stmts.delete.run(key);
      if (result.changes > 0) {
        deleted = true;
      }
    }

    return deleted;
  }

  /**
   * Invalidate all entries (called on index update)
   */
  invalidateAll(): void {
    this.l1.clear();
    if (this.db) {
      this.db.exec('DELETE FROM cache_entries');
    }
  }

  /**
   * Prune expired entries
   */
  prune(): number {
    const now = Date.now();
    let pruned = 0;

    // L1 handles its own expiration via TTL
    // Just trigger a check
    this.l1.purgeStale();

    // Prune L2
    if (this.db && this.stmts) {
      const result = this.stmts.prune.run(now);
      pruned = result.changes;
    }

    return pruned;
  }

  /**
   * Get entries that need background refresh
   */
  getEntriesNeedingRefresh(): string[] {
    const now = Date.now();
    const keys: string[] = [];

    // Check L1 entries
    for (const [key, entry] of this.l1.entries()) {
      if (shouldRefresh(entry, now)) {
        keys.push(key);
      }
    }

    return keys;
  }

  /**
   * Get cache statistics
   */
  getStats(): TieredCacheStats {
    const totalHits = this.stats.l1Hits + this.stats.l2Hits;
    const totalMisses = this.stats.l1Misses + this.stats.l2Misses;
    const total = totalHits + totalMisses;

    let l2Size = 0;
    let popularEntries = 0;
    let rareEntries = 0;

    if (this.db && this.stmts) {
      try {
        const now = Date.now();
        const countResult = this.stmts.count.get(now) as { count: number } | undefined;
        l2Size = countResult?.count ?? 0;

        const popularResult = this.stmts.countByTier.get(TTLTier.POPULAR, now) as { count: number } | undefined;
        popularEntries = popularResult?.count ?? 0;

        const rareResult = this.stmts.countByTier.get(TTLTier.RARE, now) as { count: number } | undefined;
        rareEntries = rareResult?.count ?? 0;
      } catch {
        // Database may be corrupted or closed, return zeros for L2 stats
      }
    }

    return {
      l1Hits: this.stats.l1Hits,
      l1Misses: this.stats.l1Misses,
      l2Hits: this.stats.l2Hits,
      l2Misses: this.stats.l2Misses,
      totalHits,
      totalMisses,
      hitRate: total > 0 ? totalHits / total : 0,
      l1Size: this.l1.size,
      l2Size,
      promotions: this.stats.promotions,
      demotions: this.stats.demotions,
      evictions: this.stats.evictions,
      popularEntries,
      rareEntries,
    };
  }

  /**
   * Demote entry from L1 to L2
   */
  private demoteToL2(key: string, entry: CacheEntry): void {
    if (!this.db || !this.stmts) return;

    // Only demote if entry is still valuable (not rare)
    if (entry.ttlTier !== TTLTier.RARE) {
      const serialized = serializeCacheEntry(entry);
      this.stmts.set.run(
        serialized.key,
        serialized.data_json,
        serialized.total_count,
        serialized.created_at,
        serialized.expires_at,
        serialized.hit_count,
        serialized.last_accessed_at,
        serialized.ttl_tier
      );
      this.stats.demotions++;
    }
  }

  /**
   * Close cache and cleanup resources
   */
  close(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    if (this.db) {
      this.db.close();
      this.db = null;
      this.stmts = null;
    }
  }
}
