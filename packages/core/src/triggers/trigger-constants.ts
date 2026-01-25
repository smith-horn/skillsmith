/**
 * Default trigger configurations for TriggerDetector
 * @module @skillsmith/core/triggers/trigger-constants
 */

import type {
  FilePatternTrigger,
  CommandTrigger,
  ErrorTrigger,
  ProjectTrigger,
} from './trigger-types.js'

/**
 * Default file pattern triggers
 */
export const DEFAULT_FILE_TRIGGERS: FilePatternTrigger[] = [
  {
    pattern: /\.test\.(ts|js|tsx|jsx)$/,
    skillCategories: ['testing', 'jest', 'vitest'],
    confidence: 0.9,
    description: 'Test files suggest testing framework skills',
  },
  {
    pattern: /docker-compose\.ya?ml$/,
    skillCategories: ['docker', 'devops', 'containers'],
    confidence: 0.95,
    description: 'Docker Compose files suggest containerization skills',
  },
  {
    pattern: /\.github\/workflows\/.*\.ya?ml$/,
    skillCategories: ['github-actions', 'ci-cd', 'automation'],
    confidence: 0.9,
    description: 'GitHub Actions workflows suggest CI/CD skills',
  },
  {
    pattern: /Dockerfile$/,
    skillCategories: ['docker', 'devops', 'containers'],
    confidence: 0.95,
    description: 'Dockerfile suggests Docker skills',
  },
  {
    pattern: /\.eslintrc\.(js|json|ya?ml)$/,
    skillCategories: ['eslint', 'linting', 'code-quality'],
    confidence: 0.85,
    description: 'ESLint config suggests linting skills',
  },
  {
    pattern: /prisma\/schema\.prisma$/,
    skillCategories: ['prisma', 'database', 'orm'],
    confidence: 0.95,
    description: 'Prisma schema suggests database ORM skills',
  },
  {
    pattern: /\.spec\.(ts|js)$/,
    skillCategories: ['testing', 'jest', 'vitest'],
    confidence: 0.85,
    description: 'Spec files suggest testing framework skills',
  },
]

/**
 * Default command triggers
 */
export const DEFAULT_COMMAND_TRIGGERS: CommandTrigger[] = [
  {
    command: /git\s+commit/,
    skillCategories: ['commit', 'git', 'version-control'],
    confidence: 0.85,
    description: 'Git commit commands suggest commit message skills',
  },
  {
    command: /npm\s+(test|run\s+test)/,
    skillCategories: ['testing', 'jest', 'vitest'],
    confidence: 0.8,
    description: 'Test commands suggest testing helper skills',
  },
  {
    command: /docker\s+(build|run|compose)/,
    skillCategories: ['docker', 'devops', 'containers'],
    confidence: 0.9,
    description: 'Docker commands suggest containerization skills',
  },
  {
    command: /npm\s+(run\s+)?lint/,
    skillCategories: ['eslint', 'linting', 'code-quality'],
    confidence: 0.85,
    description: 'Lint commands suggest code quality skills',
  },
  {
    command: /prisma\s+(migrate|generate|studio)/,
    skillCategories: ['prisma', 'database', 'orm'],
    confidence: 0.9,
    description: 'Prisma commands suggest database ORM skills',
  },
]

/**
 * Default error triggers
 */
export const DEFAULT_ERROR_TRIGGERS: ErrorTrigger[] = [
  {
    errorPattern: /ESLint.*error/i,
    skillCategories: ['eslint', 'linting', 'code-quality'],
    confidence: 0.9,
    description: 'ESLint errors suggest linting configuration skills',
  },
  {
    errorPattern: /docker.*failed/i,
    skillCategories: ['docker', 'devops', 'containers'],
    confidence: 0.85,
    description: 'Docker errors suggest containerization troubleshooting skills',
  },
  {
    errorPattern: /(test|spec).*failed/i,
    skillCategories: ['testing', 'debugging'],
    confidence: 0.75,
    description: 'Test failures suggest testing helper skills',
  },
  {
    errorPattern: /prisma.*error/i,
    skillCategories: ['prisma', 'database', 'orm'],
    confidence: 0.85,
    description: 'Prisma errors suggest database troubleshooting skills',
  },
  {
    errorPattern: /type.*error/i,
    skillCategories: ['typescript', 'types'],
    confidence: 0.7,
    description: 'TypeScript errors suggest type helper skills',
  },
]

/**
 * Default project structure triggers
 */
export const DEFAULT_PROJECT_TRIGGERS: ProjectTrigger[] = [
  {
    detector: (ctx) => ctx.frameworks.some((f) => f.name === 'React'),
    skillCategories: ['react', 'frontend', 'components'],
    confidence: 0.95,
    description: 'React projects benefit from React component skills',
  },
  {
    detector: (ctx) => ctx.frameworks.some((f) => f.name === 'Next.js'),
    skillCategories: ['nextjs', 'react', 'frontend', 'ssr'],
    confidence: 0.95,
    description: 'Next.js projects benefit from Next.js helper skills',
  },
  {
    detector: (ctx) => ctx.frameworks.some((f) => f.name === 'Vue'),
    skillCategories: ['vue', 'frontend', 'components'],
    confidence: 0.95,
    description: 'Vue projects benefit from Vue component skills',
  },
  {
    detector: (ctx) => ctx.frameworks.some((f) => f.name === 'Express'),
    skillCategories: ['express', 'backend', 'api'],
    confidence: 0.9,
    description: 'Express projects benefit from API development skills',
  },
  {
    detector: (ctx) => ctx.frameworks.some((f) => f.name === 'Prisma'),
    skillCategories: ['prisma', 'database', 'orm'],
    confidence: 0.95,
    description: 'Prisma projects benefit from database ORM skills',
  },
  {
    detector: (ctx) => ctx.frameworks.some((f) => f.name === 'Jest'),
    skillCategories: ['jest', 'testing', 'unit-tests'],
    confidence: 0.9,
    description: 'Jest projects benefit from testing helper skills',
  },
  {
    detector: (ctx) => ctx.frameworks.some((f) => f.name === 'Vitest'),
    skillCategories: ['vitest', 'testing', 'unit-tests'],
    confidence: 0.9,
    description: 'Vitest projects benefit from testing helper skills',
  },
  {
    detector: (ctx) => ctx.dependencies.some((d) => d.name.startsWith('@prisma/')),
    skillCategories: ['prisma', 'database', 'orm'],
    confidence: 0.9,
    description: 'Prisma dependencies suggest database ORM skills',
  },
  {
    detector: (ctx) => {
      const hasTsFiles = Object.keys(ctx.stats.filesByExtension).some((ext) =>
        ['.ts', '.tsx'].includes(ext)
      )
      const totalFiles = ctx.stats.totalFiles
      return hasTsFiles && totalFiles > 10
    },
    skillCategories: ['typescript', 'types'],
    confidence: 0.85,
    description: 'TypeScript projects benefit from type helper skills',
  },
]
