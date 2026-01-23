/**
 * SMI-1340: Language Detection Heuristics
 *
 * Detects programming language of files without extensions using:
 * - Shebang analysis (#!/usr/bin/python, #!/bin/bash, etc.)
 * - Content patterns (import statements, syntax markers)
 * - Magic bytes detection
 * - Statistical analysis of keywords
 *
 * @see docs/architecture/multi-language-analysis.md
 * @module analysis/language-detector
 */

import type { SupportedLanguage } from './types.js'

// Import types
import type { LanguageDetectionResult, LanguageDetectorOptions } from './language-detector.types.js'

// Import patterns
import {
  SHEBANG_PATTERNS,
  CONTENT_PATTERNS,
  LANGUAGE_KEYWORDS,
} from './language-detector.patterns.js'

// Re-export types for public API
export type {
  LanguageDetectionResult,
  LanguageDetectorOptions,
  ContentPattern,
  ShebangPattern,
} from './language-detector.types.js'

// Re-export patterns for testing/extension
export {
  SHEBANG_PATTERNS,
  CONTENT_PATTERNS,
  LANGUAGE_KEYWORDS,
} from './language-detector.patterns.js'

/**
 * Detects programming language from file content
 *
 * Uses multiple heuristics in order of reliability:
 * 1. Shebang analysis (highest confidence)
 * 2. Content patterns (high confidence)
 * 3. Statistical keyword analysis (lower confidence)
 *
 * @example
 * ```typescript
 * const detector = new LanguageDetector()
 *
 * // Detect from shebang
 * const result1 = detector.detect('#!/usr/bin/env python3\nprint("hello")')
 * // { language: 'python', confidence: 1.0, method: 'shebang', evidence: ['shebang: #!/usr/bin/env python3'] }
 *
 * // Detect from patterns
 * const result2 = detector.detect('fn main() {\n    println!("Hello");\n}')
 * // { language: 'rust', confidence: 0.85, method: 'pattern', evidence: ['function definition'] }
 * ```
 */
export class LanguageDetector {
  /** Minimum confidence threshold for detection */
  private minConfidence: number

  constructor(options: LanguageDetectorOptions = {}) {
    this.minConfidence = options.minConfidence ?? 0.3
  }

  /**
   * Detect language from file content
   *
   * @param content - File content to analyze
   * @returns Detection result with language, confidence, and evidence
   */
  detect(content: string): LanguageDetectionResult {
    // Try shebang first (highest confidence)
    const shebangResult = this.detectByShebang(content)
    if (shebangResult.language && shebangResult.confidence >= this.minConfidence) {
      return shebangResult
    }

    // Try content patterns
    const patternResult = this.detectByPatterns(content)
    if (patternResult.language && patternResult.confidence >= this.minConfidence) {
      return patternResult
    }

    // Fall back to statistical analysis
    const statisticalResult = this.detectByStatistics(content)
    if (statisticalResult.language && statisticalResult.confidence >= this.minConfidence) {
      return statisticalResult
    }

    // No confident detection
    return {
      language: null,
      confidence: 0,
      method: 'none',
      evidence: [],
    }
  }

  /**
   * Detect language from shebang line
   */
  detectByShebang(content: string): LanguageDetectionResult {
    const firstLine = content.split('\n')[0]?.trim() ?? ''

    if (!firstLine.startsWith('#!')) {
      return { language: null, confidence: 0, method: 'shebang', evidence: [] }
    }

    for (const { pattern, language } of SHEBANG_PATTERNS) {
      if (pattern.test(firstLine)) {
        return {
          language,
          confidence: 1.0,
          method: 'shebang',
          evidence: [`shebang: ${firstLine}`],
        }
      }
    }

    return { language: null, confidence: 0, method: 'shebang', evidence: [] }
  }

  /**
   * Detect language from content patterns
   */
  detectByPatterns(content: string): LanguageDetectionResult {
    const scores = new Map<SupportedLanguage, { score: number; evidence: string[] }>()

    for (const { pattern, language, weight, description } of CONTENT_PATTERNS) {
      if (pattern.test(content)) {
        const current = scores.get(language) ?? { score: 0, evidence: [] }
        current.score += weight
        current.evidence.push(description)
        scores.set(language, current)
      }
    }

    // Find best match
    let bestLanguage: SupportedLanguage | null = null
    let bestScore = 0
    let bestEvidence: string[] = []

    for (const [language, { score, evidence }] of scores) {
      if (score > bestScore) {
        bestScore = score
        bestLanguage = language
        bestEvidence = evidence
      }
    }

    // Normalize confidence to 0-1 range (cap at 1.0)
    const confidence = Math.min(bestScore / 3, 1.0)

    // Upgrade JavaScript to TypeScript if TypeScript-specific patterns found
    if (bestLanguage === 'javascript') {
      const tsScore = scores.get('typescript')?.score ?? 0
      if (tsScore > 0) {
        bestLanguage = 'typescript'
        bestEvidence = [...bestEvidence, ...(scores.get('typescript')?.evidence ?? [])]
      }
    }

    return {
      language: bestLanguage,
      confidence,
      method: 'pattern',
      evidence: bestEvidence.slice(0, 5), // Limit evidence
    }
  }

  /**
   * Detect language by statistical keyword analysis
   */
  detectByStatistics(content: string): LanguageDetectionResult {
    const contentLower = content.toLowerCase()
    const words = contentLower.split(/\W+/).filter((w) => w.length > 1)
    const wordSet = new Set(words)
    const wordCount = words.length

    if (wordCount === 0) {
      return { language: null, confidence: 0, method: 'statistical', evidence: [] }
    }

    const scores = new Map<SupportedLanguage, { matches: number; keywords: string[] }>()

    for (const [language, keywords] of Object.entries(LANGUAGE_KEYWORDS) as [
      SupportedLanguage,
      string[],
    ][]) {
      const matchedKeywords: string[] = []

      for (const keyword of keywords) {
        if (wordSet.has(keyword.toLowerCase())) {
          matchedKeywords.push(keyword)
        }
      }

      if (matchedKeywords.length > 0) {
        scores.set(language, {
          matches: matchedKeywords.length,
          keywords: matchedKeywords,
        })
      }
    }

    // Find best match with highest keyword density
    let bestLanguage: SupportedLanguage | null = null
    let bestScore = 0
    let bestKeywords: string[] = []

    for (const [language, { matches, keywords }] of scores) {
      // Normalize by total keyword count for fairness
      const normalizedScore = matches / LANGUAGE_KEYWORDS[language].length
      if (normalizedScore > bestScore) {
        bestScore = normalizedScore
        bestLanguage = language
        bestKeywords = keywords
      }
    }

    // Lower confidence for statistical method
    const confidence = Math.min(bestScore * 2, 0.7)

    return {
      language: bestLanguage,
      confidence,
      method: 'statistical',
      evidence: bestKeywords.slice(0, 5).map((k) => `keyword: ${k}`),
    }
  }

  /**
   * Get confidence threshold
   */
  getMinConfidence(): number {
    return this.minConfidence
  }

  /**
   * Set confidence threshold
   */
  setMinConfidence(threshold: number): void {
    this.minConfidence = Math.max(0, Math.min(1, threshold))
  }
}

/**
 * Convenience function to detect language
 *
 * @param content - File content to analyze
 * @param options - Detection options
 * @returns Detection result
 */
export function detectLanguage(
  content: string,
  options?: LanguageDetectorOptions
): LanguageDetectionResult {
  const detector = new LanguageDetector(options)
  return detector.detect(content)
}
