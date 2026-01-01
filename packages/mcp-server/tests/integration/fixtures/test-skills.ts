/**
 * SMI-903: Comprehensive test skill fixtures
 * Provides 50+ skills across all categories and trust tiers for realistic testing
 */

import type { SkillRepository } from '@skillsmith/core'

/**
 * Test skill data structure matching SkillRepository.createBatch expectations
 */
interface TestSkillData {
  id: string
  name: string
  description: string
  author: string
  repoUrl: string
  qualityScore: number
  trustTier: 'verified' | 'community' | 'experimental' | 'unknown'
  tags: string[]
}

/**
 * Comprehensive test skills covering all categories and trust tiers
 * Total: 58 skills (updated for SMI-907)
 * - Categories: development, testing, documentation, devops, database, security, productivity, integration, ai-ml, other
 * - Trust tiers: verified (8), community (26), experimental (16), unknown (8)
 */
export const TEST_SKILLS: TestSkillData[] = [
  // ============ VERIFIED SKILLS (8) ============
  // These represent official/trusted skills with highest quality
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

  // ============ COMMUNITY SKILLS - TESTING (6) ============
  {
    id: 'community/jest-helper',
    name: 'jest-helper',
    description: 'Generate Jest test cases for React components with comprehensive coverage',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/jest-helper',
    qualityScore: 0.87,
    trustTier: 'community',
    tags: ['jest', 'testing', 'react', 'unit-tests', 'testing'],
  },
  {
    id: 'community/vitest-helper',
    name: 'vitest-helper',
    description: 'Generate Vitest test cases with modern testing patterns',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/vitest-helper',
    qualityScore: 0.85,
    trustTier: 'community',
    tags: ['vitest', 'testing', 'typescript', 'unit-tests', 'testing'],
  },
  {
    id: 'community/playwright-e2e',
    name: 'playwright-e2e',
    description: 'End-to-end testing with Playwright for web applications',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/playwright-e2e',
    qualityScore: 0.84,
    trustTier: 'community',
    tags: ['playwright', 'e2e', 'testing', 'browser', 'testing'],
  },
  {
    id: 'community/cypress-helper',
    name: 'cypress-helper',
    description: 'Cypress test generation and best practices for web testing',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/cypress-helper',
    qualityScore: 0.82,
    trustTier: 'community',
    tags: ['cypress', 'e2e', 'testing', 'web', 'testing'],
  },
  {
    id: 'community/mocha-chai',
    name: 'mocha-chai',
    description: 'Mocha and Chai test generation for Node.js applications',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/mocha-chai',
    qualityScore: 0.78,
    trustTier: 'community',
    tags: ['mocha', 'chai', 'testing', 'nodejs', 'testing'],
  },
  {
    id: 'community/testing-library',
    name: 'testing-library',
    description: 'React Testing Library patterns and component testing',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/testing-library',
    qualityScore: 0.86,
    trustTier: 'community',
    tags: ['testing-library', 'react', 'testing', 'components', 'testing'],
  },

  // ============ COMMUNITY SKILLS - DEVOPS (6) ============
  {
    id: 'community/docker-compose',
    name: 'docker-compose',
    description: 'Generate and manage Docker Compose configurations for development',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/docker-compose',
    qualityScore: 0.84,
    trustTier: 'community',
    tags: ['docker', 'devops', 'containers', 'compose', 'devops'],
  },
  {
    id: 'community/kubernetes-helper',
    name: 'kubernetes-helper',
    description: 'Kubernetes manifest generation and cluster management',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/kubernetes-helper',
    qualityScore: 0.81,
    trustTier: 'community',
    tags: ['kubernetes', 'k8s', 'devops', 'containers', 'devops'],
  },
  {
    id: 'community/github-actions',
    name: 'github-actions',
    description: 'GitHub Actions workflow generation and CI/CD pipelines',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/github-actions',
    qualityScore: 0.86,
    trustTier: 'community',
    tags: ['github-actions', 'ci-cd', 'automation', 'devops', 'devops'],
  },
  {
    id: 'community/terraform-helper',
    name: 'terraform-helper',
    description: 'Terraform infrastructure as code generation and best practices',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/terraform-helper',
    qualityScore: 0.79,
    trustTier: 'community',
    tags: ['terraform', 'iac', 'infrastructure', 'cloud', 'devops'],
  },
  {
    id: 'community/nginx-config',
    name: 'nginx-config',
    description: 'Nginx configuration generation for web servers and proxies',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/nginx-config',
    qualityScore: 0.75,
    trustTier: 'community',
    tags: ['nginx', 'webserver', 'proxy', 'devops', 'devops'],
  },
  {
    id: 'community/aws-helper',
    name: 'aws-helper',
    description: 'AWS service configuration and CloudFormation templates',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/aws-helper',
    qualityScore: 0.8,
    trustTier: 'community',
    tags: ['aws', 'cloud', 'cloudformation', 'infrastructure', 'devops'],
  },

  // ============ COMMUNITY SKILLS - DEVELOPMENT (6) ============
  {
    id: 'community/typescript-helper',
    name: 'typescript-helper',
    description: 'TypeScript development utilities for type generation and refactoring',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/typescript-helper',
    qualityScore: 0.83,
    trustTier: 'community',
    tags: ['typescript', 'development', 'types', 'development'],
  },
  {
    id: 'community/react-patterns',
    name: 'react-patterns',
    description: 'React component patterns and hooks best practices',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/react-patterns',
    qualityScore: 0.85,
    trustTier: 'community',
    tags: ['react', 'patterns', 'hooks', 'frontend', 'development'],
  },
  {
    id: 'community/nextjs-helper',
    name: 'nextjs-helper',
    description: 'Next.js application development with App Router and Server Components',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/nextjs-helper',
    qualityScore: 0.84,
    trustTier: 'community',
    tags: ['nextjs', 'react', 'ssr', 'frontend', 'development'],
  },
  {
    id: 'community/nodejs-helper',
    name: 'nodejs-helper',
    description: 'Node.js backend development patterns and utilities',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/nodejs-helper',
    qualityScore: 0.82,
    trustTier: 'community',
    tags: ['nodejs', 'backend', 'express', 'api', 'development'],
  },
  {
    id: 'community/python-helper',
    name: 'python-helper',
    description: 'Python development utilities and best practices',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/python-helper',
    qualityScore: 0.81,
    trustTier: 'community',
    tags: ['python', 'development', 'scripting', 'development'],
  },
  {
    id: 'community/rust-helper',
    name: 'rust-helper',
    description: 'Rust development patterns and memory safety guidance',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/rust-helper',
    qualityScore: 0.77,
    trustTier: 'community',
    tags: ['rust', 'systems', 'memory-safety', 'development'],
  },

  // ============ COMMUNITY SKILLS - DOCUMENTATION (3) ============
  {
    id: 'community/api-docs',
    name: 'api-docs',
    description: 'Generate OpenAPI documentation from code with automatic schema detection',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/api-docs',
    qualityScore: 0.78,
    trustTier: 'community',
    tags: ['openapi', 'documentation', 'api', 'swagger', 'documentation'],
  },
  {
    id: 'community/readme-gen',
    name: 'readme-gen',
    description: 'Generate comprehensive README files from project analysis',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/readme-gen',
    qualityScore: 0.76,
    trustTier: 'community',
    tags: ['readme', 'documentation', 'markdown', 'documentation'],
  },
  {
    id: 'community/jsdoc-helper',
    name: 'jsdoc-helper',
    description: 'JSDoc documentation generation for JavaScript and TypeScript',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/jsdoc-helper',
    qualityScore: 0.74,
    trustTier: 'community',
    tags: ['jsdoc', 'documentation', 'typescript', 'javascript', 'documentation'],
  },

  // ============ COMMUNITY SKILLS - DATABASE (3) ============
  {
    id: 'community/prisma-helper',
    name: 'prisma-helper',
    description: 'Prisma schema design and database migrations',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/prisma-helper',
    qualityScore: 0.83,
    trustTier: 'community',
    tags: ['prisma', 'database', 'orm', 'migrations', 'database'],
  },
  {
    id: 'community/sql-helper',
    name: 'sql-helper',
    description: 'SQL query optimization and schema design',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/sql-helper',
    qualityScore: 0.79,
    trustTier: 'community',
    tags: ['sql', 'database', 'queries', 'optimization', 'database'],
  },
  {
    id: 'community/mongodb-helper',
    name: 'mongodb-helper',
    description: 'MongoDB schema design and aggregation pipelines',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/mongodb-helper',
    qualityScore: 0.77,
    trustTier: 'community',
    tags: ['mongodb', 'nosql', 'database', 'aggregation', 'database'],
  },

  // ============ EXPERIMENTAL SKILLS (16) ============
  {
    id: 'experimental/ai-code-review',
    name: 'ai-code-review',
    description: 'AI-powered code review with ML-based pattern detection',
    author: 'experimental',
    repoUrl: 'https://github.com/skillsmith-experimental/ai-code-review',
    qualityScore: 0.72,
    trustTier: 'experimental',
    tags: ['ai', 'code-review', 'ml', 'patterns', 'ai-ml'],
  },
  {
    id: 'experimental/llm-prompt-helper',
    name: 'llm-prompt-helper',
    description: 'LLM prompt engineering and optimization techniques',
    author: 'experimental',
    repoUrl: 'https://github.com/skillsmith-experimental/llm-prompt-helper',
    qualityScore: 0.7,
    trustTier: 'experimental',
    tags: ['llm', 'prompts', 'ai', 'engineering', 'ai-ml'],
  },
  {
    id: 'experimental/embedding-search',
    name: 'embedding-search',
    description: 'Semantic search using embeddings and vector databases',
    author: 'experimental',
    repoUrl: 'https://github.com/skillsmith-experimental/embedding-search',
    qualityScore: 0.68,
    trustTier: 'experimental',
    tags: ['embeddings', 'vector', 'search', 'semantic', 'ai-ml'],
  },
  {
    id: 'experimental/ml-pipeline',
    name: 'ml-pipeline',
    description: 'Machine learning pipeline setup and training workflows',
    author: 'experimental',
    repoUrl: 'https://github.com/skillsmith-experimental/ml-pipeline',
    qualityScore: 0.65,
    trustTier: 'experimental',
    tags: ['ml', 'pipeline', 'training', 'ai', 'ai-ml'],
  },
  {
    id: 'experimental/graphql-helper',
    name: 'graphql-helper',
    description: 'GraphQL schema design and resolver generation',
    author: 'experimental',
    repoUrl: 'https://github.com/skillsmith-experimental/graphql-helper',
    qualityScore: 0.71,
    trustTier: 'experimental',
    tags: ['graphql', 'api', 'schema', 'resolvers', 'development'],
  },
  {
    id: 'experimental/grpc-helper',
    name: 'grpc-helper',
    description: 'gRPC service definition and protobuf generation',
    author: 'experimental',
    repoUrl: 'https://github.com/skillsmith-experimental/grpc-helper',
    qualityScore: 0.67,
    trustTier: 'experimental',
    tags: ['grpc', 'protobuf', 'api', 'services', 'integration'],
  },
  {
    id: 'experimental/websocket-helper',
    name: 'websocket-helper',
    description: 'WebSocket implementation patterns and real-time communication',
    author: 'experimental',
    repoUrl: 'https://github.com/skillsmith-experimental/websocket-helper',
    qualityScore: 0.69,
    trustTier: 'experimental',
    tags: ['websocket', 'realtime', 'communication', 'integration'],
  },
  {
    id: 'experimental/oauth-helper',
    name: 'oauth-helper',
    description: 'OAuth 2.0 implementation and authentication flows',
    author: 'experimental',
    repoUrl: 'https://github.com/skillsmith-experimental/oauth-helper',
    qualityScore: 0.73,
    trustTier: 'experimental',
    tags: ['oauth', 'authentication', 'security', 'identity', 'security'],
  },
  {
    id: 'experimental/jwt-helper',
    name: 'jwt-helper',
    description: 'JWT token generation and validation patterns',
    author: 'experimental',
    repoUrl: 'https://github.com/skillsmith-experimental/jwt-helper',
    qualityScore: 0.74,
    trustTier: 'experimental',
    tags: ['jwt', 'tokens', 'authentication', 'security', 'security'],
  },
  {
    id: 'experimental/encryption-helper',
    name: 'encryption-helper',
    description: 'Encryption utilities and secure data handling',
    author: 'experimental',
    repoUrl: 'https://github.com/skillsmith-experimental/encryption-helper',
    qualityScore: 0.71,
    trustTier: 'experimental',
    tags: ['encryption', 'security', 'crypto', 'data-protection', 'security'],
  },
  {
    id: 'experimental/monitoring-helper',
    name: 'monitoring-helper',
    description: 'Application monitoring and observability setup',
    author: 'experimental',
    repoUrl: 'https://github.com/skillsmith-experimental/monitoring-helper',
    qualityScore: 0.66,
    trustTier: 'experimental',
    tags: ['monitoring', 'observability', 'metrics', 'logging', 'devops'],
  },
  {
    id: 'experimental/caching-helper',
    name: 'caching-helper',
    description: 'Caching strategies and Redis/Memcached patterns',
    author: 'experimental',
    repoUrl: 'https://github.com/skillsmith-experimental/caching-helper',
    qualityScore: 0.68,
    trustTier: 'experimental',
    tags: ['caching', 'redis', 'performance', 'optimization', 'database'],
  },
  {
    id: 'experimental/queue-helper',
    name: 'queue-helper',
    description: 'Message queue patterns with RabbitMQ and SQS',
    author: 'experimental',
    repoUrl: 'https://github.com/skillsmith-experimental/queue-helper',
    qualityScore: 0.64,
    trustTier: 'experimental',
    tags: ['queues', 'rabbitmq', 'sqs', 'messaging', 'integration'],
  },
  {
    id: 'experimental/microservices-helper',
    name: 'microservices-helper',
    description: 'Microservices architecture patterns and service mesh',
    author: 'experimental',
    repoUrl: 'https://github.com/skillsmith-experimental/microservices-helper',
    qualityScore: 0.63,
    trustTier: 'experimental',
    tags: ['microservices', 'architecture', 'distributed', 'development'],
  },
  {
    id: 'experimental/event-sourcing',
    name: 'event-sourcing',
    description: 'Event sourcing and CQRS pattern implementation',
    author: 'experimental',
    repoUrl: 'https://github.com/skillsmith-experimental/event-sourcing',
    qualityScore: 0.61,
    trustTier: 'experimental',
    tags: ['event-sourcing', 'cqrs', 'patterns', 'architecture', 'development'],
  },
  {
    id: 'experimental/serverless-helper',
    name: 'serverless-helper',
    description: 'Serverless function development with AWS Lambda and Vercel',
    author: 'experimental',
    repoUrl: 'https://github.com/skillsmith-experimental/serverless-helper',
    qualityScore: 0.7,
    trustTier: 'experimental',
    tags: ['serverless', 'lambda', 'vercel', 'functions', 'devops'],
  },

  // ============ SMI-907: Additional skills for overlap detection testing ============
  {
    id: 'community/docker',
    name: 'docker',
    description: 'Docker container management and Dockerfile generation',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/docker',
    qualityScore: 0.85,
    trustTier: 'community',
    tags: ['docker', 'containers', 'devops', 'devops'],
  },
  {
    id: 'community/git-commit-helper',
    name: 'git-commit-helper',
    description: 'Git commit message generation with conventional commits support',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/git-commit-helper',
    qualityScore: 0.82,
    trustTier: 'community',
    tags: ['git', 'commit', 'conventional-commits', 'development'],
  },

  // ============ UNKNOWN TRUST SKILLS (8) ============
  {
    id: 'user123/custom-linter',
    name: 'custom-linter',
    description: 'Custom ESLint rules for project-specific conventions',
    author: 'user123',
    repoUrl: 'https://github.com/user123/custom-linter',
    qualityScore: 0.55,
    trustTier: 'unknown',
    tags: ['eslint', 'linting', 'code-quality', 'productivity'],
  },
  {
    id: 'devuser/quick-deploy',
    name: 'quick-deploy',
    description: 'Quick deployment scripts for small projects',
    author: 'devuser',
    repoUrl: 'https://github.com/devuser/quick-deploy',
    qualityScore: 0.52,
    trustTier: 'unknown',
    tags: ['deployment', 'scripts', 'automation', 'devops'],
  },
  {
    id: 'coder99/regex-helper',
    name: 'regex-helper',
    description: 'Regular expression generation and testing',
    author: 'coder99',
    repoUrl: 'https://github.com/coder99/regex-helper',
    qualityScore: 0.58,
    trustTier: 'unknown',
    tags: ['regex', 'patterns', 'utilities', 'productivity'],
  },
  {
    id: 'newdev/git-workflow',
    name: 'git-workflow',
    description: 'Git workflow automation and branch management',
    author: 'newdev',
    repoUrl: 'https://github.com/newdev/git-workflow',
    qualityScore: 0.5,
    trustTier: 'unknown',
    tags: ['git', 'workflow', 'branches', 'productivity'],
  },
  {
    id: 'hackdev/snippet-manager',
    name: 'snippet-manager',
    description: 'Code snippet organization and insertion',
    author: 'hackdev',
    repoUrl: 'https://github.com/hackdev/snippet-manager',
    qualityScore: 0.48,
    trustTier: 'unknown',
    tags: ['snippets', 'templates', 'productivity', 'productivity'],
  },
  {
    id: 'testuser/mock-data',
    name: 'mock-data',
    description: 'Generate realistic mock data for testing',
    author: 'testuser',
    repoUrl: 'https://github.com/testuser/mock-data',
    qualityScore: 0.54,
    trustTier: 'unknown',
    tags: ['mock', 'data', 'testing', 'fixtures', 'testing'],
  },
  {
    id: 'random/env-manager',
    name: 'env-manager',
    description: 'Environment variable management and validation',
    author: 'random',
    repoUrl: 'https://github.com/random/env-manager',
    qualityScore: 0.51,
    trustTier: 'unknown',
    tags: ['env', 'config', 'environment', 'productivity'],
  },
  {
    id: 'indie/cli-builder',
    name: 'cli-builder',
    description: 'CLI application scaffolding and argument parsing',
    author: 'indie',
    repoUrl: 'https://github.com/indie/cli-builder',
    qualityScore: 0.56,
    trustTier: 'unknown',
    tags: ['cli', 'commands', 'tools', 'development'],
  },
]

