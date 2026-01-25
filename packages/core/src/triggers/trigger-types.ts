/**
 * Type definitions for TriggerDetector
 * @module @skillsmith/core/triggers/trigger-types
 */

import type { CodebaseContext } from '../analysis/CodebaseAnalyzer.js'

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
