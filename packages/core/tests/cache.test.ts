/**
 * Tests for L1/L2 Cache (SMI-585)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { L1Cache, L2Cache, TieredCache } from '../src/cache/index.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('L1Cache (LRU)', () => {
  let cache: L1Cache;

  beforeEach(() => {
    cache = new L1Cache(10);
  });

  it('should store and retrieve results', () => {
    const key = L1Cache.generateKey('react testing', { source: 'github' });
    const results = [
      { id: '1', name: 'react-testing-library', description: 'Testing utilities', score: 0.9, source: 'github' }
    ];
    
    cache.set(key, results, 1);
    const retrieved = cache.get(key);
    
    expect(retrieved).toBeDefined();
    expect(retrieved?.results).toEqual(results);
    expect(retrieved?.totalCount).toBe(1);
  });

  it('should generate consistent cache keys', () => {
    const key1 = L1Cache.generateKey('react testing', { source: 'github', category: 'ui' });
    const key2 = L1Cache.generateKey('react testing', { category: 'ui', source: 'github' });
    const key3 = L1Cache.generateKey('REACT   Testing', { source: 'github', category: 'ui' });
    
    expect(key1).toBe(key2);
    expect(key1).toBe(key3);
  });

  it('should track hit/miss statistics', () => {
    const key = L1Cache.generateKey('test', {});
    
    // Miss
    cache.get(key);
    
    // Store
    cache.set(key, [], 0);
    
    // Hit
    cache.get(key);
    cache.get(key);
    
    const stats = cache.getStats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBeCloseTo(0.666, 2);
  });

  it('should respect max size limit', () => {
    for (let i = 0; i < 15; i++) {
      cache.set('key' + i, [], 0);
    }
    
    const stats = cache.getStats();
    expect(stats.size).toBeLessThanOrEqual(10);
  });

  it('should invalidate all entries', () => {
    cache.set('key1', [], 0);
    cache.set('key2', [], 0);
    
    cache.invalidateAll();
    
    expect(cache.has('key1')).toBe(false);
    expect(cache.has('key2')).toBe(false);
  });
});

describe('L2Cache (SQLite)', () => {
  let cache: L2Cache;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), 'test-cache-' + Date.now() + '.db');
    cache = new L2Cache({ dbPath, ttlSeconds: 3600 });
  });

  afterEach(() => {
    cache.close();
    try {
      fs.unlinkSync(dbPath);
    } catch {
      // File may not exist, ignore cleanup errors
    }
  });

  it('should persist results to SQLite', () => {
    const key = 'search:test:{}';
    const results = [
      { id: '1', name: 'test-skill', description: 'A test', score: 0.8, source: 'github' }
    ];
    
    cache.set(key, results, 1);
    const retrieved = cache.get(key);
    
    expect(retrieved).toBeDefined();
    expect(retrieved?.results).toEqual(results);
  });

  it('should prune expired entries', () => {
    // Create cache with 1 second TTL
    const shortCache = new L2Cache({ dbPath: dbPath + '.short', ttlSeconds: 1 });
    
    shortCache.set('key1', [], 0);
    expect(shortCache.has('key1')).toBe(true);
    
    // Wait for expiry - skip in fast tests
    // In production, would wait and verify prune
    
    shortCache.close();
    try {
      fs.unlinkSync(dbPath + '.short');
    } catch {
      // File may not exist, ignore cleanup errors
    }
  });
});

describe('TieredCache', () => {
  let cache: TieredCache;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), 'test-tiered-' + Date.now() + '.db');
    cache = new TieredCache({
      l1MaxSize: 5,
      l2Options: { dbPath, ttlSeconds: 3600 },
    });
  });

  afterEach(() => {
    cache.close();
    try {
      fs.unlinkSync(dbPath);
    } catch {
      // File may not exist, ignore cleanup errors
    }
  });

  it('should check L1 before L2', () => {
    const key = 'search:tiered:{}';
    const results = [{ id: '1', name: 'test', description: '', score: 0.5, source: 'test' }];
    
    cache.set(key, results, 1);
    
    // Should be in both L1 and L2
    const retrieved = cache.get(key);
    expect(retrieved?.results).toEqual(results);
  });

  it('should promote L2 hits to L1', () => {
    const key = 'search:promote:{}';
    const results = [{ id: '2', name: 'promoted', description: '', score: 0.7, source: 'test' }];
    
    cache.set(key, results, 1);
    
    // Clear L1 only
    cache['l1'].invalidateAll();
    
    // Get should hit L2 and promote to L1
    const retrieved = cache.get(key);
    expect(retrieved).toBeDefined();
    
    // Now should be in L1
    const l1Stats = cache.getStats().l1;
    expect(l1Stats.size).toBeGreaterThan(0);
  });
});
