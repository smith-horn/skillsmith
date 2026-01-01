/**
 * @fileoverview Trigger Detection System for proactive skill suggestions
 * @module @skillsmith/core/triggers/TriggerDetector
 * @see Phase 4: Trigger System Architecture
 *
 * Detects contexts where skill suggestions would be relevant based on:
 * - File patterns (*.test.ts → testing skills)
 * - Command patterns (git commit → commit skills)
 * - Error messages (ESLint error → linting skills)
 * - Project structure (React detected → React skills)
 *
 * @example
 * const detector = new TriggerDetector(analyzer);
 * const triggers = await detector.detectTriggers('/path/to/project', {
 *   currentFile: 'src/App.test.tsx',
 *   recentCommands: ['npm test'],
 * });
 */

import type { CodebaseContext } from '../analysis/CodebaseAnalyzer.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('TriggerDetector')

/**
 * Trigger types for skill suggestions
 */
export type TriggerType = 'file' | 'command' | 'error' | 'project'

/**
 * File pattern trigger configuration
 */
export interface FilePatternTrigger {
  /** Pattern to match against file paths */
  pattern: string | RegExp
  /** Skill categories this trigger suggests */
  skillCategories: string[]
  /** Confidence level (0-1) */
  confidence: number
  /** Human-readable description */
  description: string
}

/**
 * Command pattern trigger configuration
 */
export interface CommandTrigger {
  /** Pattern to match against commands */
  command: string | RegExp
  /** Skill categories this trigger suggests */
  skillCategories: string[]
  /** Confidence level (0-1) */
  confidence: number
  /** Human-readable description */
  description: string
}

/**
 * Error pattern trigger configuration
 */
export interface ErrorTrigger {
  /** Pattern to match against error messages */
  errorPattern: RegExp
  /** Skill categories this trigger suggests */
  skillCategories: string[]
  /** Confidence level (0-1) */
  confidence: number
  /** Human-readable description */
  description: string
}

/**
 * Project structure trigger configuration
 */
export interface ProjectTrigger {
  /** Function to detect if trigger applies to codebase */
  detector: (context: CodebaseContext) => boolean
  /** Skill categories this trigger suggests */
  skillCategories: string[]
  /** Confidence level (0-1) */
  confidence: number
  /** Human-readable description */
  description: string
}

/**
 * Detected trigger with metadata
 */
export interface DetectedTrigger {
  /** Type of trigger */
  type: TriggerType
  /** Skill categories suggested */
  categories: string[]
  /** Confidence score (0-1) */
  confidence: number
  /** Why this trigger fired */
  reason: string
  /** Source that caused the trigger (file path, command, etc.) */
  source?: string
}

/**
 * Options for trigger detection
 */
export interface TriggerDetectionOptions {
  /** Current file being edited */
  currentFile?: string
  /** Recent terminal commands (last 5) */
  recentCommands?: string[]
  /** Recent error message if any */
  errorMessage?: string
  /** Minimum confidence threshold (default: 0.5) */
  minConfidence?: number
}

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

/**
 * TriggerDetector - Detects contexts for skill suggestions
 *
 * Analyzes file patterns, commands, errors, and project structure
 * to identify relevant skill recommendation opportunities.
 */
export class TriggerDetector {
  private filePatterns: FilePatternTrigger[]
  private commandPatterns: CommandTrigger[]
  private errorPatterns: ErrorTrigger[]
  private projectPatterns: ProjectTrigger[]

  constructor(
    fileTriggers: FilePatternTrigger[] = DEFAULT_FILE_TRIGGERS,
    commandTriggers: CommandTrigger[] = DEFAULT_COMMAND_TRIGGERS,
    errorTriggers: ErrorTrigger[] = DEFAULT_ERROR_TRIGGERS,
    projectTriggers: ProjectTrigger[] = DEFAULT_PROJECT_TRIGGERS
  ) {
    this.filePatterns = fileTriggers
    this.commandPatterns = commandTriggers
    this.errorPatterns = errorTriggers
    this.projectPatterns = projectTriggers

    log.info('TriggerDetector initialized', {
      filePatterns: this.filePatterns.length,
      commandPatterns: this.commandPatterns.length,
      errorPatterns: this.errorPatterns.length,
      projectPatterns: this.projectPatterns.length,
    })
  }

