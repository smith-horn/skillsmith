/**
 * SMI-600: CodebaseAnalyzer
 * Analyzes TypeScript/JavaScript codebases to extract structure and patterns.
 *
 * Uses TypeScript compiler API for accurate AST parsing.
 * Focuses on TS/JS only per ADR-010.
 *
 * @see ADR-010: Codebase Analysis Scope
 */

import * as ts from 'typescript'
import * as fs from 'fs'
import * as path from 'path'

/**
 * Supported file extensions for analysis
 */
const SUPPORTED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']

/**
 * Import information extracted from source files
 */
export interface ImportInfo {
  /** Module specifier (e.g., 'react', './utils') */
  module: string
  /** Named imports (e.g., ['useState', 'useEffect']) */
  namedImports: string[]
  /** Default import name if present */
  defaultImport?: string
  /** Namespace import name if present (import * as X) */
  namespaceImport?: string
  /** Whether this is a type-only import */
  isTypeOnly: boolean
  /** Source file where import was found */
  sourceFile: string
}

/**
 * Export information extracted from source files
 */
export interface ExportInfo {
  /** Exported name */
  name: string
  /** Kind of export (function, class, variable, type, interface) */
  kind: 'function' | 'class' | 'variable' | 'type' | 'interface' | 'enum' | 'unknown'
  /** Whether this is a default export */
  isDefault: boolean
  /** Source file where export was found */
  sourceFile: string
}

/**
 * Function information extracted from source files
 */
export interface FunctionInfo {
  /** Function name */
  name: string
  /** Number of parameters */
  parameterCount: number
  /** Whether function is async */
  isAsync: boolean
  /** Whether function is exported */
  isExported: boolean
  /** Source file where function was found */
  sourceFile: string
  /** Line number */
  line: number
}

/**
 * Detected framework information
 */
export interface FrameworkInfo {
  /** Framework name */
  name: string
  /** Confidence level (0-1) */
  confidence: number
  /** Evidence for detection */
  evidence: string[]
}

/**
 * Package.json dependency information
 */
export interface DependencyInfo {
  /** Package name */
  name: string
  /** Version specifier */
  version: string
  /** Whether this is a dev dependency */
  isDev: boolean
}

/**
 * Complete codebase context for skill recommendations
 */
export interface CodebaseContext {
  /** Root directory analyzed */
  rootPath: string
  /** All imports found in the codebase */
  imports: ImportInfo[]
  /** All exports found in the codebase */
  exports: ExportInfo[]
  /** All functions found in the codebase */
  functions: FunctionInfo[]
  /** Detected frameworks */
  frameworks: FrameworkInfo[]
  /** Dependencies from package.json */
  dependencies: DependencyInfo[]
  /** File statistics */
  stats: {
    /** Total files analyzed */
    totalFiles: number
    /** Files by extension */
    filesByExtension: Record<string, number>
    /** Total lines of code (approximate) */
    totalLines: number
  }
  /** Analysis metadata */
  metadata: {
    /** Analysis duration in ms */
    durationMs: number
    /** Analyzer version */
    version: string
  }
}

/**
 * Options for codebase analysis
 */
export interface AnalyzeOptions {
  /** Maximum files to analyze (default: 1000) */
  maxFiles?: number
  /** Directories to exclude (default: node_modules, dist, .git) */
  excludeDirs?: string[]
  /** Include dev dependencies in analysis */
  includeDevDeps?: boolean
}

