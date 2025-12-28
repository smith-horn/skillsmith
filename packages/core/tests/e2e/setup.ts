/**
 * SMI-631: E2E Test Setup
 * Provides comprehensive test utilities for E2E testing with real services
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import {
  createDatabase,
  closeDatabase,
  SkillRepository,
  SearchService,
  RankingService,
  CacheRepository,
  type Skill,
  type RankableSkill,
} from '../../src/index.js';

/**
 * Mock GitHub API response types
 */
export interface MockGitHubRepo {
  full_name: string;
  description: string;
  stargazers_count: number;
  forks_count: number;
  updated_at: string;
  html_url: string;
  topics?: string[];
}

export interface MockGitHubContent {
  path: string;
  content: string;
  encoding: 'base64' | 'utf-8';
}

/**
 * GitHub API mock configuration
 */
export interface GitHubMockConfig {
  repos: Record<string, MockGitHubRepo>;
  contents: Record<string, MockGitHubContent>;
  rateLimitRemaining?: number;
  rateLimitReset?: number;
}

/**
 * E2E test context containing all initialized services
 */
export interface E2ETestContext {
  db: DatabaseType;
  skillRepository: SkillRepository;
  searchService: SearchService;
  rankingService: RankingService;
  cacheRepository: CacheRepository;
  cleanup: () => Promise<void>;
}

/**
 * Test skill fixtures with extended metadata for ranking
 */
export const TEST_SKILLS: (Skill & Partial<RankableSkill>)[] = [
  {
    id: 'anthropic/commit',
    name: 'commit',
    description: 'Generate semantic commit messages following conventional commits specification with AI assistance',
    author: 'anthropic',
    repoUrl: 'https://github.com/anthropics/claude-code-skills/tree/main/commit',
    qualityScore: 0.95,
    trustTier: 'verified',
    tags: ['git', 'commit', 'conventional-commits', 'automation', 'ai'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stars: 1500,
    forks: 200,
  },
  {
    id: 'anthropic/review-pr',
    name: 'review-pr',
    description: 'Review pull requests with detailed code analysis, security checks, and AI-powered suggestions',
    author: 'anthropic',
    repoUrl: 'https://github.com/anthropics/claude-code-skills/tree/main/review-pr',
    qualityScore: 0.93,
    trustTier: 'verified',
    tags: ['git', 'pull-request', 'code-review', 'security', 'quality'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stars: 1200,
    forks: 150,
  },
  {
    id: 'community/jest-helper',
    name: 'jest-helper',
    description: 'Generate Jest test cases for React components with comprehensive coverage and mocking support',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/jest-helper',
    qualityScore: 0.87,
    trustTier: 'community',
    tags: ['jest', 'testing', 'react', 'unit-tests', 'mocking'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days ago
    stars: 500,
    forks: 80,
  },
  {
    id: 'community/docker-compose',
    name: 'docker-compose',
    description: 'Generate and manage Docker Compose configurations for development and production environments',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/docker-compose',
    qualityScore: 0.84,
    trustTier: 'community',
    tags: ['docker', 'devops', 'containers', 'compose', 'infrastructure'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(), // 60 days ago
    stars: 350,
    forks: 45,
  },
  {
    id: 'community/api-docs',
    name: 'api-docs',
    description: 'Generate OpenAPI documentation from code with automatic schema detection and validation',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/api-docs',
    qualityScore: 0.78,
    trustTier: 'experimental',
    tags: ['openapi', 'documentation', 'api', 'swagger', 'rest'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(), // 90 days ago
    stars: 120,
    forks: 20,
  },
  {
    id: 'test/typescript-helper',
    name: 'typescript-helper',
    description: 'TypeScript development utilities for type generation, refactoring, and code analysis',
    author: 'test',
    repoUrl: 'https://github.com/test/typescript-helper',
    qualityScore: 0.65,
    trustTier: 'unknown',
    tags: ['typescript', 'development', 'types', 'refactoring'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString(), // 180 days ago
    stars: 50,
    forks: 5,
  },
  {
    id: 'community/eslint-config',
    name: 'eslint-config',
    description: 'Generate and configure ESLint rules for JavaScript and TypeScript projects',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/eslint-config',
    qualityScore: 0.82,
    trustTier: 'community',
    tags: ['eslint', 'linting', 'javascript', 'typescript', 'code-quality'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stars: 280,
    forks: 35,
  },
  {
    id: 'anthropic/debug-helper',
    name: 'debug-helper',
    description: 'AI-powered debugging assistant for identifying and fixing code issues',
    author: 'anthropic',
    repoUrl: 'https://github.com/anthropics/claude-code-skills/tree/main/debug-helper',
    qualityScore: 0.91,
    trustTier: 'verified',
    tags: ['debugging', 'ai', 'analysis', 'troubleshooting'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stars: 800,
    forks: 100,
  },
];

/**
 * Create an E2E test context with all services initialized
 */
export async function createE2EContext(): Promise<E2ETestContext> {
  const db = createDatabase(':memory:');
  const skillRepository = new SkillRepository(db);
  const searchService = new SearchService(db, { cacheTtl: 60 });
  const rankingService = new RankingService();
  const cacheRepository = new CacheRepository(db);

  // Seed with test data
  seedTestSkills(skillRepository);

  return {
    db,
    skillRepository,
    searchService,
    rankingService,
    cacheRepository,
    cleanup: async () => {
      closeDatabase(db);
    },
  };
}

/**
 * Seed test skills into the database
 */
function seedTestSkills(repo: SkillRepository): void {
  repo.createBatch(TEST_SKILLS.map(skill => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    author: skill.author,
    repoUrl: skill.repoUrl,
    qualityScore: skill.qualityScore,
    trustTier: skill.trustTier,
    tags: skill.tags,
  })));
}

/**
 * Get extended skill data for ranking tests
 */
export function getExtendedSkillData(): Map<string, RankableSkill> {
  const data = new Map<string, RankableSkill>();
  for (const skill of TEST_SKILLS) {
    data.set(skill.id, {
      ...skill,
      stars: skill.stars ?? 0,
      forks: skill.forks ?? 0,
      lastUpdatedAt: skill.updatedAt,
    });
  }
  return data;
}

/**
 * Create mock GitHub API responses
 */
export function createGitHubMocks(): GitHubMockConfig {
  return {
    repos: {
      'anthropics/claude-code-skills': {
        full_name: 'anthropics/claude-code-skills',
        description: 'Official Claude Code skills repository',
        stargazers_count: 5000,
        forks_count: 800,
        updated_at: new Date().toISOString(),
        html_url: 'https://github.com/anthropics/claude-code-skills',
        topics: ['claude', 'ai', 'skills', 'automation'],
      },
      'skillsmith-community/jest-helper': {
        full_name: 'skillsmith-community/jest-helper',
        description: 'Jest test generation helper',
        stargazers_count: 500,
        forks_count: 80,
        updated_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        html_url: 'https://github.com/skillsmith-community/jest-helper',
        topics: ['jest', 'testing', 'react'],
      },
    },
    contents: {
      'anthropics/claude-code-skills/commit/SKILL.md': {
        path: 'commit/SKILL.md',
        content: Buffer.from(`# Commit Helper

Generate semantic commit messages following conventional commits specification.

## Usage

Simply describe your changes and this skill will generate appropriate commit messages.

## Features

- Conventional commits format
- Automatic scope detection
- Breaking change detection
`).toString('base64'),
        encoding: 'base64',
      },
      'skillsmith-community/jest-helper/SKILL.md': {
        path: 'SKILL.md',
        content: Buffer.from(`# Jest Helper

Generate comprehensive Jest tests for React components.

## Usage

Provide a component and this skill will generate test cases.

## Features

- Component testing
- Hook testing
- Mocking support
`).toString('base64'),
        encoding: 'base64',
      },
    },
    rateLimitRemaining: 5000,
    rateLimitReset: Math.floor(Date.now() / 1000) + 3600,
  };
}

/**
 * Create a mock fetch function for GitHub API
 */
export function createMockGitHubFetch(config: GitHubMockConfig): typeof globalThis.fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = new Headers({
      'Content-Type': 'application/json',
      'X-RateLimit-Remaining': String(config.rateLimitRemaining ?? 5000),
      'X-RateLimit-Reset': String(config.rateLimitReset ?? Math.floor(Date.now() / 1000) + 3600),
    });

    // Rate limit simulation
    if (config.rateLimitRemaining !== undefined && config.rateLimitRemaining <= 0) {
      return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
        status: 403,
        headers,
      });
    }

    // Repository API
    const repoMatch = url.match(/api\.github\.com\/repos\/([^/]+\/[^/]+)$/);
    if (repoMatch) {
      const repoName = repoMatch[1];
      const repo = config.repos[repoName];
      if (repo) {
        return new Response(JSON.stringify(repo), { status: 200, headers });
      }
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers });
    }

    // Contents API
    const contentsMatch = url.match(/api\.github\.com\/repos\/([^/]+\/[^/]+)\/contents\/(.+)/);
    if (contentsMatch) {
      const [, repoName, path] = contentsMatch;
      const contentKey = `${repoName}/${path}`;
      const content = config.contents[contentKey];
      if (content) {
        return new Response(JSON.stringify(content), { status: 200, headers });
      }
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers });
    }

    // Search API
    if (url.includes('api.github.com/search/repositories')) {
      const repos = Object.values(config.repos);
      return new Response(JSON.stringify({
        total_count: repos.length,
        incomplete_results: false,
        items: repos,
      }), { status: 200, headers });
    }

    // Default 404
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers });
  };
}

