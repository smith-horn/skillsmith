/**
 * SMI-1303: Language Adapter Base Class
 *
 * Abstract base class for language-specific adapters.
 * Each adapter translates language-specific AST nodes into
 * the unified ParseResult format.
 *
 * @see docs/architecture/multi-language-analysis.md
 * @module analysis/adapters/base
 */

import * as path from 'path'
import type {
  SupportedLanguage,
  ParseResult,
  FrameworkRule,
  ImportInfo,
  ExportInfo,
  FunctionInfo,
} from '../types.js'

// Re-export types for convenience
export type { SupportedLanguage, ParseResult, FrameworkRule, ImportInfo, ExportInfo, FunctionInfo }

/**
 * Language detection result
 */
export interface LanguageInfo {
  /** Language identifier */
  language: SupportedLanguage
  /** File extensions for this language */
  extensions: string[]
  /** Confidence level (0-1) */
  confidence: number
}

/**
 * Abstract base class for language-specific adapters
 *
 * Each adapter translates language-specific AST nodes into
 * the unified ParseResult format.
 *
 * @example
 * class TypeScriptAdapter extends LanguageAdapter {
 *   readonly language = 'typescript'
 *   readonly extensions = ['.ts', '.tsx']
 *
 *   parseFile(content: string, filePath: string): ParseResult {
 *     // Parse using TypeScript compiler API
 *   }
 * }
 */
export abstract class LanguageAdapter {
  /** Language this adapter handles */
  abstract readonly language: SupportedLanguage

  /** File extensions this adapter handles */
  abstract readonly extensions: string[]

  /**
   * Check if this adapter can handle a file
   *
   * @param filePath - Path to the file
   * @returns True if this adapter can handle the file
   */
  canHandle(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase()
    return this.extensions.includes(ext)
  }

  /**
   * Parse a single file and extract information
   *
   * @param content - File content to parse
   * @param filePath - Relative path for tracking
   * @returns Parsed imports, exports, and functions
   */
  abstract parseFile(content: string, filePath: string): ParseResult

  /**
   * Parse file incrementally (for editor integration)
   *
   * Uses tree-sitter for faster incremental updates when
   * a previous parse tree is available.
   *
   * @param content - Updated content
   * @param filePath - File path
   * @param previousTree - Previous parse tree for incremental update
   * @returns Updated parse result
   */
  abstract parseIncremental(content: string, filePath: string, previousTree?: unknown): ParseResult

  /**
   * Get language-specific framework detection rules
   *
   * @returns Array of framework detection rules
   */
  abstract getFrameworkRules(): FrameworkRule[]

  /**
   * Clean up any resources (parser instances, etc.)
   */
  abstract dispose(): void
}
