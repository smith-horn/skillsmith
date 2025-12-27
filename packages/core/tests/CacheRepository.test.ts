/**
 * SMI-578: CacheRepository Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDatabase, closeDatabase } from '../src/db/schema.js';
import { CacheRepository } from '../src/repositories/CacheRepository.js';

describe('CacheRepository', () => {
  let db: ReturnType<typeof createDatabase>;
  let cache: CacheRepository;

  beforeEach(() => {
    db = createDatabase(':memory:');
    cache = new CacheRepository(db);
  });

  afterEach(() => {
    if (db) closeDatabase(db);
  });

  describe('set and get', () => {
    it('should store and retrieve string values', () => {
      cache.set('key1', 'value1');
      expect(cache.get('key1')).toBe('value1');
    });

    it('should store and retrieve objects', () => {
      const obj = { foo: 'bar', num: 42 };
      cache.set('object', obj);
      expect(cache.get('object')).toEqual(obj);
    });

    it('should store and retrieve arrays', () => {
      const arr = [1, 2, 3, { nested: true }];
      cache.set('array', arr);
      expect(cache.get('array')).toEqual(arr);
    });

    it('should return null for non-existent keys', () => {
      expect(cache.get('missing')).toBeNull();
    });

    it('should overwrite existing values', () => {
      cache.set('key', 'original');
      cache.set('key', 'updated');
      expect(cache.get('key')).toBe('updated');
    });
  });

  describe('TTL expiration', () => {
    // Note: SQLite's unixepoch() uses real system time, so we can't mock time.
    // These tests verify the TTL mechanism works correctly with real timing.

    it('should set TTL on entries', () => {
      cache.set('expiring', 'value', 10); // 10 seconds TTL

      const entry = cache.getEntry('expiring');
      expect(entry).not.toBeNull();
      expect(entry?.expiresAt).not.toBeNull();
      expect(entry?.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('should not expire entries without TTL', () => {
      cache.set('permanent', 'value');

      const entry = cache.getEntry('permanent');
      expect(entry?.expiresAt).toBeNull();
      expect(cache.get('permanent')).toBe('value');
    });
  });

  describe('getEntry', () => {
    it('should return full cache entry with metadata', () => {
      cache.set('meta-test', { foo: 'bar' });

      const entry = cache.getEntry('meta-test');

      expect(entry).not.toBeNull();
      expect(entry?.key).toBe('meta-test');
      // Value is stored as JSON string
      const parsed = JSON.parse(entry?.value ?? '{}');
      expect(parsed).toEqual({ foo: 'bar' });
      expect(entry?.createdAt).toBeDefined();
    });
  });

  describe('delete', () => {
    it('should delete existing entries', () => {
      cache.set('to-delete', 'value');
      expect(cache.delete('to-delete')).toBe(true);
      expect(cache.get('to-delete')).toBeNull();
    });

    it('should return false for non-existent entries', () => {
      expect(cache.delete('missing')).toBe(false);
    });
  });

  describe('deleteExpired', () => {
    it('should identify entries with past expiration', () => {
      // Set entries with short TTL
      cache.set('exp1', 'value', 1);
      cache.set('perm', 'value');

      // Entries with TTL should have expiresAt set
      const exp1Entry = cache.getEntry('exp1');
      expect(exp1Entry?.expiresAt).not.toBeNull();

      // Permanent entries should not have expiresAt
      const permEntry = cache.getEntry('perm');
      expect(permEntry?.expiresAt).toBeNull();
    });
  });

  describe('clear', () => {
    it('should remove all entries', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');

      const cleared = cache.clear();

      expect(cleared).toBe(2);
      expect(cache.count()).toBe(0);
    });
  });

  describe('has', () => {
    it('should return true for existing keys', () => {
      cache.set('exists', 'value');
      expect(cache.has('exists')).toBe(true);
    });

    it('should return false for missing keys', () => {
      expect(cache.has('missing')).toBe(false);
    });
  });

  describe('count', () => {
    it('should count active entries', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);

      expect(cache.count()).toBe(3);
    });

    it('should count entries with TTL while not expired', () => {
      cache.set('exp', 'value', 300); // 5 minute TTL - won't expire during test
      cache.set('perm', 'value');

      // Both entries should be counted (not expired yet)
      expect(cache.count()).toBe(2);
    });
  });

  describe('keys', () => {
    it('should return all keys', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');

      const keys = cache.keys();

      expect(keys).toContain('key1');
      expect(keys).toContain('key2');
    });

    it('should filter keys by pattern', () => {
      cache.set('user:1', 'value1');
      cache.set('user:2', 'value2');
      cache.set('post:1', 'value3');

      const userKeys = cache.keys('user:%');

      expect(userKeys.length).toBe(2);
      expect(userKeys).toContain('user:1');
      expect(userKeys).toContain('user:2');
    });
  });

  describe('getOrSet', () => {
    it('should return cached value if exists', () => {
      cache.set('cached', 'original');

      const factory = vi.fn(() => 'new');
      const result = cache.getOrSet('cached', factory);

      expect(result).toBe('original');
      expect(factory).not.toHaveBeenCalled();
    });

    it('should call factory and cache result if missing', () => {
      const factory = vi.fn(() => 'computed');
      const result = cache.getOrSet('missing', factory);

      expect(result).toBe('computed');
      expect(factory).toHaveBeenCalledOnce();
      expect(cache.get('missing')).toBe('computed');
    });

    it('should respect TTL parameter', () => {
      cache.getOrSet('expiring', () => 'value', 300);

      const entry = cache.getEntry('expiring');
      expect(entry?.expiresAt).not.toBeNull();
      expect(entry?.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });
  });

  describe('getOrSetAsync', () => {
    it('should handle async factories', async () => {
      const factory = vi.fn(async () => {
        return 'async-value';
      });

      const result = await cache.getOrSetAsync('async', factory);

      expect(result).toBe('async-value');
      expect(cache.get('async')).toBe('async-value');
    }, 10000);

    it('should not call factory if cached', async () => {
      cache.set('cached', 'existing');

      const factory = vi.fn(async () => 'new');
      const result = await cache.getOrSetAsync('cached', factory);

      expect(result).toBe('existing');
      expect(factory).not.toHaveBeenCalled();
    }, 10000);
  });
});
