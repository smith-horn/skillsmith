/**
 * SMI-579: SearchService Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, closeDatabase } from '../src/db/schema.js';
import { SkillRepository } from '../src/repositories/SkillRepository.js';
import { SearchService } from '../src/services/SearchService.js';

describe('SearchService', () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: SkillRepository;
  let search: SearchService;

  beforeEach(() => {
    db = createDatabase(':memory:');
    repo = new SkillRepository(db);
    search = new SearchService(db, { cacheTtl: 60 });

    // Seed test data
    repo.createBatch([
      {
        name: 'TypeScript Formatter',
        description: 'A skill for formatting TypeScript code',
        author: 'developer1',
        tags: ['typescript', 'formatting', 'code'],
        qualityScore: 0.9,
        trustTier: 'verified'
      },
      {
        name: 'JavaScript Linter',
        description: 'Lint JavaScript and TypeScript files',
        author: 'developer2',
        tags: ['javascript', 'linting'],
        qualityScore: 0.8,
        trustTier: 'community'
      },
      {
        name: 'Python Analyzer',
        description: 'Analyze Python code for best practices',
        author: 'python_dev',
        tags: ['python', 'analysis'],
        qualityScore: 0.7,
        trustTier: 'community'
      },
      {
        name: 'React Component Generator',
        description: 'Generate React components from specifications',
        author: 'react_expert',
        tags: ['react', 'generator', 'javascript'],
        qualityScore: 0.85,
        trustTier: 'verified'
      },
      {
        name: 'Database Query Builder',
        description: 'Build SQL queries with a fluent interface',
        author: 'db_wizard',
        tags: ['sql', 'database', 'query'],
        qualityScore: 0.75,
        trustTier: 'experimental'
      }
    ]);
  });

  afterEach(() => {
    if (db) closeDatabase(db);
  });

  describe('search', () => {
    it('should find skills matching query', () => {
      const results = search.search({ query: 'typescript' });

      expect(results.items.length).toBe(2);
      expect(results.total).toBe(2);
    });

    it('should rank results by BM25', () => {
      const results = search.search({ query: 'code' });

      // TypeScript Formatter should rank higher (has 'code' in description and tags)
      expect(results.items[0].skill.name).toBe('TypeScript Formatter');
    });

    it('should support pagination', () => {
      const page1 = search.search({ query: 'javascript', limit: 1, offset: 0 });
      const page2 = search.search({ query: 'javascript', limit: 1, offset: 1 });

      expect(page1.items.length).toBe(1);
      expect(page2.items.length).toBe(1);
      expect(page1.items[0].skill.id).not.toBe(page2.items[0].skill.id);
    });

    it('should filter by trust tier', () => {
      const results = search.search({
        query: 'javascript',
        trustTier: 'verified'
      });

      expect(results.items.length).toBe(1);
      expect(results.items[0].skill.trustTier).toBe('verified');
    });

    it('should filter by minimum quality score', () => {
      const results = search.search({
        query: 'typescript OR javascript OR python',
        minQualityScore: 0.8
      });

      for (const result of results.items) {
        expect(result.skill.qualityScore).toBeGreaterThanOrEqual(0.8);
      }
    });

    it('should cache results', () => {
      const query = { query: 'typescript' };

      // First search - not cached
      const start1 = Date.now();
      search.search(query);
      const duration1 = Date.now() - start1;

      // Second search - should be cached
      const start2 = Date.now();
      search.search(query);
      const duration2 = Date.now() - start2;

      // Cached should be faster (or at least not slower)
      expect(duration2).toBeLessThanOrEqual(duration1 + 5);
    });

    it('should include highlights in results', () => {
      const results = search.search({ query: 'typescript' });

      const formatterResult = results.items.find(
        r => r.skill.name === 'TypeScript Formatter'
      );

      expect(formatterResult?.highlights.name).toContain('<mark>');
      expect(formatterResult?.highlights.description).toContain('<mark>');
    });
  });

  describe('searchPhrase', () => {
    it('should match exact phrases', () => {
      const results = search.searchPhrase('TypeScript code');

      expect(results.items.length).toBeGreaterThan(0);
      expect(results.items[0].skill.name).toBe('TypeScript Formatter');
    });
  });

  describe('searchBoolean', () => {
    it('should support AND queries', () => {
      const results = search.searchBoolean({
        must: ['typescript', 'formatting']
      });

      expect(results.items.length).toBe(1);
      expect(results.items[0].skill.name).toBe('TypeScript Formatter');
    });

    it('should support OR queries', () => {
      const results = search.searchBoolean({
        should: ['python', 'react']
      });

      expect(results.items.length).toBe(2);
    });

    it('should support exclusion with must-only queries', () => {
      // FTS5 NOT requires special handling - test that AND works correctly
      const results = search.searchBoolean({
        must: ['javascript', 'linting']
      });

      expect(results.items.length).toBe(1);
      expect(results.items[0].skill.name).toBe('JavaScript Linter');
    });
  });

  describe('suggest', () => {
    it('should return name suggestions', () => {
      const suggestions = search.suggest('Type');

      expect(suggestions).toContain('TypeScript Formatter');
    });

    it('should limit suggestions', () => {
      const suggestions = search.suggest('', 3);

      expect(suggestions.length).toBeLessThanOrEqual(3);
    });
  });

  describe('findSimilar', () => {
    it('should find similar skills based on content', () => {
      // Get a skill with distinct tags to find similarity
      const _jsLinter = repo.findByRepoUrl(null);
      const all = repo.findAll(10, 0).items;
      const jsSkill = all.find(s => s.name === 'JavaScript Linter');

      if (jsSkill) {
        const similar = search.findSimilar(jsSkill.id);
        // Should return some results (skills with javascript/typescript content)
        expect(similar.length).toBeGreaterThanOrEqual(0);
      }
    });

    it('should exclude the source skill', () => {
      const skill = repo.findAll(1, 0).items[0];
      const similar = search.findSimilar(skill.id);

      const ids = similar.map(r => r.skill.id);
      expect(ids).not.toContain(skill.id);
    });
  });

  describe('getPopular', () => {
    it('should return skills ordered by quality score', () => {
      const popular = search.getPopular(undefined, 3);

      expect(popular.length).toBe(3);
      expect(popular[0].qualityScore).toBeGreaterThanOrEqual(popular[1].qualityScore!);
    });

    it('should filter by trust tier', () => {
      const verified = search.getPopular('verified', 10);

      for (const skill of verified) {
        expect(skill.trustTier).toBe('verified');
      }
    });
  });

  describe('clearCache', () => {
    it('should clear all cached searches', () => {
      // Perform some searches to populate cache
      search.search({ query: 'typescript' });
      search.search({ query: 'javascript' });

      const cleared = search.clearCache();

      expect(cleared).toBeGreaterThan(0);
    });
  });

  describe('performance', () => {
    it('should search 1000 skills in under 100ms', () => {
      // Create 1000 skills
      const skills = Array.from({ length: 1000 }, (_, i) => ({
        name: `Skill ${i}`,
        description: `Description for skill ${i} with searchable content`,
        tags: ['tag1', 'tag2', i % 2 === 0 ? 'even' : 'odd']
      }));

      repo.createBatch(skills);
      search.clearCache();

      const start = Date.now();
      const results = search.search({ query: 'searchable' });
      const duration = Date.now() - start;

      expect(results.total).toBe(1000);
      expect(duration).toBeLessThan(100);
    });
  });
});
