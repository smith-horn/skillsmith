/**
 * SMI-600: Codebase Analysis Types
 * SMI-1189: Extracted from CodebaseAnalyzer.ts
 *
 * Type definitions for codebase analysis functionality.
 *
 * @see ADR-010: Codebase Analysis Scope
 */

/**
 * Supported file extensions for analysis
 */
export const SUPPORTED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']

/**
 * Default directories to exclude from analysis
 */
export const DEFAULT_EXCLUDE_DIRS = [
  'node_modules',
  'dist',
  'build',
  '.git',
  'coverage',
  '.next',
  '.nuxt',
]

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

/**
 * Result of parsing a single file
 */
export interface ParseResult {
  imports: ImportInfo[]
  exports: ExportInfo[]
  functions: FunctionInfo[]
}
