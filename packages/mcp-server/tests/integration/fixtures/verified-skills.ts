/**
 * SMI-903: Verified test skill fixtures
 * Official/trusted skills with highest quality scores
 */

import type { TestSkillData } from './skill-types.js'

/**
 * Verified skills (8 total)
 * These represent official/trusted skills with highest quality
 */
export const VERIFIED_SKILLS: TestSkillData[] = [
  {
    id: 'anthropic/commit',
    name: 'commit',
    description: 'Generate semantic commit messages following conventional commits specification',
    author: 'anthropic',
    repoUrl: 'https://github.com/anthropics/claude-code-skills/commit',
    qualityScore: 0.95,
    trustTier: 'verified',
    tags: ['git', 'commit', 'conventional-commits', 'automation', 'development'],
  },
  {
    id: 'anthropic/review-pr',
    name: 'review-pr',
    description: 'Review pull requests with detailed code analysis and security checks',
    author: 'anthropic',
    repoUrl: 'https://github.com/anthropics/claude-code-skills/review-pr',
    qualityScore: 0.93,
    trustTier: 'verified',
    tags: ['git', 'pull-request', 'code-review', 'quality', 'development'],
  },
  {
    id: 'anthropic/debug',
    name: 'debug',
    description: 'Advanced debugging assistance with stack trace analysis and fix suggestions',
    author: 'anthropic',
    repoUrl: 'https://github.com/anthropics/claude-code-skills/debug',
    qualityScore: 0.91,
    trustTier: 'verified',
    tags: ['debugging', 'error-handling', 'troubleshooting', 'development'],
  },
  {
    id: 'anthropic/refactor',
    name: 'refactor',
    description: 'Intelligent code refactoring with pattern detection and best practices',
    author: 'anthropic',
    repoUrl: 'https://github.com/anthropics/claude-code-skills/refactor',
    qualityScore: 0.9,
    trustTier: 'verified',
    tags: ['refactoring', 'code-quality', 'patterns', 'development'],
  },
  {
    id: 'anthropic/explain',
    name: 'explain',
    description: 'Explain complex code with detailed documentation and examples',
    author: 'anthropic',
    repoUrl: 'https://github.com/anthropics/claude-code-skills/explain',
    qualityScore: 0.92,
    trustTier: 'verified',
    tags: ['documentation', 'explanation', 'learning', 'education'],
  },
  {
    id: 'anthropic/security-audit',
    name: 'security-audit',
    description: 'Comprehensive security auditing for vulnerabilities and best practices',
    author: 'anthropic',
    repoUrl: 'https://github.com/anthropics/claude-code-skills/security-audit',
    qualityScore: 0.94,
    trustTier: 'verified',
    tags: ['security', 'audit', 'vulnerabilities', 'owasp', 'security'],
  },
  {
    id: 'anthropic/test-gen',
    name: 'test-gen',
    description: 'Generate comprehensive test suites with high coverage',
    author: 'anthropic',
    repoUrl: 'https://github.com/anthropics/claude-code-skills/test-gen',
    qualityScore: 0.89,
    trustTier: 'verified',
    tags: ['testing', 'test-generation', 'coverage', 'testing'],
  },
  {
    id: 'anthropic/perf-optimize',
    name: 'perf-optimize',
    description: 'Performance optimization with profiling and bottleneck detection',
    author: 'anthropic',
    repoUrl: 'https://github.com/anthropics/claude-code-skills/perf-optimize',
    qualityScore: 0.88,
    trustTier: 'verified',
    tags: ['performance', 'optimization', 'profiling', 'development'],
  },
]