  /**
   * Detect all applicable triggers for the current context
   *
   * @param codebaseContext - Analysis of the project structure
   * @param options - Current context (file, commands, errors)
   * @returns Array of detected triggers
   */
  detectTriggers(
    codebaseContext: CodebaseContext | null,
    options: TriggerDetectionOptions = {}
  ): DetectedTrigger[] {
    const { currentFile, recentCommands = [], errorMessage, minConfidence = 0.5 } = options

    const triggers: DetectedTrigger[] = []

    // File pattern triggers
    if (currentFile) {
      const fileTrigs = this.detectFilePatternTriggers(currentFile)
      triggers.push(...fileTrigs)
    }

    // Command triggers
    if (recentCommands.length > 0) {
      const cmdTrigs = this.detectCommandTriggers(recentCommands)
      triggers.push(...cmdTrigs)
    }

    // Error triggers
    if (errorMessage) {
      const errorTrigs = this.detectErrorTriggers(errorMessage)
      triggers.push(...errorTrigs)
    }

    // Project structure triggers
    if (codebaseContext) {
      const projTrigs = this.detectProjectTriggers(codebaseContext)
      triggers.push(...projTrigs)
    }

    // Filter by confidence threshold
    const filtered = triggers.filter((t) => t.confidence >= minConfidence)

    // Deduplicate and rank
    return this.deduplicateAndRank(filtered)
  }

  /**
   * Detect file pattern triggers
   */
  private detectFilePatternTriggers(filePath: string): DetectedTrigger[] {
    const triggers: DetectedTrigger[] = []

    for (const pattern of this.filePatterns) {
      const matches =
        typeof pattern.pattern === 'string'
          ? filePath.includes(pattern.pattern)
          : pattern.pattern.test(filePath)

      if (matches) {
        triggers.push({
          type: 'file',
          categories: pattern.skillCategories,
          confidence: pattern.confidence,
          reason: pattern.description,
          source: filePath,
        })
      }
    }

    return triggers
  }

  /**
   * Detect command pattern triggers
   */
  private detectCommandTriggers(commands: string[]): DetectedTrigger[] {
    const triggers: DetectedTrigger[] = []

    for (const command of commands) {
      for (const pattern of this.commandPatterns) {
        const matches =
          typeof pattern.command === 'string'
            ? command.includes(pattern.command)
            : pattern.command.test(command)

        if (matches) {
          triggers.push({
            type: 'command',
            categories: pattern.skillCategories,
            confidence: pattern.confidence,
            reason: pattern.description,
            source: command,
          })
        }
      }
    }

    return triggers
  }

  /**
   * Detect error pattern triggers
   */
  private detectErrorTriggers(errorMessage: string): DetectedTrigger[] {
    const triggers: DetectedTrigger[] = []

    for (const pattern of this.errorPatterns) {
      if (pattern.errorPattern.test(errorMessage)) {
        triggers.push({
          type: 'error',
          categories: pattern.skillCategories,
          confidence: pattern.confidence,
          reason: pattern.description,
          source: errorMessage.slice(0, 100), // Truncate for safety
        })
      }
    }

    return triggers
  }

  /**
   * Detect project structure triggers
   */
  private detectProjectTriggers(context: CodebaseContext): DetectedTrigger[] {
    const triggers: DetectedTrigger[] = []

    for (const pattern of this.projectPatterns) {
      try {
        if (pattern.detector(context)) {
          triggers.push({
            type: 'project',
            categories: pattern.skillCategories,
            confidence: pattern.confidence,
            reason: pattern.description,
          })
        }
      } catch (error) {
        log.warn(`Project trigger detector failed: ${error}`)
      }
    }

    return triggers
  }

  /**
   * Deduplicate triggers and rank by confidence
   */
  private deduplicateAndRank(triggers: DetectedTrigger[]): DetectedTrigger[] {
    // Group by category
    const categoryMap = new Map<string, DetectedTrigger>()

    for (const trigger of triggers) {
      for (const category of trigger.categories) {
        const existing = categoryMap.get(category)

        if (!existing || trigger.confidence > existing.confidence) {
          categoryMap.set(category, trigger)
        }
      }
    }

    // Convert back to array and sort by confidence
    return Array.from(categoryMap.values()).sort((a, b) => b.confidence - a.confidence)
  }

  /**
   * Add custom file pattern trigger
   */
  addFilePattern(trigger: FilePatternTrigger): void {
    this.filePatterns.push(trigger)
    log.debug('Added file pattern trigger', { pattern: trigger.pattern })
  }

  /**
   * Add custom command trigger
   */
  addCommandPattern(trigger: CommandTrigger): void {
    this.commandPatterns.push(trigger)
    log.debug('Added command trigger', { command: trigger.command })
  }

  /**
   * Add custom error trigger
   */
  addErrorPattern(trigger: ErrorTrigger): void {
    this.errorPatterns.push(trigger)
    log.debug('Added error trigger', { pattern: trigger.errorPattern })
  }

  /**
   * Add custom project trigger
   */
  addProjectPattern(trigger: ProjectTrigger): void {
    this.projectPatterns.push(trigger)
    log.debug('Added project trigger', { description: trigger.description })
  }
}

export default TriggerDetector