/**
 * Seed all test skills into the repository
 */
export function seedTestSkills(repo: SkillRepository): void {
  repo.createBatch(TEST_SKILLS)
}

/**
 * Get skills by category for targeted testing
 */
export function getSkillsByCategory(category: string): TestSkillData[] {
  return TEST_SKILLS.filter((skill) => skill.tags.includes(category))
}

/**
 * Get skills by trust tier for targeted testing
 */
export function getSkillsByTrustTier(
  tier: 'verified' | 'community' | 'experimental' | 'unknown'
): TestSkillData[] {
  return TEST_SKILLS.filter((skill) => skill.trustTier === tier)
}

/**
 * Summary statistics for test data validation
 */
export const TEST_SKILLS_STATS = {
  total: TEST_SKILLS.length,
  byTrustTier: {
    verified: TEST_SKILLS.filter((s) => s.trustTier === 'verified').length,
    community: TEST_SKILLS.filter((s) => s.trustTier === 'community').length,
    experimental: TEST_SKILLS.filter((s) => s.trustTier === 'experimental').length,
    unknown: TEST_SKILLS.filter((s) => s.trustTier === 'unknown').length,
  },
  byCategory: {
    development: TEST_SKILLS.filter((s) => s.tags.includes('development')).length,
    testing: TEST_SKILLS.filter((s) => s.tags.includes('testing')).length,
    documentation: TEST_SKILLS.filter((s) => s.tags.includes('documentation')).length,
    devops: TEST_SKILLS.filter((s) => s.tags.includes('devops')).length,
    database: TEST_SKILLS.filter((s) => s.tags.includes('database')).length,
    security: TEST_SKILLS.filter((s) => s.tags.includes('security')).length,
    productivity: TEST_SKILLS.filter((s) => s.tags.includes('productivity')).length,
    integration: TEST_SKILLS.filter((s) => s.tags.includes('integration')).length,
    'ai-ml': TEST_SKILLS.filter((s) => s.tags.includes('ai-ml')).length,
  },
}