const DEFAULT_EXCLUDE_DIRS = ['node_modules', 'dist', 'build', '.git', 'coverage', '.next', '.nuxt']

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
        const fileInfo = this.parseFile(content, relativePath)

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
    const frameworks = this.detectFrameworks(imports, dependencies)

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
   * Parse a single file and extract information
   */
  private parseFile(
    content: string,
    relativePath: string
  ): { imports: ImportInfo[]; exports: ExportInfo[]; functions: FunctionInfo[] } {
    const imports: ImportInfo[] = []
    const exports: ExportInfo[] = []
    const functions: FunctionInfo[] = []

    // Create source file
    const sourceFile = ts.createSourceFile(
      relativePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      relativePath.endsWith('.tsx') || relativePath.endsWith('.jsx')
        ? ts.ScriptKind.TSX
        : ts.ScriptKind.TS
    )

    // Walk the AST
    const visit = (node: ts.Node): void => {
      // Import declarations
      if (ts.isImportDeclaration(node)) {
        const importInfo = this.extractImport(node, relativePath)
        if (importInfo) {
          imports.push(importInfo)
        }
      }

      // Export declarations
      if (ts.isExportDeclaration(node) || ts.isExportAssignment(node)) {
        const exportInfos = this.extractExport(node, relativePath)
        exports.push(...exportInfos)
      }

      // Function declarations
      if (ts.isFunctionDeclaration(node) && node.name) {
        const funcInfo = this.extractFunction(node, relativePath, sourceFile)
        if (funcInfo) {
          functions.push(funcInfo)

          // Also track as export if exported
          if (funcInfo.isExported) {
            const isDefault = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
            exports.push({
              name: node.name.text,
              kind: 'function',
              isDefault: isDefault ?? false,
              sourceFile: relativePath,
            })
          }
        }
      }

      // Arrow functions assigned to variables
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (
            decl.initializer &&
            ts.isArrowFunction(decl.initializer) &&
            ts.isIdentifier(decl.name)
          ) {
            const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
            const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
            functions.push({
              name: decl.name.text,
              parameterCount: decl.initializer.parameters.length,
              isAsync:
                decl.initializer.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ??
                false,
              isExported: isExported ?? false,
              sourceFile: relativePath,
              line: line + 1,
            })

            // Also track as export if exported
            if (isExported) {
              exports.push({
                name: decl.name.text,
                kind: 'function',
                isDefault: false,
                sourceFile: relativePath,
              })
            }
          }
        }
      }

      // Class declarations
      if (ts.isClassDeclaration(node) && node.name) {
        const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
        const isDefault = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)

        if (isExported) {
          exports.push({
            name: node.name.text,
            kind: 'class',
            isDefault: isDefault ?? false,
            sourceFile: relativePath,
          })
        }
      }

      // Interface declarations
      if (ts.isInterfaceDeclaration(node)) {
        const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)

        if (isExported) {
          exports.push({
            name: node.name.text,
            kind: 'interface',
            isDefault: false,
            sourceFile: relativePath,
          })
        }
      }

      // Type alias declarations
      if (ts.isTypeAliasDeclaration(node)) {
        const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)

        if (isExported) {
          exports.push({
            name: node.name.text,
            kind: 'type',
            isDefault: false,
            sourceFile: relativePath,
          })
        }
      }

      ts.forEachChild(node, visit)
    }

    visit(sourceFile)

    return { imports, exports, functions }
  }

  /**
   * Extract import information from an import declaration
   */
  private extractImport(node: ts.ImportDeclaration, sourceFile: string): ImportInfo | null {
    const moduleSpecifier = node.moduleSpecifier
    if (!ts.isStringLiteral(moduleSpecifier)) {
      return null
    }

    const importInfo: ImportInfo = {
      module: moduleSpecifier.text,
      namedImports: [],
      isTypeOnly: node.importClause?.isTypeOnly ?? false,
      sourceFile,
    }

    const importClause = node.importClause
    if (importClause) {
      // Default import
      if (importClause.name) {
        importInfo.defaultImport = importClause.name.text
      }

      // Named imports
      const namedBindings = importClause.namedBindings
      if (namedBindings) {
        if (ts.isNamespaceImport(namedBindings)) {
          importInfo.namespaceImport = namedBindings.name.text
        } else if (ts.isNamedImports(namedBindings)) {
          for (const element of namedBindings.elements) {
            importInfo.namedImports.push(element.name.text)
          }
        }
      }
    }

    return importInfo
  }

  /**
   * Extract export information from an export declaration
   */
  private extractExport(
    node: ts.ExportDeclaration | ts.ExportAssignment,
    sourceFile: string
  ): ExportInfo[] {
    const exports: ExportInfo[] = []

    if (ts.isExportAssignment(node)) {
      // export default X
      exports.push({
        name: 'default',
        kind: 'unknown',
        isDefault: true,
        sourceFile,
      })
    } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
      // export { X, Y }
      for (const element of node.exportClause.elements) {
        exports.push({
          name: element.name.text,
          kind: 'unknown',
          isDefault: false,
          sourceFile,
        })
      }
    }

    return exports
  }

  /**
   * Extract function information from a function declaration
   */
  private extractFunction(
    node: ts.FunctionDeclaration,
    relativePath: string,
    sourceFile: ts.SourceFile
  ): FunctionInfo | null {
    if (!node.name) return null

    const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    const isAsync = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)

    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())

    return {
      name: node.name.text,
      parameterCount: node.parameters.length,
      isAsync: isAsync ?? false,
      isExported: isExported ?? false,
      sourceFile: relativePath,
      line: line + 1,
    }
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
   * Detect frameworks based on imports and dependencies
   */
  private detectFrameworks(imports: ImportInfo[], dependencies: DependencyInfo[]): FrameworkInfo[] {
    const frameworks: FrameworkInfo[] = []
    const depNames = new Set(dependencies.map((d) => d.name))
    const importModules = new Set(imports.map((i) => i.module))

    // Framework detection rules
    const frameworkRules: Array<{
      name: string
      depIndicators: string[]
      importIndicators: string[]
    }> = [
      {
        name: 'React',
        depIndicators: ['react', 'react-dom'],
        importIndicators: ['react', 'react-dom'],
      },
      {
        name: 'Next.js',
        depIndicators: ['next'],
        importIndicators: ['next', 'next/router', 'next/link', 'next/image'],
      },
      {
        name: 'Vue',
        depIndicators: ['vue'],
        importIndicators: ['vue'],
      },
      {
        name: 'Nuxt',
        depIndicators: ['nuxt'],
        importIndicators: ['nuxt', '#app', '#imports'],
      },
      {
        name: 'Angular',
        depIndicators: ['@angular/core'],
        importIndicators: ['@angular/core', '@angular/common'],
      },
      {
        name: 'Express',
        depIndicators: ['express'],
        importIndicators: ['express'],
      },
      {
        name: 'Fastify',
        depIndicators: ['fastify'],
        importIndicators: ['fastify'],
      },
      {
        name: 'NestJS',
        depIndicators: ['@nestjs/core'],
        importIndicators: ['@nestjs/core', '@nestjs/common'],
      },
      {
        name: 'Jest',
        depIndicators: ['jest'],
        importIndicators: ['@jest/globals', 'jest'],
      },
      {
        name: 'Vitest',
        depIndicators: ['vitest'],
        importIndicators: ['vitest'],
      },
      {
        name: 'Playwright',
        depIndicators: ['@playwright/test', 'playwright'],
        importIndicators: ['@playwright/test', 'playwright'],
      },
      {
        name: 'Prisma',
        depIndicators: ['@prisma/client', 'prisma'],
        importIndicators: ['@prisma/client'],
      },
      {
        name: 'TypeORM',
        depIndicators: ['typeorm'],
        importIndicators: ['typeorm'],
      },
      {
        name: 'Tailwind CSS',
        depIndicators: ['tailwindcss'],
        importIndicators: [],
      },
      {
        name: 'Electron',
        depIndicators: ['electron'],
        importIndicators: ['electron'],
      },
    ]

    for (const rule of frameworkRules) {
      const evidence: string[] = []

      // Check dependencies
      for (const dep of rule.depIndicators) {
        if (depNames.has(dep)) {
          evidence.push(`Dependency: ${dep}`)
        }
      }

      // Check imports
      for (const imp of rule.importIndicators) {
        if (importModules.has(imp)) {
          evidence.push(`Import: ${imp}`)
        }
      }

      if (evidence.length > 0) {
        // Calculate confidence based on evidence
        const confidence = Math.min(1, evidence.length * 0.4)
        frameworks.push({
          name: rule.name,
          confidence,
          evidence,
        })
      }
    }

    // Sort by confidence
    frameworks.sort((a, b) => b.confidence - a.confidence)

    return frameworks
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
