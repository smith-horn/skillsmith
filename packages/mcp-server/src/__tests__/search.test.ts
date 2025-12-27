/**
 * Tests for SMI-581: MCP Search Tool
 */

import { describe, it, expect } from 'vitest';
import { executeSearch, formatSearchResults } from '../tools/search.js';
import { SkillsmithError } from '@skillsmith/core';

describe('Search Tool', () => {
  describe('executeSearch', () => {
    it('should return results for valid query', async () => {
      const result = await executeSearch({ query: 'commit' });

      expect(result.results).toBeDefined();
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.total).toBeGreaterThan(0);
      expect(result.query).toBe('commit');
      expect(result.timing.totalMs).toBeGreaterThanOrEqual(0);
    });

    it('should filter by category', async () => {
      const result = await executeSearch({
        query: 'test',
        category: 'testing',
      });

      result.results.forEach((skill) => {
        expect(skill.category).toBe('testing');
      });
    });

    it('should filter by trust tier', async () => {
      const result = await executeSearch({
        query: 'anthropic',
        trust_tier: 'verified',
      });

      result.results.forEach((skill) => {
        expect(skill.trustTier).toBe('verified');
      });
    });

    it('should filter by minimum score', async () => {
      const result = await executeSearch({
        query: 'commit',
        min_score: 90,
      });

      result.results.forEach((skill) => {
        expect(skill.score).toBeGreaterThanOrEqual(90);
      });
    });

    it('should sort results by score descending', async () => {
      const result = await executeSearch({ query: 'co' });

      for (let i = 1; i < result.results.length; i++) {
        expect(result.results[i - 1].score).toBeGreaterThanOrEqual(
          result.results[i].score
        );
      }
    });

    it('should limit results to 10', async () => {
      // Query must be at least 2 characters
      const result = await executeSearch({ query: 'co' });

      expect(result.results.length).toBeLessThanOrEqual(10);
    });

    it('should throw error for empty query', async () => {
      await expect(executeSearch({ query: '' })).rejects.toThrow(SkillsmithError);
    });

    it('should throw error for query less than 2 characters', async () => {
      await expect(executeSearch({ query: 'a' })).rejects.toThrow(SkillsmithError);
    });

    it('should throw error for invalid min_score', async () => {
      await expect(
        executeSearch({ query: 'test', min_score: 150 })
      ).rejects.toThrow(SkillsmithError);
    });
  });

  describe('formatSearchResults', () => {
    it('should format results for terminal display', async () => {
      const result = await executeSearch({ query: 'commit' });
      const formatted = formatSearchResults(result);

      expect(formatted).toContain('Search Results');
      expect(formatted).toContain('commit');
      expect(formatted).toContain('Score:');
      expect(formatted).toContain('ms');
    });

    it('should show helpful message when no results', async () => {
      const result = await executeSearch({ query: 'xyznonexistent123' });
      const formatted = formatSearchResults(result);

      expect(formatted).toContain('No skills found');
      expect(formatted).toContain('Suggestions:');
    });
  });
});
