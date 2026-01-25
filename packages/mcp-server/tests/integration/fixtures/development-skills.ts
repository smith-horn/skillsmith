/**
 * SMI-903: Development-related test skill fixtures
 * Community skills for programming languages and frameworks
 */

import type { TestSkillData } from './skill-types.js'

/**
 * Community skills - Development (6 total)
 */
export const DEVELOPMENT_SKILLS: TestSkillData[] = [
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
]

/**
 * Community skills - Documentation (3 total)
 */
export const DOCUMENTATION_SKILLS: TestSkillData[] = [
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
]

/**
 * Community skills - Database (3 total)
 */
export const DATABASE_SKILLS: TestSkillData[] = [
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
]

/**
 * SMI-907: Additional skills for overlap detection testing
 */
export const OVERLAP_DETECTION_SKILLS: TestSkillData[] = [
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
]
