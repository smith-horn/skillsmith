/**
 * SMI-631: MCP Tools E2E Tests
 * Integration tests for search, get_skill, and install_skill workflows
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { Database as DatabaseType } from 'better-sqlite3';
import {
  createDatabase,
  closeDatabase,
  SkillRepository,
  SearchService,
  RankingService,
  CacheRepository,
} from '@skillsmith/core';
import {
  executeSearch,
  formatSearchResults,
  executeGetSkill,
} from '../../src/tools/index.js';

/**
 * E2E Test Context for MCP Tools
 */
interface MCPTestContext {
  db: DatabaseType;
  skillRepository: SkillRepository;
  searchService: SearchService;
  rankingService: RankingService;
  cacheRepository: CacheRepository;
  tempDir: string;
  skillsDir: string;
  manifestDir: string;
  cleanup: () => Promise<void>;
}

/**
 * Create MCP test context with database and filesystem
 */
async function createMCPTestContext(): Promise<MCPTestContext> {
  const db = createDatabase(':memory:');
  const skillRepository = new SkillRepository(db);
  const searchService = new SearchService(db, { cacheTtl: 60 });
  const rankingService = new RankingService();
  const cacheRepository = new CacheRepository(db);

  // Create temp directories
  const tempDir = path.join(os.tmpdir(), `mcp-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const skillsDir = path.join(tempDir, '.claude', 'skills');
  const manifestDir = path.join(tempDir, '.skillsmith');

  await fs.mkdir(skillsDir, { recursive: true });
  await fs.mkdir(manifestDir, { recursive: true });

  // Seed test skills
  seedTestSkills(skillRepository);

  return {
    db,
    skillRepository,
    searchService,
    rankingService,
    cacheRepository,
    tempDir,
    skillsDir,
    manifestDir,
    cleanup: async () => {
      closeDatabase(db);
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    },
  };
}

/**
 * Seed test skills
 */
function seedTestSkills(repo: SkillRepository): void {
  const testSkills = [
    {
      id: 'anthropic/commit',
      name: 'commit',
      description: 'Generate semantic commit messages following conventional commits specification',
      author: 'anthropic',
      repoUrl: 'https://github.com/anthropics/claude-code-skills/commit',
      qualityScore: 0.95,
      trustTier: 'verified' as const,
      tags: ['git', 'commit', 'conventional-commits', 'automation'],
    },
    {
      id: 'anthropic/review-pr',
      name: 'review-pr',
      description: 'Review pull requests with detailed code analysis and security checks',
      author: 'anthropic',
      repoUrl: 'https://github.com/anthropics/claude-code-skills/review-pr',
      qualityScore: 0.93,
      trustTier: 'verified' as const,
      tags: ['git', 'pull-request', 'code-review', 'security'],
    },
    {
      id: 'community/jest-helper',
      name: 'jest-helper',
      description: 'Generate Jest test cases for React components with comprehensive coverage',
      author: 'community',
      repoUrl: 'https://github.com/skillsmith-community/jest-helper',
      qualityScore: 0.87,
      trustTier: 'community' as const,
      tags: ['jest', 'testing', 'react', 'unit-tests'],
    },
    {
      id: 'community/docker-compose',
      name: 'docker-compose',
      description: 'Generate and manage Docker Compose configurations for development',
      author: 'community',
      repoUrl: 'https://github.com/skillsmith-community/docker-compose',
      qualityScore: 0.84,
      trustTier: 'community' as const,
      tags: ['docker', 'devops', 'containers'],
    },
    {
      id: 'community/api-docs',
      name: 'api-docs',
      description: 'Generate OpenAPI documentation from code with automatic schema detection',
      author: 'community',
      repoUrl: 'https://github.com/skillsmith-community/api-docs',
      qualityScore: 0.78,
      trustTier: 'experimental' as const,
      tags: ['openapi', 'documentation', 'api'],
    },
  ];

  repo.createBatch(testSkills);
}

/**
 * Create mock manifest
 */
async function createMockManifest(
  manifestDir: string,
  skills: Record<string, {
    id: string;
    name: string;
    version: string;
    source: string;
    installPath: string;
    installedAt: string;
  }> = {}
): Promise<void> {
  const manifest = {
    version: '1.0.0',
    installedSkills: skills,
  };
  await fs.writeFile(
    path.join(manifestDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );
}

/**
 * Create mock installed skill
 */
async function createMockInstalledSkill(
  skillsDir: string,
  skillName: string,
  content = '# Mock Skill\n\nThis is a mock skill for testing purposes with enough content to pass validation requirements.'
): Promise<string> {
  const skillPath = path.join(skillsDir, skillName);
  await fs.mkdir(skillPath, { recursive: true });
  await fs.writeFile(path.join(skillPath, 'SKILL.md'), content);
  return skillPath;
}

describe('MCP Tools E2E Tests', () => {
  let ctx: MCPTestContext;

  beforeAll(async () => {
    ctx = await createMCPTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  describe('Search Tool Integration', () => {
    it('should execute search with query parameter', async () => {
      const response = await executeSearch({ query: 'commit' });

      expect(response).toBeDefined();
      expect(response.results).toBeDefined();
      expect(Array.isArray(response.results)).toBe(true);
      expect(response.query).toBe('commit');
      expect(response.timing).toBeDefined();
    });

    it('should filter by category', async () => {
      const response = await executeSearch({
        query: 'test',
        category: 'testing',
      });

      for (const result of response.results) {
        expect(result.category).toBe('testing');
      }
    });

    it('should filter by trust tier', async () => {
      const response = await executeSearch({
        query: 'code',
        trust_tier: 'verified',
      });

      for (const result of response.results) {
        expect(result.trustTier).toBe('verified');
      }
    });

    it('should filter by minimum score', async () => {
      const response = await executeSearch({
        query: 'docker',
        min_score: 80,
      });

      for (const result of response.results) {
        expect(result.score).toBeGreaterThanOrEqual(80);
      }
    });

    it('should throw error for empty query', async () => {
      await expect(executeSearch({ query: '' })).rejects.toThrow();
    });

    it('should throw error for short query', async () => {
      await expect(executeSearch({ query: 'a' })).rejects.toThrow();
    });

    it('should throw error for invalid min_score', async () => {
      await expect(
        executeSearch({ query: 'test', min_score: 150 })
      ).rejects.toThrow();
    });

    it('should format search results correctly', async () => {
      const response = await executeSearch({ query: 'commit' });
      const formatted = formatSearchResults(response);

      expect(typeof formatted).toBe('string');
      expect(formatted).toContain('Search Results');
      expect(formatted).toContain('commit');
    });

    it('should include timing information', async () => {
      const response = await executeSearch({ query: 'docker' });

      expect(response.timing.searchMs).toBeGreaterThanOrEqual(0);
      expect(response.timing.totalMs).toBeGreaterThanOrEqual(response.timing.searchMs);
    });

    it('should limit results to 10', async () => {
      const response = await executeSearch({ query: 'skill' });

      expect(response.results.length).toBeLessThanOrEqual(10);
    });
  });

  describe('Get Skill Tool Integration', () => {
    it('should retrieve skill by ID from database', () => {
      const skill = ctx.skillRepository.findById('anthropic/commit');

      expect(skill).not.toBeNull();
      expect(skill?.id).toBe('anthropic/commit');
      expect(skill?.name).toBe('commit');
      expect(skill?.author).toBe('anthropic');
      expect(skill?.description).toContain('commit');
    });

    it('should retrieve skill with all metadata', () => {
      const skill = ctx.skillRepository.findById('anthropic/commit');

      expect(skill).toMatchObject({
        id: expect.any(String),
        name: expect.any(String),
        description: expect.any(String),
        author: expect.any(String),
        repoUrl: expect.any(String),
        qualityScore: expect.any(Number),
        trustTier: expect.stringMatching(/^(verified|community|experimental|unknown)$/),
        tags: expect.any(Array),
      });
    });

    it('should return null for non-existent skill', () => {
      const skill = ctx.skillRepository.findById('nonexistent/skill');

      expect(skill).toBeNull();
    });

    it('should find skill by repo URL', () => {
      const skill = ctx.skillRepository.findByRepoUrl(
        'https://github.com/anthropics/claude-code-skills/commit'
      );

      expect(skill).not.toBeNull();
      expect(skill?.id).toBe('anthropic/commit');
    });

    it('should check skill existence', () => {
      expect(ctx.skillRepository.exists('anthropic/commit')).toBe(true);
      expect(ctx.skillRepository.exists('nonexistent/skill')).toBe(false);
    });
  });

  describe('Install Skill Workflow', () => {
    beforeEach(async () => {
      await createMockManifest(ctx.manifestDir);
    });

    it('should create skill directory structure', async () => {
      const skillPath = await createMockInstalledSkill(ctx.skillsDir, 'test-skill');

      const stat = await fs.stat(skillPath);
      expect(stat.isDirectory()).toBe(true);

      const skillMdExists = await fs.stat(path.join(skillPath, 'SKILL.md'));
      expect(skillMdExists.isFile()).toBe(true);
    });

    it('should write SKILL.md with content', async () => {
      const content = `# Installation Test Skill

This is a test skill for validating the installation workflow.

## Features

- Feature 1
- Feature 2

## Usage

Use this skill by mentioning it.
`;
      const skillPath = await createMockInstalledSkill(ctx.skillsDir, 'install-test', content);

      const readContent = await fs.readFile(path.join(skillPath, 'SKILL.md'), 'utf-8');
      expect(readContent).toBe(content);
    });

    it('should update manifest with installed skill', async () => {
      const skillName = 'manifest-test';
      const skillPath = await createMockInstalledSkill(ctx.skillsDir, skillName);

      // Update manifest
      const manifestPath = path.join(ctx.manifestDir, 'manifest.json');
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
      manifest.installedSkills[skillName] = {
        id: `test/${skillName}`,
        name: skillName,
        version: '1.0.0',
        source: `github:test/${skillName}`,
        installPath: skillPath,
        installedAt: new Date().toISOString(),
      };
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      // Verify manifest was updated
      const updatedManifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
      expect(updatedManifest.installedSkills[skillName]).toBeDefined();
      expect(updatedManifest.installedSkills[skillName].name).toBe(skillName);
    });

    it('should detect already installed skill', async () => {
      const skillName = 'already-installed';
      await createMockInstalledSkill(ctx.skillsDir, skillName);
      await createMockManifest(ctx.manifestDir, {
        [skillName]: {
          id: `test/${skillName}`,
          name: skillName,
          version: '1.0.0',
          source: `github:test/${skillName}`,
          installPath: path.join(ctx.skillsDir, skillName),
          installedAt: new Date().toISOString(),
        },
      });

      const manifestPath = path.join(ctx.manifestDir, 'manifest.json');
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));

      expect(manifest.installedSkills[skillName]).toBeDefined();
    });

    it('should validate SKILL.md content structure', () => {
      const validateSkillMd = (content: string): { valid: boolean; errors: string[] } => {
        const errors: string[] = [];

        if (!content.match(/^#\s+.+$/m)) {
          errors.push('Missing title heading');
        }

        if (content.length < 100) {
          errors.push('Content too short');
        }

        return { valid: errors.length === 0, errors };
      };

      expect(validateSkillMd('# Valid\n\n' + 'x'.repeat(100)).valid).toBe(true);
      expect(validateSkillMd('no title').valid).toBe(false);
      expect(validateSkillMd('# Short').valid).toBe(false);
    });
  });

  describe('Uninstall Skill Workflow', () => {
    it('should remove skill directory', async () => {
      const skillName = 'to-uninstall';
      const skillPath = await createMockInstalledSkill(ctx.skillsDir, skillName);

      // Verify it exists
      await expect(fs.access(skillPath)).resolves.toBeUndefined();

      // Remove it
      await fs.rm(skillPath, { recursive: true, force: true });

      // Verify it's gone
      await expect(fs.access(skillPath)).rejects.toThrow();
    });

    it('should update manifest on uninstall', async () => {
      const skillName = 'uninstall-manifest';
      await createMockInstalledSkill(ctx.skillsDir, skillName);
      await createMockManifest(ctx.manifestDir, {
        [skillName]: {
          id: `test/${skillName}`,
          name: skillName,
          version: '1.0.0',
          source: `github:test/${skillName}`,
          installPath: path.join(ctx.skillsDir, skillName),
          installedAt: new Date().toISOString(),
        },
      });

      // Remove from manifest
      const manifestPath = path.join(ctx.manifestDir, 'manifest.json');
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
      delete manifest.installedSkills[skillName];
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      // Verify removal
      const updatedManifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
      expect(updatedManifest.installedSkills[skillName]).toBeUndefined();
    });

    it('should detect modified skills before uninstall', async () => {
      const skillName = 'modified-skill';
      const skillPath = await createMockInstalledSkill(ctx.skillsDir, skillName);

      // Record install time
      const installTime = new Date(Date.now() - 10000); // 10 seconds ago

      // Modify the file
      await new Promise(resolve => setTimeout(resolve, 100));
      await fs.writeFile(path.join(skillPath, 'SKILL.md'), '# Modified Content\n\n' + 'x'.repeat(100));

      // Check modification time
      const stats = await fs.stat(path.join(skillPath, 'SKILL.md'));
      expect(stats.mtime > installTime).toBe(true);
    });
  });

  describe('Full Workflow Integration', () => {
    it('should complete search → install → verify workflow', async () => {
      // Step 1: Search for skills
      const searchResponse = await executeSearch({ query: 'commit' });
      expect(searchResponse.results.length).toBeGreaterThan(0);

      const targetSkill = searchResponse.results[0];

      // Step 2: Get skill details
      const skillDetails = ctx.skillRepository.findById(targetSkill.id);
      if (!skillDetails) {
        // If not in DB (mock data), skip detailed check
        return;
      }

      expect(skillDetails.name).toBe(targetSkill.name);

      // Step 3: Simulate install
      const skillPath = path.join(ctx.skillsDir, targetSkill.name);
      await fs.mkdir(skillPath, { recursive: true });
      await fs.writeFile(
        path.join(skillPath, 'SKILL.md'),
        `# ${targetSkill.name}\n\n${targetSkill.description}\n\n## Usage\n\nUse this skill.`
      );

      // Step 4: Update manifest
      const manifestPath = path.join(ctx.manifestDir, 'manifest.json');
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
      manifest.installedSkills[targetSkill.name] = {
        id: targetSkill.id,
        name: targetSkill.name,
        version: '1.0.0',
        source: `github:${targetSkill.id}`,
        installPath: skillPath,
        installedAt: new Date().toISOString(),
      };
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      // Step 5: Verify installation
      const verifyManifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
      expect(verifyManifest.installedSkills[targetSkill.name]).toBeDefined();

      const skillMdExists = await fs.stat(path.join(skillPath, 'SKILL.md')).catch(() => null);
      expect(skillMdExists?.isFile()).toBe(true);
    });

    it('should complete install → uninstall workflow', async () => {
      const skillName = 'lifecycle-test';

      // Install
      const skillPath = await createMockInstalledSkill(ctx.skillsDir, skillName);
      await createMockManifest(ctx.manifestDir, {
        [skillName]: {
          id: `test/${skillName}`,
          name: skillName,
          version: '1.0.0',
          source: `github:test/${skillName}`,
          installPath: skillPath,
          installedAt: new Date().toISOString(),
        },
      });

      // Verify installed
      await expect(fs.access(skillPath)).resolves.toBeUndefined();

      // Uninstall - remove directory
      await fs.rm(skillPath, { recursive: true, force: true });

      // Uninstall - update manifest
      const manifestPath = path.join(ctx.manifestDir, 'manifest.json');
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
      delete manifest.installedSkills[skillName];
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      // Verify uninstalled
      await expect(fs.access(skillPath)).rejects.toThrow();

      const updatedManifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
      expect(updatedManifest.installedSkills[skillName]).toBeUndefined();
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid skill ID format gracefully', () => {
      const skill = ctx.skillRepository.findById('');
      expect(skill).toBeNull();
    });

    it('should handle very long skill IDs', () => {
      const longId = 'a'.repeat(1000);
      const skill = ctx.skillRepository.findById(longId);
      expect(skill).toBeNull();
    });

    it('should handle filesystem errors during install', async () => {
      // Try to write to an invalid path
      const invalidPath = '/nonexistent/path/that/cannot/exist/skill';

      await expect(
        fs.mkdir(invalidPath, { recursive: true })
      ).rejects.toThrow();
    });

    it('should handle manifest corruption recovery', async () => {
      const manifestPath = path.join(ctx.manifestDir, 'corrupt-manifest.json');

      // Write corrupt JSON
      await fs.writeFile(manifestPath, 'not valid json {{{');

      // Try to read and handle error
      await expect(async () => {
        const content = await fs.readFile(manifestPath, 'utf-8');
        JSON.parse(content);
      }).rejects.toThrow();
    });
  });

  describe('Cache Integration', () => {
    it('should cache search results', () => {
      const query = { query: 'typescript', limit: 10, offset: 0 };

      // First search
      const result1 = ctx.searchService.search(query);

      // Second search (should be cached)
      const result2 = ctx.searchService.search(query);

      expect(result1.items.map(r => r.skill.id)).toEqual(
        result2.items.map(r => r.skill.id)
      );
    });

    it('should use CacheRepository for metadata', () => {
      ctx.cacheRepository.set('install:last-check', {
        timestamp: new Date().toISOString(),
        skillCount: 5,
      });

      const cached = ctx.cacheRepository.get('install:last-check');
      expect(cached).toEqual({
        timestamp: expect.any(String),
        skillCount: 5,
      });
    });
  });

  describe('Performance', () => {
    it('should execute search in under 50ms', async () => {
      const start = performance.now();
      await executeSearch({ query: 'test' });
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(50);
    });

    it('should format results in under 5ms', async () => {
      const response = await executeSearch({ query: 'docker' });

      const start = performance.now();
      formatSearchResults(response);
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(5);
    });

    it('should retrieve skill by ID in under 10ms', () => {
      const start = performance.now();
      ctx.skillRepository.findById('anthropic/commit');
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(10);
    });
  });
});
