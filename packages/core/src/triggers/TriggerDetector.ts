/**
 * @fileoverview Trigger Detection System for proactive skill suggestions
 * @module @skillsmith/core/triggers/TriggerDetector
 * @see Phase 4: Trigger System Architecture
 *
 * Detects contexts where skill suggestions would be relevant.
 *
 * @see trigger-types.ts for type definitions
 * @see trigger-constants.ts for default trigger configurations
 */

import type { CodebaseContext } from '../analysis/CodebaseAnalyzer.js'
import { createLogger } from '../utils/logger.js'

// Re-export types
export type {
  TriggerType,
  FilePatternTrigger,
  CommandTrigger,
  ErrorTrigger,
  ProjectTrigger,
  DetectedTrigger,
  TriggerDetectionOptions,
} from './trigger-types.js'

// Re-export constants
export {
  DEFAULT_FILE_TRIGGERS,
  DEFAULT_COMMAND_TRIGGERS,
  DEFAULT_ERROR_TRIGGERS,
  DEFAULT_PROJECT_TRIGGERS,
} from './trigger-constants.js'

// Import types and constants
import type {
  FilePatternTrigger,
  CommandTrigger,
  ErrorTrigger,
  ProjectTrigger,
  DetectedTrigger,
  TriggerDetectionOptions,
} from './trigger-types.js'

import {
  DEFAULT_FILE_TRIGGERS,
  DEFAULT_COMMAND_TRIGGERS,
  DEFAULT_ERROR_TRIGGERS,
  DEFAULT_PROJECT_TRIGGERS,
} from './trigger-constants.js'

const log = createLogger('TriggerDetector')

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
   */
  detectTriggers(
    codebaseContext: CodebaseContext | null,
    options: TriggerDetectionOptions = {}
  ): DetectedTrigger[] {
    const { currentFile, recentCommands = [], errorMessage, minConfidence = 0.5 } = options
    const triggers: DetectedTrigger[] = []

    if (currentFile) triggers.push(...this.detectFilePatternTriggers(currentFile))
    if (recentCommands.length > 0) triggers.push(...this.detectCommandTriggers(recentCommands))
    if (errorMessage) triggers.push(...this.detectErrorTriggers(errorMessage))
    if (codebaseContext) triggers.push(...this.detectProjectTriggers(codebaseContext))

    const filtered = triggers.filter((t) => t.confidence >= minConfidence)
    return this.deduplicateAndRank(filtered)
  }

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

  private detectErrorTriggers(errorMessage: string): DetectedTrigger[] {
    const triggers: DetectedTrigger[] = []
    for (const pattern of this.errorPatterns) {
      if (pattern.errorPattern.test(errorMessage)) {
        triggers.push({
          type: 'error',
          categories: pattern.skillCategories,
          confidence: pattern.confidence,
          reason: pattern.description,
          source: errorMessage.slice(0, 100),
        })
      }
    }
    return triggers
  }

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

  private deduplicateAndRank(triggers: DetectedTrigger[]): DetectedTrigger[] {
    const categoryMap = new Map<string, DetectedTrigger>()
    for (const trigger of triggers) {
      for (const category of trigger.categories) {
        const existing = categoryMap.get(category)
        if (!existing || trigger.confidence > existing.confidence) {
          categoryMap.set(category, trigger)
        }
      }
    }
    return Array.from(categoryMap.values()).sort((a, b) => b.confidence - a.confidence)
  }

  addFilePattern(trigger: FilePatternTrigger): void {
    this.filePatterns.push(trigger)
    log.debug('Added file pattern trigger', { pattern: trigger.pattern })
  }

  addCommandPattern(trigger: CommandTrigger): void {
    this.commandPatterns.push(trigger)
    log.debug('Added command trigger', { command: trigger.command })
  }

  addErrorPattern(trigger: ErrorTrigger): void {
    this.errorPatterns.push(trigger)
    log.debug('Added error trigger', { pattern: trigger.errorPattern })
  }

  addProjectPattern(trigger: ProjectTrigger): void {
    this.projectPatterns.push(trigger)
    log.debug('Added project trigger', { description: trigger.description })
  }
}

export default TriggerDetector
