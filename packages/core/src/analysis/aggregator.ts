/**
 * SMI-1303: Result Aggregator
 *
 * Aggregates parse results from multiple languages into unified context.
 * Collects imports, exports, and functions across all analyzed files.
 *
 * @see docs/architecture/multi-language-analysis.md
 * @module analysis/aggregator
 */

import path from 'path'
import type {
  SupportedLanguage,
  ImportInfo,
  ExportInfo,
  FunctionInfo,
  ParseResult,
  CodebaseContext,
  FrameworkInfo,
  DependencyInfo,
} from './types.js'

/**
 * Input for adding a parse result to the aggregator
 */
export interface AggregatorInput {
  /** Path to the parsed file */
  filePath: string
  /** Language of the file */
  language: SupportedLanguage
  /** Parse result from the adapter */
  result: ParseResult
}

/**
 * Metadata for building the final context
 */
export interface AggregatorMetadata {
  /** Analysis duration in milliseconds */
  durationMs: number
  /** Analyzer version string */
  version: string
  /** Cache hit rate (0-1) */
  cacheHitRate: number
}

/**
 * Aggregates parse results from multiple languages into unified context
 *
 * Collects results from individual file parses and merges them
 * into a single CodebaseContext for skill recommendations.
 *
 * @example
 * ```typescript
 * const aggregator = new ResultAggregator()
 *
 * // Add results as files are parsed
 * aggregator.add({
 *   filePath: 'src/main.py',
 *   language: 'python',
 *   result: pythonAdapter.parseFile(content, 'src/main.py')
 * })
 *
 * aggregator.add({
 *   filePath: 'src/index.ts',
 *   language: 'typescript',
 *   result: tsAdapter.parseFile(content, 'src/index.ts')
 * })
 *
 * // Build final context
 * const context = aggregator.build('/path/to/project', dependencies, frameworks, metadata)
 * ```
 */
export class ResultAggregator {
  private imports: ImportInfo[] = []
  private exports: ExportInfo[] = []
  private functions: FunctionInfo[] = []
  private filesByExtension: Record<string, number> = {}
  private filesByLanguage: Partial<Record<SupportedLanguage, number>> = {}
  private totalLines = 0
  private languages = new Set<SupportedLanguage>()
  private fileCount = 0

  /**
   * Add parse result to aggregation
   *
   * Extracts imports, exports, and functions from the result
   * and annotates them with language information.
   *
   * @param input - File path, language, and parse result
   *
   * @example
   * ```typescript
   * aggregator.add({
   *   filePath: 'src/utils.py',
   *   language: 'python',
   *   result: adapter.parseFile(content, 'src/utils.py')
   * })
   * ```
   */
  add(input: AggregatorInput): void {
    const { filePath, language, result } = input

    // Track language
    this.languages.add(language)
    this.filesByLanguage[language] = (this.filesByLanguage[language] ?? 0) + 1
    this.fileCount++

    // Track extension
    const ext = path.extname(filePath).toLowerCase()
    if (ext) {
      this.filesByExtension[ext] = (this.filesByExtension[ext] ?? 0) + 1
    }

    // Add imports with language annotation
    for (const imp of result.imports) {
      this.imports.push({
        ...imp,
        language,
        sourceFile: filePath,
      })
    }

    // Add exports with language annotation
    for (const exp of result.exports) {
      this.exports.push({
        ...exp,
        language,
        sourceFile: filePath,
      })
    }

    // Add functions with language annotation
    for (const func of result.functions) {
      this.functions.push({
        ...func,
        language,
        sourceFile: filePath,
      })
    }
  }

  /**
   * Add line count for a file
   *
   * Call this separately from add() if line counting is done
   * during file reading rather than parsing.
   *
   * @param count - Number of lines in the file
   */
  addLines(count: number): void {
    this.totalLines += count
  }

  /**
   * Get current imports (read-only)
   */
  getImports(): readonly ImportInfo[] {
    return this.imports
  }

