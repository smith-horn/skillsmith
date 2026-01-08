/**
 * SMI-600: CodebaseAnalyzer
 * SMI-1189: Refactored to use extracted modules
 *
 * Analyzes TypeScript/JavaScript codebases to extract structure and patterns.
 * Uses TypeScript compiler API for accurate AST parsing.
 * Focuses on TS/JS only per ADR-010.
 *
 * @see ADR-010: Codebase Analysis Scope
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  SUPPORTED_EXTENSIONS,
  DEFAULT_EXCLUDE_DIRS,
  type ImportInfo,
  type ExportInfo,
  type FunctionInfo,
  type FrameworkInfo,
  type DependencyInfo,
  type CodebaseContext,
  type AnalyzeOptions,
} from './types.js'
import { parseFile } from './parsers.js'
import { detectFrameworks } from './framework-detector.js'

// Re-export types for backwards compatibility
export type {
  ImportInfo,
  ExportInfo,
  FunctionInfo,
  FrameworkInfo,
  DependencyInfo,
  CodebaseContext,
  AnalyzeOptions,
} from './types.js'

/**
 * CodebaseAnalyzer - Analyzes TypeScript/JavaScript codebases
 *
 * @example
 * const analyzer = new CodebaseAnalyzer();
 * const context = await analyzer.analyze('/path/to/project');
 * console.log(context.frameworks);
 */
export class CodebaseAnalyzer {
  private readonly version = '1.0.0'

  /**
   * Analyze a codebase and extract context for skill recommendations
   *
   * @param rootPath - Root directory of the codebase
   * @param options - Analysis options
   * @returns CodebaseContext with extracted information
   */
  async analyze(rootPath: string, options: AnalyzeOptions = {}): Promise<CodebaseContext> {
    const startTime = performance.now()

    const { maxFiles = 1000, excludeDirs = DEFAULT_EXCLUDE_DIRS, includeDevDeps = true } = options

    // Resolve to absolute path
    const absolutePath = path.resolve(rootPath)

    // Verify directory exists
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Directory not found: ${absolutePath}`)
    }

    // Find all source files
    const sourceFiles = this.findSourceFiles(absolutePath, excludeDirs, maxFiles)

    // Parse all files and extract information
    const imports: ImportInfo[] = []
    const exports: ExportInfo[] = []
    const functions: FunctionInfo[] = []
    const filesByExtension: Record<string, number> = {}
    let totalLines = 0

    for (const filePath of sourceFiles) {
      const ext = path.extname(filePath)
      filesByExtension[ext] = (filesByExtension[ext] || 0) + 1

      try {
        const content = fs.readFileSync(filePath, 'utf-8')
        totalLines += content.split('\n').length

        const relativePath = path.relative(absolutePath, filePath)
        const fileInfo = parseFile(content, relativePath)

        imports.push(...fileInfo.imports)
        exports.push(...fileInfo.exports)
        functions.push(...fileInfo.functions)
      } catch (error) {
        // Skip files that can't be read/parsed
        console.warn(`Failed to parse ${filePath}:`, error)
      }
    }

    // Read dependencies from package.json
    const dependencies = this.readDependencies(absolutePath, includeDevDeps)

    // Detect frameworks
    const frameworks = detectFrameworks(imports, dependencies)

    const endTime = performance.now()

    return {
      rootPath: absolutePath,
      imports,
      exports,
      functions,
      frameworks,
      dependencies,
      stats: {
        totalFiles: sourceFiles.length,
        filesByExtension,
        totalLines,
      },
      metadata: {
        durationMs: Math.round(endTime - startTime),
        version: this.version,
      },
    }
  }

  /**
   * Find all source files in directory
   */
  private findSourceFiles(dir: string, excludeDirs: string[], maxFiles: number): string[] {
    const files: string[] = []

    const walk = (currentDir: string): void => {
      if (files.length >= maxFiles) return

      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true })
      } catch {
        return // Skip directories we can't read
      }

      for (const entry of entries) {
        if (files.length >= maxFiles) break

        const fullPath = path.join(currentDir, entry.name)

        if (entry.isDirectory()) {
          // Skip excluded directories
          if (!excludeDirs.includes(entry.name)) {
            walk(fullPath)
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name)
          if (SUPPORTED_EXTENSIONS.includes(ext)) {
            files.push(fullPath)
          }
        }
      }
    }

    walk(dir)
    return files
  }

  /**
   * Read dependencies from package.json
   */
  private readDependencies(rootPath: string, includeDevDeps: boolean): DependencyInfo[] {
    const packageJsonPath = path.join(rootPath, 'package.json')
    const dependencies: DependencyInfo[] = []

    if (!fs.existsSync(packageJsonPath)) {
      return dependencies
    }

    try {
      const content = fs.readFileSync(packageJsonPath, 'utf-8')
      const pkg = JSON.parse(content) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }

      if (pkg.dependencies) {
        for (const [name, version] of Object.entries(pkg.dependencies)) {
          dependencies.push({ name, version, isDev: false })
        }
      }

      if (includeDevDeps && pkg.devDependencies) {
        for (const [name, version] of Object.entries(pkg.devDependencies)) {
          dependencies.push({ name, version, isDev: true })
        }
      }
    } catch {
      // Ignore parse errors
    }

    return dependencies
  }

  /**
   * Get a summary of the codebase for skill matching
   */
  getSummary(context: CodebaseContext): string {
    const parts: string[] = []

    // Frameworks
    if (context.frameworks.length > 0) {
      const topFrameworks = context.frameworks
        .slice(0, 5)
        .map((f) => f.name)
        .join(', ')
      parts.push(`Frameworks: ${topFrameworks}`)
    }

    // Top dependencies
    const prodDeps = context.dependencies
      .filter((d) => !d.isDev)
      .slice(0, 10)
      .map((d) => d.name)
    if (prodDeps.length > 0) {
      parts.push(`Dependencies: ${prodDeps.join(', ')}`)
    }

    // File stats
    parts.push(`Files: ${context.stats.totalFiles} (${context.stats.totalLines} lines)`)

    // Top extensions
    const extensions = Object.entries(context.stats.filesByExtension)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([ext, count]) => `${ext}: ${count}`)
    parts.push(`Types: ${extensions.join(', ')}`)

    return parts.join(' | ')
  }
}

export default CodebaseAnalyzer
