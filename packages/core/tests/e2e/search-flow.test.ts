/**
 * SMI-631: E2E Search Flow Tests
 * Full search workflow: query → rank → cache → return
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  createE2EContext,
  getExtendedSkillData,
  TEST_SKILLS,
  type E2ETestContext,
} from './setup.js';
import type { RankedResult } from '../../src/index.js';

describe('E2E Search Flow', () => {
  let ctx: E2ETestContext;

  beforeAll(async () => {
    ctx = await createE2EContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  describe('Full Search Workflow', () => {
    beforeEach(() => {
      ctx.searchService.clearCache();
    });

    it('should execute complete search → rank → return flow', () => {
      // Step 1: Execute search
      const searchResults = ctx.searchService.search({
        query: 'git commit',
        limit: 10,
        offset: 0,
      });

      expect(searchResults.items.length).toBeGreaterThan(0);

      // Step 2: Rank results with extended data
      const extendedData = getExtendedSkillData();
      const rankedResults = ctx.rankingService.rank(searchResults.items, extendedData);

      expect(rankedResults.length).toBeGreaterThan(0);
      expect(rankedResults[0].score).toBeGreaterThan(0);
      expect(rankedResults[0].breakdown).toBeDefined();

      // Step 3: Verify ranking order is preserved
      for (let i = 1; i < rankedResults.length; i++) {
        expect(rankedResults[i - 1].score).toBeGreaterThanOrEqual(rankedResults[i].score);
      }
    });

    it('should cache search results and return cached data on repeat query', () => {
      const query = { query: 'typescript', limit: 10, offset: 0 };

      // First search - should not be cached
      const result1 = ctx.searchService.search(query);
      expect(result1.items.length).toBeGreaterThan(0);

      // Second search - should be cached
      const result2 = ctx.searchService.search(query);
      expect(result2.items).toEqual(result1.items);
      expect(result2.total).toBe(result1.total);
    });

    it('should clear cache correctly', () => {
      const query = { query: 'react', limit: 10, offset: 0 };

      // Populate cache
      ctx.searchService.search(query);

      // Clear cache
      const clearedCount = ctx.searchService.clearCache();
      expect(clearedCount).toBeGreaterThanOrEqual(1);
    });

    it('should produce consistent results across multiple calls', () => {
      const query = { query: 'docker devops', limit: 10, offset: 0 };

      const results: ReturnType<typeof ctx.searchService.search>[] = [];
      for (let i = 0; i < 3; i++) {
        ctx.searchService.clearCache();
        results.push(ctx.searchService.search(query));
      }

      // All results should be identical
      for (let i = 1; i < results.length; i++) {
        const prev = results[i - 1]!;
        const curr = results[i]!;
        expect(curr.items.map(r => r.skill.id)).toEqual(prev.items.map(r => r.skill.id));
      }
    });
  });

  describe('Search with Ranking Integration', () => {
    it('should rank verified skills higher than unknown skills', () => {
      const searchResults = ctx.searchService.search({
        query: 'typescript helper development',
        limit: 10,
        offset: 0,
      });

      const extendedData = getExtendedSkillData();
      const rankedResults = ctx.rankingService.rank(searchResults.items, extendedData);

      // Find a verified skill and an unknown skill in results
      const verifiedResult = rankedResults.find(r => r.skill.trustTier === 'verified');
      const unknownResult = rankedResults.find(r => r.skill.trustTier === 'unknown');

      if (verifiedResult && unknownResult) {
        // The ranking score breakdown should reflect trust tier differences
        expect(verifiedResult.breakdown.trustTier).toBeGreaterThan(unknownResult.breakdown.trustTier);
      }
    });

    it('should boost results for exact name matches', () => {
      const searchResults = ctx.searchService.search({
        query: 'commit',
        limit: 10,
        offset: 0,
      });

      const extendedData = getExtendedSkillData();
      const rankedResults = ctx.rankingService.rank(searchResults.items, extendedData);
      const boostedResults = ctx.rankingService.applyBoost(rankedResults, 'commit');

      // First result should be the exact match
      expect(boostedResults[0].skill.name).toBe('commit');
    });

    it('should include popularity in ranking when extended data is provided', () => {
      const searchResults = ctx.searchService.search({
        query: 'code review',
        limit: 10,
        offset: 0,
      });

      const extendedData = getExtendedSkillData();
      const rankedResults = ctx.rankingService.rank(searchResults.items, extendedData);

      // At least one result should have a non-zero popularity score
      const hasPopularityScore = rankedResults.some(r => r.breakdown.popularity > 0);
      expect(hasPopularityScore).toBe(true);
    });

    it('should consider recency in ranking scores', () => {
      const searchResults = ctx.searchService.search({
        query: 'helper',
        limit: 10,
        offset: 0,
      });

      const extendedData = getExtendedSkillData();
      const rankedResults = ctx.rankingService.rank(searchResults.items, extendedData);

      // Recently updated skills should have higher recency scores
      for (const result of rankedResults) {
        expect(result.breakdown.recency).toBeGreaterThanOrEqual(0);
        expect(result.breakdown.recency).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('Pagination', () => {
    it('should return correct page size', () => {
      const results = ctx.searchService.search({
        query: 'a',
        limit: 3,
        offset: 0,
      });

      expect(results.items.length).toBeLessThanOrEqual(3);
      expect(results.limit).toBe(3);
      expect(results.offset).toBe(0);
    });

    it('should paginate through all results without duplicates', () => {
      const pageSize = 2;
      const allIds = new Set<string>();
      let offset = 0;
      let totalFetched = 0;

      // Fetch all pages
      while (true) {
        const page = ctx.searchService.search({
          query: 'a', // Broad query to get many results
          limit: pageSize,
          offset,
        });

        for (const item of page.items) {
          // Check for duplicates
          expect(allIds.has(item.skill.id)).toBe(false);
          allIds.add(item.skill.id);
        }

        totalFetched += page.items.length;

        if (!page.hasMore || page.items.length === 0) {
          break;
        }

        offset += pageSize;

        // Safety limit
        if (offset > 100) break;
      }

      expect(totalFetched).toBeGreaterThan(0);
    });

    it('should indicate hasMore correctly', () => {
      const smallPage = ctx.searchService.search({
        query: 'a',
        limit: 1,
        offset: 0,
      });

      if (smallPage.total > 1) {
        expect(smallPage.hasMore).toBe(true);
      }

      const largePage = ctx.searchService.search({
        query: 'a',
        limit: 100,
        offset: 0,
      });

      if (largePage.items.length === largePage.total) {
        expect(largePage.hasMore).toBe(false);
      }
    });
  });

  describe('Filter Combinations', () => {
    it('should combine query with trust tier filter', () => {
      const results = ctx.searchService.search({
        query: 'code',
        limit: 10,
        offset: 0,
        trustTier: 'verified',
      });

      for (const result of results.items) {
        expect(result.skill.trustTier).toBe('verified');
      }
    });

    it('should combine query with minimum quality score filter', () => {
      const results = ctx.searchService.search({
        query: 'test',
        limit: 10,
        offset: 0,
        minQualityScore: 0.85,
      });

      for (const result of results.items) {
        expect(result.skill.qualityScore).toBeGreaterThanOrEqual(0.85);
      }
    });

    it('should combine multiple filters simultaneously', () => {
      const results = ctx.searchService.search({
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

    it('should return empty results when filters eliminate all matches', () => {
      const results = ctx.searchService.search({
        query: 'nonexistent',
        limit: 10,
        offset: 0,
        trustTier: 'verified',
        minQualityScore: 0.99,
      });

      expect(results.items.length).toBe(0);
      expect(results.total).toBe(0);
    });
  });

  describe('Search Quality', () => {
    it('should rank exact name matches at top', () => {
      const results = ctx.searchService.search({
        query: 'commit',
        limit: 10,
        offset: 0,
      });

      expect(results.items.length).toBeGreaterThan(0);
      expect(results.items[0].skill.name).toBe('commit');
    });

    it('should find skills by description content', () => {
      const results = ctx.searchService.search({
        query: 'conventional commits specification',
        limit: 10,
        offset: 0,
      });

      expect(results.items.length).toBeGreaterThan(0);
      const matchingSkill = results.items.find(
        r => r.skill.description?.toLowerCase().includes('conventional commits')
      );
      expect(matchingSkill).toBeDefined();
    });

    it('should find skills by tag content', () => {
      const results = ctx.searchService.search({
        query: 'devops containers',
        limit: 10,
        offset: 0,
      });

      expect(results.items.length).toBeGreaterThan(0);
      const hasMatchingTags = results.items.some(
        r => r.skill.tags.some(tag =>
          tag.toLowerCase().includes('devops') ||
          tag.toLowerCase().includes('container')
        )
      );
      expect(hasMatchingTags).toBe(true);
    });

    it('should provide highlights in search results', () => {
      const results = ctx.searchService.search({
        query: 'typescript',
        limit: 10,
        offset: 0,
      });

      expect(results.items.length).toBeGreaterThan(0);
      const matchingResult = results.items.find(
        r => r.skill.name.toLowerCase().includes('typescript') ||
             r.skill.description?.toLowerCase().includes('typescript')
      );

      if (matchingResult) {
        expect(matchingResult.highlights).toBeDefined();
        const hasHighlight =
          matchingResult.highlights?.name?.includes('<mark>') ||
          matchingResult.highlights?.description?.includes('<mark>');
        expect(hasHighlight).toBe(true);
      }
    });
  });

  describe('Edge Cases', () => {
    it('should throw error for empty query', () => {
      // FTS5 cannot parse empty queries, so search should throw
      expect(() => ctx.searchService.search({
        query: '',
        limit: 10,
        offset: 0,
      })).toThrow();
    });

    it('should throw error for query with only special characters', () => {
      // FTS5 cannot parse special character-only queries
      expect(() => ctx.searchService.search({
        query: '!!!@@@###',
        limit: 10,
        offset: 0,
      })).toThrow();
    });

    it('should handle very long query string', () => {
      const longQuery = 'a'.repeat(500);
      const results = ctx.searchService.search({
        query: longQuery,
        limit: 10,
        offset: 0,
      });

      expect(Array.isArray(results.items)).toBe(true);
    });

    it('should handle query with unicode characters', () => {
      const results = ctx.searchService.search({
        query: '日本語 中文 한국어',
        limit: 10,
        offset: 0,
      });

      expect(Array.isArray(results.items)).toBe(true);
    });

    it('should handle offset beyond total results', () => {
      const results = ctx.searchService.search({
        query: 'commit',
        limit: 10,
        offset: 1000,
      });

      expect(results.items.length).toBe(0);
    });
  });

  describe('Autocomplete and Suggestions', () => {
    it('should provide autocomplete suggestions', () => {
      const suggestions = ctx.searchService.suggest('com', 5);

      expect(Array.isArray(suggestions)).toBe(true);
      if (suggestions.length > 0) {
        const hasMatchingSuggestion = suggestions.some(
          s => s.toLowerCase().startsWith('com')
        );
        expect(hasMatchingSuggestion).toBe(true);
      }
    });

    it('should limit suggestions to requested count', () => {
      const suggestions = ctx.searchService.suggest('a', 3);

      expect(suggestions.length).toBeLessThanOrEqual(3);
    });
  });

  describe('Similar Skills', () => {
    it('should find similar skills based on content', () => {
      const similar = ctx.searchService.findSimilar('anthropic/commit', 3);

      expect(Array.isArray(similar)).toBe(true);
      // Similar skills should not include the original
      const ids = similar.map(s => s.skill.id);
      expect(ids).not.toContain('anthropic/commit');
    });

    it('should return empty array for non-existent skill', () => {
      const similar = ctx.searchService.findSimilar('nonexistent/skill', 3);

      expect(similar).toEqual([]);
    });

    it('should find git-related skills as similar to commit skill', () => {
      const similar = ctx.searchService.findSimilar('anthropic/commit', 5);

      // review-pr is also a git skill, should be similar
      const hasGitRelated = similar.some(
        s => s.skill.tags.some(tag => tag.toLowerCase().includes('git'))
      );

      if (similar.length > 0) {
        expect(hasGitRelated).toBe(true);
      }
    });
  });

  describe('Performance', () => {
    it('should complete search in under 50ms for small dataset', () => {
      ctx.searchService.clearCache();

      const start = performance.now();
      ctx.searchService.search({
        query: 'typescript react',
        limit: 10,
        offset: 0,
      });
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(50);
    });

    it('should benefit from caching on repeat queries', () => {
      ctx.searchService.clearCache();

      const query = { query: 'docker compose', limit: 10, offset: 0 };

      // First query - uncached
      const start1 = performance.now();
      ctx.searchService.search(query);
      const duration1 = performance.now() - start1;

      // Second query - cached
      const start2 = performance.now();
      ctx.searchService.search(query);
      const duration2 = performance.now() - start2;

      // Cached should be faster (or at most slightly slower due to timing variance)
      expect(duration2).toBeLessThanOrEqual(duration1 + 5);
    });

    it('should rank results in under 10ms', () => {
      const searchResults = ctx.searchService.search({
        query: 'test',
        limit: 100,
        offset: 0,
      });

      const extendedData = getExtendedSkillData();

      const start = performance.now();
      ctx.rankingService.rank(searchResults.items, extendedData);
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(10);
    });
  });
});