/**
 * Wait for a condition to be true with timeout
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout = 5000,
  interval = 100
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error('Timeout waiting for condition');
}

/**
 * Generate random test data for stress testing
 */
export function generateRandomSkills(count: number): Skill[] {
  const tiers = ['verified', 'community', 'experimental', 'unknown'] as const;
  const tagOptions = [
    'javascript', 'typescript', 'react', 'vue', 'angular',
    'testing', 'documentation', 'automation', 'devops', 'security',
  ];

  return Array.from({ length: count }, (_, i) => ({
    id: `stress-test/skill-${i}`,
    name: `skill-${i}`,
    description: `Stress test skill ${i} with searchable content for testing performance and scalability`,
    author: `author-${i % 10}`,
    repoUrl: `https://github.com/stress-test/skill-${i}`,
    qualityScore: Math.random(),
    trustTier: tiers[Math.floor(Math.random() * tiers.length)],
    tags: [
      tagOptions[i % tagOptions.length],
      tagOptions[(i + 1) % tagOptions.length],
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date(Date.now() - Math.random() * 365 * 24 * 60 * 60 * 1000).toISOString(),
  }));
}

/**
 * Simulate rate limiting for testing
 */
export function createRateLimitedMock(
  baseMock: typeof globalThis.fetch,
  maxRequests: number,
  windowMs: number
): typeof globalThis.fetch {
  let requestCount = 0;
  let windowStart = Date.now();

  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const now = Date.now();
    if (now - windowStart > windowMs) {
      windowStart = now;
      requestCount = 0;
    }

    requestCount++;
    if (requestCount > maxRequests) {
      return new Response(JSON.stringify({ message: 'Rate limit exceeded' }), {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil((windowStart + windowMs - now) / 1000)),
        },
      });
    }

    return baseMock(input, init);
  };
}
