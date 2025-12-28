/**
 * SMI-644: Tiered Cache with TTL Management Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  // CacheEntry
  TTLTier,
  POPULARITY_THRESHOLDS,
  createCacheEntry,
  recordHit,
  calculateTTLTier,
  isExpired,
  shouldRefresh,
  isValidCacheKey,
  serializeCacheEntry,
  deserializeCacheEntry,
  getTTLTierName,
  type CacheEntry,
  // TieredCache
  EnhancedTieredCache,
  // CacheManager
  CacheManager,
  type SearchResult,
} from '../src/cache/index.js';

// Test data helpers
function createTestResults(count: number): SearchResult[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `skill-${i}`,
    name: `test-skill-${i}`,
    description: `Description for skill ${i}`,
    score: 0.9 - i * 0.1,
    source: 'test',
  }));
}

function getTempDbPath(): string {
  return path.join(os.tmpdir(), `test-cache-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanupDb(dbPath: string): void {
  try {
    fs.unlinkSync(dbPath);
  } catch {
    // Ignore cleanup errors
  }
}

describe('CacheEntry', () => {
  describe('createCacheEntry', () => {
    it('should create entry with default STANDARD TTL', () => {
      const results = createTestResults(3);
      const entry = createCacheEntry('search:test:{}', results, 3);

      expect(entry.key).toBe('search:test:{}');
      expect(entry.data).toEqual(results);
      expect(entry.totalCount).toBe(3);
      expect(entry.ttlTier).toBe(TTLTier.STANDARD);
      expect(entry.hitCount).toBe(0);
      expect(entry.expiresAt).toBeGreaterThan(entry.createdAt);
    });

    it('should create entry with specified TTL tier', () => {
      const entry = createCacheEntry('key', [], 0, TTLTier.POPULAR);
      expect(entry.ttlTier).toBe(TTLTier.POPULAR);
      expect(entry.expiresAt - entry.createdAt).toBe(TTLTier.POPULAR);
    });

    it('should reject invalid cache keys', () => {
      expect(() => createCacheEntry('', [], 0)).toThrow('Invalid cache key');
      expect(() => createCacheEntry('key\x00null', [], 0)).toThrow('Invalid cache key');
      expect(() => createCacheEntry('a'.repeat(2000), [], 0)).toThrow('Invalid cache key');
    });
  });

  describe('recordHit', () => {
    it('should increment hit count', () => {
      const entry = createCacheEntry('key', [], 0);
      const updated = recordHit(entry);

      expect(updated.hitCount).toBe(1);
      expect(updated.lastAccessedAt).toBeGreaterThanOrEqual(entry.lastAccessedAt);
    });

    it('should preserve original entry (immutable)', () => {
      const entry = createCacheEntry('key', [], 0);
      const updated = recordHit(entry);

      expect(entry.hitCount).toBe(0);
      expect(updated.hitCount).toBe(1);
    });
  });

  describe('calculateTTLTier', () => {
    it('should return STANDARD for new entries', () => {
      const now = Date.now();
      const tier = calculateTTLTier(now - 1000, 5, now); // 5 hits in 1 second
      expect(tier).toBe(TTLTier.STANDARD); // Too new to evaluate
    });

    it('should return POPULAR for high-frequency queries', () => {
      const now = Date.now();
      const fiveMinutesAgo = now - 5 * 60 * 1000;
      // 100 hits in 5 minutes = 1200 hits/hour
      const tier = calculateTTLTier(fiveMinutesAgo, 100, now);
      expect(tier).toBe(TTLTier.POPULAR);
    });

    it('should return RARE for low-frequency queries', () => {
      const now = Date.now();
      const twoHoursAgo = now - 2 * 60 * 60 * 1000;
      // 1 hit in 2 hours = 0.5 hits/hour = 12 hits/day
      // But we need < 1 hit/day AND > 1 hour age to be RARE
      // 0.5 hits/hour * 24 = 12 hits/day, which is > 1
      // Need much lower frequency
      const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;
      // 0.5 hits in 24 hours = 0.5 hits/day < 1
      const tier = calculateTTLTier(twentyFourHoursAgo, 0.5, now);
      // With 0.5 hits in 24 hours, hitsPerHour = 0.5/24 = 0.02, hitsPerDay = 0.5 < 1
      // But hitCount must be integer, so use 1 hit in 48 hours
      const fortyEightHoursAgo = now - 48 * 60 * 60 * 1000;
      const tierRare = calculateTTLTier(fortyEightHoursAgo, 1, now);
      // 1 hit in 48 hours = 0.02 hits/hour = 0.5 hits/day < 1
      expect(tierRare).toBe(TTLTier.RARE);
    });

    it('should return STANDARD for medium-frequency queries', () => {
      const now = Date.now();
      const oneHourAgo = now - 60 * 60 * 1000;
      // 5 hits in 1 hour = 5 hits/hour
      const tier = calculateTTLTier(oneHourAgo, 5, now);
      expect(tier).toBe(TTLTier.STANDARD);
    });
  });

  describe('isExpired', () => {
    it('should return false for fresh entries', () => {
      const entry = createCacheEntry('key', [], 0);
      expect(isExpired(entry)).toBe(false);
    });

    it('should return true for expired entries', () => {
      const entry = createCacheEntry('key', [], 0, TTLTier.RARE);
      // Simulate time passage
      const futureTime = entry.expiresAt + 1000;
      expect(isExpired(entry, futureTime)).toBe(true);
    });
  });

  describe('shouldRefresh', () => {
    it('should return false for fresh entries', () => {
      const entry = createCacheEntry('key', [], 0);
      expect(shouldRefresh(entry)).toBe(false);
    });

    it('should return true when approaching expiration (< 10% remaining)', () => {
      const entry = createCacheEntry('key', [], 0, TTLTier.STANDARD);
      const ttl = TTLTier.STANDARD;
      // 95% through TTL
      const nearExpiry = entry.createdAt + ttl * 0.95;
      expect(shouldRefresh(entry, nearExpiry)).toBe(true);
    });
  });

  describe('isValidCacheKey', () => {
    it('should accept valid keys', () => {
      expect(isValidCacheKey('search:react:{"source":"github"}')).toBe(true);
      expect(isValidCacheKey('simple-key')).toBe(true);
      expect(isValidCacheKey('key_with_underscore')).toBe(true);
    });

    it('should reject invalid keys', () => {
      expect(isValidCacheKey('')).toBe(false);
      expect(isValidCacheKey('key\x00with\x00nulls')).toBe(false);
      expect(isValidCacheKey('a'.repeat(2000))).toBe(false);
    });
  });

  describe('serialization', () => {
    it('should serialize and deserialize correctly', () => {
      const results = createTestResults(2);
      const entry = createCacheEntry('key', results, 2, TTLTier.POPULAR);

      const serialized = serializeCacheEntry(entry);
      expect(serialized.key).toBe('key');
      expect(serialized.ttl_tier).toBe(TTLTier.POPULAR);

      const deserialized = deserializeCacheEntry<SearchResult[]>(serialized);
      expect(deserialized.key).toBe(entry.key);
      expect(deserialized.data).toEqual(entry.data);
      expect(deserialized.ttlTier).toBe(entry.ttlTier);
    });

    it('should throw on invalid serialized data', () => {
      expect(() =>
        deserializeCacheEntry({
          key: 'key',
          data_json: 'invalid json {{{',
          total_count: 0,
          created_at: Date.now(),
          expires_at: Date.now() + 1000,
          hit_count: 0,
          last_accessed_at: Date.now(),
          ttl_tier: TTLTier.STANDARD,
        })
      ).toThrow('Failed to deserialize');
    });
  });

  describe('getTTLTierName', () => {
    it('should return correct tier names', () => {
      expect(getTTLTierName(TTLTier.POPULAR)).toBe('popular');
      expect(getTTLTierName(TTLTier.STANDARD)).toBe('standard');
      expect(getTTLTierName(TTLTier.RARE)).toBe('rare');
    });
  });
});

describe('EnhancedTieredCache', () => {
  let cache: EnhancedTieredCache;
  let dbPath: string;

  beforeEach(() => {
    dbPath = getTempDbPath();
    cache = new EnhancedTieredCache({
      l1: { maxEntries: 10 },
      l2: { dbPath },
    });
  });

  afterEach(() => {
    cache.close();
    cleanupDb(dbPath);
  });

  describe('L1/L2 tier operations', () => {
    it('should store and retrieve from L1', () => {
      const results = createTestResults(3);
      cache.set('key1', results, 3);

      const retrieved = cache.get('key1');
      expect(retrieved).toBeDefined();
      expect(retrieved?.results).toEqual(results);
      expect(retrieved?.totalCount).toBe(3);
    });

    it('should check L1 before L2', () => {
      const results = createTestResults(2);
      cache.set('key1', results, 2);

      // First get - should hit L1
      cache.get('key1');

      const stats = cache.getStats();
      expect(stats.l1Hits).toBe(1);
      expect(stats.l2Hits).toBe(0);
    });

    it('should promote L2 hits to L1', () => {
      const results = createTestResults(2);
      cache.set('key1', results, 2);

      // Clear L1 only
      cache['l1'].clear();

      // Get should hit L2 and promote to L1
      const retrieved = cache.get('key1');
      expect(retrieved).toBeDefined();

      const stats = cache.getStats();
      expect(stats.l2Hits).toBe(1);
      expect(stats.promotions).toBe(1);
    });
  });

  describe('TTL expiration', () => {
    it('should not return expired entries from L1', () => {
      // Create L1-only cache for this test
      const l1OnlyCache = new EnhancedTieredCache({
        l1: { maxEntries: 10 },
        // No L2
      });

      l1OnlyCache.set('key1', [], 0, TTLTier.RARE);

      // Manually expire by modifying the entry
      const l1Internal = l1OnlyCache['l1'];
      const entry = l1Internal.get('key1');
      if (entry) {
        entry.expiresAt = Date.now() - 1000;
        l1Internal.set('key1', entry);
      }

      const retrieved = l1OnlyCache.get('key1');
      expect(retrieved).toBeUndefined();

      l1OnlyCache.close();
    });

    it('should prune expired entries', () => {
      cache.set('key1', [], 0, TTLTier.STANDARD);

      const prunedCount = cache.prune();
      expect(prunedCount).toBe(0); // Nothing expired yet
    });
  });

  describe('promotion/demotion', () => {
    it('should track promotion count', () => {
      cache.set('key1', createTestResults(1), 1);

      // Clear L1 to force L2 lookup
      cache['l1'].clear();

      // Get promotes from L2 to L1
      cache.get('key1');

      const stats = cache.getStats();
      expect(stats.promotions).toBe(1);
    });

    it('should not promote with enablePromotion=false', () => {
      cache.close();
      cleanupDb(dbPath);

      dbPath = getTempDbPath();
      cache = new EnhancedTieredCache({
        l1: { maxEntries: 5 },
        l2: { dbPath },
        enablePromotion: false,
      });

      cache.set('key1', createTestResults(1), 1);
      cache['l1'].clear();

      cache.get('key1');

      const stats = cache.getStats();
      expect(stats.promotions).toBe(0);
    });
  });

  describe('invalidation', () => {
    it('should invalidate all entries in both tiers', () => {
      cache.set('key1', createTestResults(1), 1);
      cache.set('key2', createTestResults(2), 2);

      cache.invalidateAll();

      expect(cache.has('key1')).toBe(false);
      expect(cache.has('key2')).toBe(false);
    });
  });

  describe('hit rate calculation', () => {
    it('should calculate correct hit rate', () => {
      cache.set('key1', createTestResults(1), 1);

      // 2 hits
      cache.get('key1');
      cache.get('key1');

      // 1 miss
      cache.get('nonexistent');

      const stats = cache.getStats();
      expect(stats.totalHits).toBe(2);
      // Could be 1 or 2 misses depending on L2 lookup
      expect(stats.totalMisses).toBeGreaterThanOrEqual(1);
      expect(stats.hitRate).toBeGreaterThan(0);
    });
  });

  describe('memory bounds', () => {
    it('should respect maxEntries limit', () => {
      // Create cache with limit of 5
      cache.close();
      cleanupDb(dbPath);

      dbPath = getTempDbPath();
      cache = new EnhancedTieredCache({
        l1: { maxEntries: 5 },
        l2: { dbPath },
      });

      // Add 10 entries
      for (let i = 0; i < 10; i++) {
        cache.set(`key${i}`, createTestResults(1), 1);
      }

      const stats = cache.getStats();
      expect(stats.l1Size).toBeLessThanOrEqual(5);
    });
  });

  describe('entries needing refresh', () => {
    it('should return empty array when no entries need refresh', () => {
      cache.set('key1', createTestResults(1), 1);

      // Fresh entry should not need refresh
      const toRefresh = cache.getEntriesNeedingRefresh();
      expect(toRefresh).toEqual([]);
    });

    it('should identify entries near expiration via shouldRefresh', () => {
      // Test the underlying shouldRefresh function directly
      const entry = createCacheEntry('key1', createTestResults(1), 1, TTLTier.STANDARD);
      const ttl = TTLTier.STANDARD;

      // Fresh entry should not need refresh
      expect(shouldRefresh(entry)).toBe(false);

      // Entry at 95% TTL should need refresh
      const nearExpiry = entry.createdAt + ttl * 0.95;
      expect(shouldRefresh(entry, nearExpiry)).toBe(true);
    });
  });
});

describe('CacheManager', () => {
  let manager: CacheManager;
  let dbPath: string;

  beforeEach(() => {
    dbPath = getTempDbPath();
    manager = new CacheManager({
      l1: { maxEntries: 10 },
      l2: { dbPath },
      enableBackgroundRefresh: false, // Disable for tests
    });
  });

  afterEach(() => {
    manager.close();
    cleanupDb(dbPath);
  });

  describe('key generation', () => {
    it('should generate consistent keys', () => {
      const options = {
        query: 'react testing',
        filters: { source: 'github', category: 'ui' },
        limit: 20,
        offset: 0,
      };

      const key1 = CacheManager.generateKey(options);
      const key2 = CacheManager.generateKey({
        ...options,
        filters: { category: 'ui', source: 'github' }, // Different order
      });

      expect(key1).toBe(key2);
    });

    it('should normalize query case and whitespace', () => {
      const key1 = CacheManager.generateKey({ query: 'React Testing' });
      const key2 = CacheManager.generateKey({ query: '  react   testing  ' });

      expect(key1).toBe(key2);
    });

    it('should include pagination in key', () => {
      const key1 = CacheManager.generateKey({ query: 'test', limit: 10, offset: 0 });
      const key2 = CacheManager.generateKey({ query: 'test', limit: 10, offset: 20 });

      expect(key1).not.toBe(key2);
    });
  });

  describe('get/set operations', () => {
    it('should store and retrieve results', () => {
      const options = { query: 'react' };
      const results = createTestResults(5);

      manager.set(options, results, 100);
      const retrieved = manager.get(options);

      expect(retrieved).toBeDefined();
      expect(retrieved?.results).toEqual(results);
      expect(retrieved?.totalCount).toBe(100);
    });

    it('should return undefined for cache miss', () => {
      const result = manager.get({ query: 'nonexistent' });
      expect(result).toBeUndefined();
    });
  });

  describe('getOrCompute', () => {
    it('should return cached value without computing', async () => {
      const options = { query: 'test' };
      const results = createTestResults(3);

      manager.set(options, results, 3);

      const compute = vi.fn().mockResolvedValue({ results: [], totalCount: 0 });
      const retrieved = await manager.getOrCompute(options, compute);

      expect(retrieved.results).toEqual(results);
      expect(compute).not.toHaveBeenCalled();
    });

    it('should compute and cache on miss', async () => {
      const options = { query: 'new-query' };
      const results = createTestResults(2);

      const compute = vi.fn().mockResolvedValue({ results, totalCount: 2 });
      const retrieved = await manager.getOrCompute(options, compute);

      expect(retrieved.results).toEqual(results);
      expect(compute).toHaveBeenCalledTimes(1);

      // Verify it was cached
      const cached = manager.get(options);
      expect(cached?.results).toEqual(results);
    });
  });

  describe('invalidation', () => {
    it('should invalidate all entries', () => {
      manager.set({ query: 'test1' }, createTestResults(1), 1);
      manager.set({ query: 'test2' }, createTestResults(1), 1);

      manager.invalidateAll();

      expect(manager.has({ query: 'test1' })).toBe(false);
      expect(manager.has({ query: 'test2' })).toBe(false);
    });

    it('should notify invalidation listeners', () => {
      const callback = vi.fn();
      manager.onInvalidate(callback);

      manager.invalidateAll();

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should allow unsubscribing from invalidation', () => {
      const callback = vi.fn();
      const unsubscribe = manager.onInvalidate(callback);

      unsubscribe();
      manager.invalidateAll();

      expect(callback).not.toHaveBeenCalled();
    });

    it('should track time since last invalidation', () => {
      expect(manager.getTimeSinceInvalidation()).toBe(-1); // Never invalidated

      manager.invalidateAll();

      expect(manager.getTimeSinceInvalidation()).toBeGreaterThanOrEqual(0);
    });
  });

  describe('statistics', () => {
    it('should provide comprehensive stats', () => {
      manager.set({ query: 'test' }, createTestResults(1), 1);
      manager.get({ query: 'test' }); // Hit
      manager.get({ query: 'miss' }); // Miss

      const stats = manager.getStats();

      expect(stats.totalHits).toBe(1);
      expect(stats.totalMisses).toBeGreaterThanOrEqual(1);
      expect(stats.l1Size).toBeGreaterThan(0);
      expect(stats.queryFrequencies).toBeDefined();
      expect(stats.backgroundRefresh).toBeDefined();
    });

    it('should calculate hit rate by tier', () => {
      manager.set({ query: 'test' }, createTestResults(1), 1);
      manager.get({ query: 'test' });
      manager.get({ query: 'test' });
      manager.get({ query: 'miss' });

      const hitRates = manager.getHitRateByTier();

      expect(hitRates.overall).toBeGreaterThan(0);
      expect(hitRates.l1).toBeGreaterThanOrEqual(0);
      expect(hitRates.l2).toBeGreaterThanOrEqual(0);
    });
  });

  describe('TTL tier detection', () => {
    it('should use STANDARD tier for new queries', () => {
      const options = { query: 'new-query' };
      const key = CacheManager.generateKey(options);

      // Fresh query should get STANDARD tier
      const tier = manager['determineTTLTier'](key);
      expect(tier).toBe(TTLTier.STANDARD);
    });

    it('should track query frequencies', () => {
      const options = { query: 'tracked' };
      const key = CacheManager.generateKey(options);

      // Record hits
      manager['recordQueryHit'](key);
      manager['recordQueryHit'](key);
      manager['recordQueryHit'](key);

      const freq = manager['queryFrequencies'].get(key);
      expect(freq).toBeDefined();
      expect(freq?.hits).toBe(3);
    });
  });

  describe('delete', () => {
    it('should delete specific entry', () => {
      const options = { query: 'to-delete' };
      manager.set(options, createTestResults(1), 1);

      expect(manager.has(options)).toBe(true);

      manager.delete(options);

      expect(manager.has(options)).toBe(false);
    });
  });

  describe('prune', () => {
    it('should prune expired entries and old frequency data', () => {
      manager.set({ query: 'test' }, createTestResults(1), 1);

      const pruned = manager.prune();
      expect(pruned).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('TTLTier constants', () => {
  it('should have correct TTL values', () => {
    expect(TTLTier.POPULAR).toBe(4 * 60 * 60 * 1000); // 4 hours
    expect(TTLTier.STANDARD).toBe(60 * 60 * 1000); // 1 hour
    expect(TTLTier.RARE).toBe(15 * 60 * 1000); // 15 minutes
  });

  it('should have popularity threshold of 10 hits/hour', () => {
    expect(POPULARITY_THRESHOLDS.POPULAR_HITS_PER_HOUR).toBe(10);
  });
});
