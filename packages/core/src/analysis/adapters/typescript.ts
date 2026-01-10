/**
 * SMI-1310: TypeScript Language Adapter
 *
 * TypeScript/JavaScript adapter using the existing TypeScript compiler API.
 * Falls back to tree-sitter for incremental parsing (SMI-1309).
 *
 * @see docs/architecture/multi-language-analysis.md
 */

import { LanguageAdapter, type SupportedLanguage } from './base.js'
import { parseFile as tsParseFile } from '../parsers.js'
import { FRAMEWORK_RULES, type FrameworkRule } from '../framework-detector.js'
import type { ParseResult } from '../types.js'

/**
 * TypeScript/JavaScript adapter
 *
 * Uses the existing TypeScript compiler API for maximum accuracy.
 * Falls back to tree-sitter for incremental parsing.
 *
 * @example
 * const adapter = new TypeScriptAdapter()
 * const result = adapter.parseFile(content, 'src/index.ts')
 * console.log(result.imports)
 */
export class TypeScriptAdapter extends LanguageAdapter {
  /** Language identifier */
  readonly language: SupportedLanguage = 'typescript'

  /** Supported file extensions */
  readonly extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']

  /**
   * Parse a file using TypeScript compiler API
   *
   * Uses the existing parseFile function from parsers.ts
   * for maximum accuracy and backward compatibility.
   *
   * @param content - File content to parse
   * @param filePath - Relative path for source file tracking
   * @returns Parsed imports, exports, and functions
   */
  parseFile(content: string, filePath: string): ParseResult {
    return tsParseFile(content, filePath)
  }

  /**
   * Parse file incrementally
   *
   * Currently delegates to full parse. Tree-sitter incremental
   * parsing will be implemented in SMI-1309.
   *
   * @param content - Updated content
   * @param filePath - File path
   * @param _previousTree - Previous parse tree (unused until SMI-1309)
   * @returns Updated parse result
   */
  parseIncremental(content: string, filePath: string, _previousTree?: unknown): ParseResult {
    // For now, delegate to full parse
    // Incremental parsing via tree-sitter will be added in SMI-1309
    return this.parseFile(content, filePath)
  }

  /**
   * Get TypeScript/JavaScript framework detection rules
   *
   * Returns the existing FRAMEWORK_RULES from framework-detector.ts
   * for backward compatibility.
   *
   * @returns Array of framework detection rules
   */
  getFrameworkRules(): FrameworkRule[] {
    return FRAMEWORK_RULES
  }

  /**
   * Clean up resources
   *
   * No resources to clean up for TypeScript compiler API.
   * Tree-sitter parser cleanup will be added in SMI-1309.
   */
  dispose(): void {
    // No resources to clean up for TS compiler API
    // Tree-sitter parser cleanup will be added in SMI-1309
  }
}
