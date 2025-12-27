/**
 * SMI-585: Cache exports
 * Two-tier caching for search results
 */

export { L1Cache } from './lru.js';
export type { SearchCacheEntry, SearchResult, CacheStats } from './lru.js';

export { L2Cache } from './sqlite.js';
export type { L2CacheOptions } from './sqlite.js';

import { L1Cache, type SearchResult, type CacheStats } from './lru.js';
import { L2Cache, type L2CacheOptions } from './sqlite.js';

export interface TieredCacheOptions {
  l1MaxSize?: number;
  l2Options?: L2CacheOptions;
}

/**
 * Two-tier cache combining L1 (memory) and L2 (SQLite)
 */
export class TieredCache {
  private l1: L1Cache;
  private l2: L2Cache | null = null;

  constructor(options: TieredCacheOptions = {}) {
    this.l1 = new L1Cache(options.l1MaxSize ?? 100);
    
    if (options.l2Options) {
      this.l2 = new L2Cache(options.l2Options);
    }
  }

  /**
   * Get from cache, checking L1 first, then L2
   */
  get(key: string): { results: SearchResult[]; totalCount: number } | undefined {
    // Check L1 first
    const l1Entry = this.l1.get(key);
    if (l1Entry) {
      return { results: l1Entry.results, totalCount: l1Entry.totalCount };
    }
    
    // Check L2 if available
    if (this.l2) {
      const l2Entry = this.l2.get(key);
      if (l2Entry) {
        // Promote to L1
        this.l1.set(key, l2Entry.results, l2Entry.totalCount);
        return { results: l2Entry.results, totalCount: l2Entry.totalCount };
      }
    }
    
    return undefined;
  }

  /**
   * Store in both cache tiers
   */
  set(key: string, results: SearchResult[], totalCount: number): void {
    this.l1.set(key, results, totalCount);
    
    if (this.l2) {
      this.l2.set(key, results, totalCount);
    }
  }

  /**
   * Check if key exists in either tier
   */
  has(key: string): boolean {
    return this.l1.has(key) || (this.l2?.has(key) ?? false);
  }

  /**
   * Invalidate all caches (called when index updates)
   */
  invalidateAll(): void {
    this.l1.invalidateAll();
    this.l2?.invalidateAll();
  }

  /**
   * Get combined stats
   */
  getStats(): { l1: CacheStats; l2: CacheStats | null } {
    return {
      l1: this.l1.getStats(),
      l2: this.l2?.getStats() ?? null,
    };
  }

  /**
   * Prune expired entries
   */
  prune(): void {
    this.l1.prune();
    this.l2?.prune();
  }

  /**
   * Close L2 database
   */
  close(): void {
    this.l2?.close();
  }
}
