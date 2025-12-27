/**
 * SMI-585: L1 In-Memory LRU Cache
 * Fast in-memory cache for frequently accessed search results
 */

import { LRUCache } from 'lru-cache';

export interface SearchCacheEntry {
  results: SearchResult[];
  totalCount: number;
  timestamp: number;
}

export interface SearchResult {
  id: string;
  name: string;
  description: string;
  score: number;
  source: string;
}

export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  size: number;
  maxSize: number;
}

export class L1Cache {
  private cache: LRUCache<string, SearchCacheEntry>;
  private hits = 0;
  private misses = 0;

  constructor(maxSize: number = 100) {
    this.cache = new LRUCache<string, SearchCacheEntry>({
      max: maxSize,
      // Items expire after 5 minutes in L1
      ttl: 5 * 60 * 1000,
      updateAgeOnGet: true,
    });
  }

  /**
   * Generate cache key from query and filters
   */
  static generateKey(query: string, filters?: Record<string, unknown>): string {
    // Normalize query: lowercase, trim, collapse whitespace
    const normalizedQuery = query.toLowerCase().trim().replace(/\s+/g, ' ');
    
    // Sort and stringify filters for consistent keys
    const sortedFilters = filters
      ? JSON.stringify(Object.keys(filters).sort().reduce((acc, key) => {
          acc[key] = filters[key];
          return acc;
        }, {} as Record<string, unknown>))
      : '';
    
    return `search:${normalizedQuery}:${sortedFilters}`;
  }

  /**
   * Get cached search results
   */
  get(key: string): SearchCacheEntry | undefined {
    const entry = this.cache.get(key);
    
    if (entry) {
      this.hits++;
      return entry;
    }
    
    this.misses++;
    return undefined;
  }

  /**
   * Store search results in cache
   */
  set(key: string, results: SearchResult[], totalCount: number): void {
    this.cache.set(key, {
      results,
      totalCount,
      timestamp: Date.now(),
    });
  }

  /**
   * Check if key exists in cache
   */
  has(key: string): boolean {
    return this.cache.has(key);
  }

  /**
   * Delete specific cache entry
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Invalidate all search-related entries
   * Called when the skill index is updated
   */
  invalidateAll(): void {
    this.clear();
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      size: this.cache.size,
      maxSize: this.cache.max,
    };
  }

  /**
   * Prune expired entries
   */
  prune(): void {
    this.cache.purgeStale();
  }
}

export default L1Cache;