  /**
   * Get current exports (read-only)
   */
  getExports(): readonly ExportInfo[] {
    return this.exports
  }

  /**
   * Get current functions (read-only)
   */
  getFunctions(): readonly FunctionInfo[] {
    return this.functions
  }

  /**
   * Get current file count
   */
  getFileCount(): number {
    return this.fileCount
  }

  /**
   * Get detected languages
   */
  getLanguages(): SupportedLanguage[] {
    return Array.from(this.languages)
  }

  /**
   * Build final CodebaseContext
   *
   * Combines all aggregated data with dependencies, frameworks,
   * and metadata into the final context structure.
   *
   * @param rootPath - Root path of the analyzed codebase
   * @param dependencies - Dependencies from all package managers
   * @param frameworks - Detected frameworks
   * @param metadata - Analysis metadata
   * @returns Complete codebase context
   *
   * @example
   * ```typescript
   * const context = aggregator.build(
   *   '/path/to/project',
   *   dependencies,
   *   frameworks,
   *   { durationMs: 1234, version: '2.0.0', cacheHitRate: 0.85 }
   * )
   * ```
   */
  build(
    rootPath: string,
    dependencies: DependencyInfo[],
    frameworks: FrameworkInfo[],
    metadata: AggregatorMetadata
  ): CodebaseContext {
    return {
      rootPath,
      imports: this.imports,
      exports: this.exports,
      functions: this.functions,
      frameworks,
      dependencies,
      stats: {
        totalFiles: this.fileCount,
        filesByExtension: { ...this.filesByExtension },
        filesByLanguage: this.buildLanguageStats(),
        totalLines: this.totalLines,
      },
      metadata: {
        durationMs: metadata.durationMs,
        version: metadata.version,
        languages: Array.from(this.languages),
        cacheHitRate: metadata.cacheHitRate,
      },
    }
  }

  /**
   * Build language stats with all languages initialized to 0
   */
  private buildLanguageStats(): Record<SupportedLanguage, number> {
    const stats: Record<SupportedLanguage, number> = {
      typescript: 0,
      javascript: 0,
      python: 0,
      go: 0,
      rust: 0,
      java: 0,
    }

    for (const [lang, count] of Object.entries(this.filesByLanguage)) {
      stats[lang as SupportedLanguage] = count
    }

    return stats
  }

  /**
   * Reset aggregator for new analysis
   *
   * Clears all collected data. Call this before starting
   * a new analysis on a different codebase.
   */
  reset(): void {
    this.imports = []
    this.exports = []
    this.functions = []
    this.filesByExtension = {}
    this.filesByLanguage = {}
    this.totalLines = 0
    this.languages.clear()
    this.fileCount = 0
  }

  /**
   * Merge another aggregator's results into this one
   *
   * Useful for parallel processing where each worker
   * has its own aggregator.
   *
   * @param other - Aggregator to merge from
   */
  merge(other: ResultAggregator): void {
    this.imports.push(...other.imports)
    this.exports.push(...other.exports)
    this.functions.push(...other.functions)
    this.totalLines += other.totalLines
    this.fileCount += other.fileCount

    // Merge extension counts
    for (const [ext, count] of Object.entries(other.filesByExtension)) {
      this.filesByExtension[ext] = (this.filesByExtension[ext] ?? 0) + count
    }

    // Merge language counts
    for (const [lang, count] of Object.entries(other.filesByLanguage)) {
      const typedLang = lang as SupportedLanguage
      this.filesByLanguage[typedLang] = (this.filesByLanguage[typedLang] ?? 0) + count
      this.languages.add(typedLang)
    }
  }

  /**
   * Get summary statistics
   */
  getSummary(): {
    files: number
    imports: number
    exports: number
    functions: number
    lines: number
    languages: SupportedLanguage[]
  } {
    return {
      files: this.fileCount,
      imports: this.imports.length,
      exports: this.exports.length,
      functions: this.functions.length,
      lines: this.totalLines,
      languages: Array.from(this.languages),
    }
  }
}
