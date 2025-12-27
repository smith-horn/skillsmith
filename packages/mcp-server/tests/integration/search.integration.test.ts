/**
 * SMI-616: Search Tool Integration Tests
 * Tests the search tool with a real SQLite database
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestDatabase,
  type TestDatabaseContext,
} from './setup.js';

describe('Search Tool Integration Tests', () => {
  let dbContext: TestDatabaseContext;

  beforeAll(async () => {
    dbContext = await createTestDatabase();
  });

  afterAll(async () => {
    await dbContext.cleanup();
  });

  describe('Basic Search Functionality', () => {
    it('should find skills by name', () => {
      const results = dbContext.searchService.search({
        query: 'commit',
        limit: 10,
        offset: 0,
      });

      expect(results.items.length).toBeGreaterThan(0);
      expect(results.items[0].skill.name).toBe('commit');
    });

    it('should find skills by description keywords', () => {
      const results = dbContext.searchService.search({
        query: 'docker',
        limit: 10,
        offset: 0,
      });

      expect(results.items.length).toBeGreaterThan(0);
      const skillNames = results.items.map(r => r.skill.name);
      expect(skillNames).toContain('docker-compose');
    });

    it('should return empty results for non-matching queries', () => {
      const results = dbContext.searchService.search({
        query: 'nonexistentskillxyz123',
        limit: 10,
        offset: 0,
      });

      expect(results.items.length).toBe(0);
      expect(results.total).toBe(0);
    });
  });

  describe('Search with Filters', () => {
    it('should filter by trust tier', () => {
      const results = dbContext.searchService.search({
        query: 'test react',
        limit: 10,
        offset: 0,
        trustTier: 'community',
      });

      for (const result of results.items) {
        expect(result.skill.trustTier).toBe('community');
      }
    });

    it('should filter by minimum quality score', () => {
      const results = dbContext.searchService.search({
        query: 'code',
        limit: 10,
        offset: 0,
        minQualityScore: 0.90,
      });

      for (const result of results.items) {
        expect(result.skill.qualityScore).toBeGreaterThanOrEqual(0.90);
      }
    });

    it('should combine multiple filters', () => {
      const results = dbContext.searchService.search({
        query: 'git',
        limit: 10,
        offset: 0,
        trustTier: 'verified',
        minQualityScore: 0.90,
      });

      for (const result of results.items) {
        expect(result.skill.trustTier).toBe('verified');
        expect(result.skill.qualityScore).toBeGreaterThanOrEqual(0.90);
      }
    });
  });

  describe('Pagination', () => {
    it('should return correct page size', () => {
      const results = dbContext.searchService.search({
        query: 'a',
        limit: 2,
        offset: 0,
      });

      expect(results.items.length).toBeLessThanOrEqual(2);
      expect(results.limit).toBe(2);
      expect(results.offset).toBe(0);
    });

    it('should support offset for pagination', () => {
      const page1 = dbContext.searchService.search({
        query: 'a',
        limit: 2,
        offset: 0,
      });

      const page2 = dbContext.searchService.search({
        query: 'a',
        limit: 2,
        offset: 2,
      });

      // If there are enough results, pages should be different
      if (page1.total > 2 && page2.items.length > 0) {
        const page1Ids = page1.items.map(r => r.skill.id);
        const page2Ids = page2.items.map(r => r.skill.id);
        expect(page1Ids).not.toEqual(page2Ids);
      }
    });

    it('should indicate hasMore correctly', () => {
      const results = dbContext.searchService.search({
        query: 'a',
        limit: 1,
        offset: 0,
      });

      if (results.total > 1) {
        expect(results.hasMore).toBe(true);
      }
    });
  });

  describe('BM25 Ranking', () => {
    it('should rank exact matches higher', () => {
      const results = dbContext.searchService.search({
        query: 'commit',
        limit: 10,
        offset: 0,
      });

      if (results.items.length > 1) {
        // First result should have the query term in the name
        expect(results.items[0].skill.name.toLowerCase()).toContain('commit');
      }
    });

    it('should provide relevance scores', () => {
      const results = dbContext.searchService.search({
        query: 'docker containers',
        limit: 10,
        offset: 0,
      });

      for (const result of results.items) {
        expect(typeof result.rank).toBe('number');
        expect(result.rank).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('Search by Tags', () => {
    it('should find skills by tag content', () => {
      const results = dbContext.searchService.search({
        query: 'jest',
        limit: 10,
        offset: 0,
      });

      expect(results.items.length).toBeGreaterThan(0);

      // At least one result should have jest in tags
      const hasJestTag = results.items.some(r =>
        r.skill.tags.some(tag => tag.toLowerCase().includes('jest'))
      );
      expect(hasJestTag).toBe(true);
    });
  });

  describe('Search by Author', () => {
    it('should find skills by author name', () => {
      const results = dbContext.searchService.search({
        query: 'anthropic',
        limit: 10,
        offset: 0,
      });

      expect(results.items.length).toBeGreaterThan(0);

      // Results should include skills by anthropic
      const hasAnthropicAuthor = results.items.some(r =>
        r.skill.author?.toLowerCase() === 'anthropic'
      );
      expect(hasAnthropicAuthor).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle special characters in query', () => {
      const results = dbContext.searchService.search({
        query: 'commit-message',
        limit: 10,
        offset: 0,
      });

      // Should not throw error
      expect(Array.isArray(results.items)).toBe(true);
    });

    it('should handle very long queries', () => {
      const longQuery = 'a'.repeat(100);
      const results = dbContext.searchService.search({
        query: longQuery,
        limit: 10,
        offset: 0,
      });

      // Should not throw error
      expect(Array.isArray(results.items)).toBe(true);
    });

    it('should handle queries with only whitespace', () => {
      // This might return all results or empty depending on implementation
      const results = dbContext.searchService.search({
        query: '   ',
        limit: 10,
        offset: 0,
      });

      expect(Array.isArray(results.items)).toBe(true);
    });
  });

  describe('Search Suggestions', () => {
    it('should provide autocomplete suggestions', () => {
      const suggestions = dbContext.searchService.suggest('com', 5);

      expect(Array.isArray(suggestions)).toBe(true);
      if (suggestions.length > 0) {
        expect(suggestions[0].toLowerCase()).toContain('com');
      }
    });

    it('should limit suggestions count', () => {
      const suggestions = dbContext.searchService.suggest('a', 3);

      expect(suggestions.length).toBeLessThanOrEqual(3);
    });
  });

  describe('Find Similar Skills', () => {
    it('should find skills similar to a given skill', () => {
      const similar = dbContext.searchService.findSimilar('anthropic/commit', 3);

      expect(Array.isArray(similar)).toBe(true);
      // Similar skills should not include the original
      const ids = similar.map(s => s.skill.id);
      expect(ids).not.toContain('anthropic/commit');
    });

    it('should return empty array for non-existent skill', () => {
      const similar = dbContext.searchService.findSimilar('nonexistent/skill', 3);

      expect(similar).toEqual([]);
    });
  });
});
