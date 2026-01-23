/**
 * Language Detector Types
 * @module analysis/language-detector.types
 */

import type { SupportedLanguage } from './types.js'

/**
 * Detection result with confidence score
 */
export interface LanguageDetectionResult {
  /** Detected language (null if unknown) */
  language: SupportedLanguage | null
  /** Confidence score (0-1) */
  confidence: number
  /** Detection method that succeeded */
  method: 'shebang' | 'pattern' | 'magic' | 'statistical' | 'none'
  /** Evidence for the detection */
  evidence: string[]
}

/**
 * Content patterns for language detection
 */
export interface ContentPattern {
  /** Regular expression to match */
  pattern: RegExp
  /** Language this pattern indicates */
  language: SupportedLanguage
  /** Confidence boost for this pattern (0-1) */
  weight: number
  /** Description of what this pattern matches */
  description: string
}

/**
 * Shebang pattern entry
 */
export interface ShebangPattern {
  /** Regular expression to match shebang */
  pattern: RegExp
  /** Language this shebang indicates */
  language: SupportedLanguage
}

/**
 * Options for language detection
 */
export interface LanguageDetectorOptions {
  /** Minimum confidence threshold for detection (0-1) */
  minConfidence?: number
}
