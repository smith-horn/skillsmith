/**
 * SMI-600: Codebase Analysis Types
 * SMI-1189: Extracted from CodebaseAnalyzer.ts
 * SMI-1303: Extended with multi-language support
 *
 * Type definitions for multi-language codebase analysis.
 *
 * @see ADR-010: Codebase Analysis Scope
 * @see docs/architecture/multi-language-analysis.md
 * @module analysis/types
 */

/**
 * Supported languages for multi-language analysis
 */
export type SupportedLanguage = 'typescript' | 'javascript' | 'python' | 'go' | 'rust' | 'java'

/**
 * Supported file extensions for analysis (legacy, for backwards compatibility)
 */
export const SUPPORTED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']

/**
 * Multi-language file extensions mapping
 */
export const LANGUAGE_EXTENSIONS: Record<SupportedLanguage, string[]> = {
  typescript: ['.ts', '.tsx', '.mts', '.cts'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs'],
  python: ['.py', '.pyi', '.pyw'],
  go: ['.go'],
  rust: ['.rs'],
  java: ['.java'],
}

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
  '__pycache__',
  '.pytest_cache',
  'target',
  'vendor',
  'venv',
  '.venv',
  'env',
]

/**
 * Export kind enumeration (extended for multi-language)
 */
export type ExportKind =
  | 'function'
  | 'class'
  | 'variable'
  | 'type'
  | 'interface'
  | 'enum'
  | 'struct' // Go, Rust
  | 'trait' // Rust
  | 'module' // Python, Rust
  | 'unknown'

/**
 * Import information extracted from source files
 */
export interface ImportInfo {
  /** Module specifier (e.g., 'react', './utils', 'os') */
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
  /** Source language */
  language?: SupportedLanguage
  /** Line number */
  line?: number
}

/**
 * Export information extracted from source files
 */
export interface ExportInfo {
  /** Exported name */
  name: string
  /** Kind of export (function, class, variable, type, interface, etc.) */
  kind: ExportKind
  /** Whether this is a default export */
  isDefault: boolean
  /** Source file where export was found */
  sourceFile: string
  /** Source language */
  language?: SupportedLanguage
  /** Visibility (for Go, Rust, Java) */
  visibility?: 'public' | 'private' | 'protected' | 'internal'
  /** Line number */
  line?: number
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
  /** Source language */
  language?: SupportedLanguage
  /** Method receiver (Go) */
  receiver?: string
  /** Decorators (Python, Java) */
  decorators?: string[]
  /** Attributes (Rust) */
  attributes?: string[]
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
  /** Dependencies from all package managers */
  dependencies: DependencyInfo[]
  /** File statistics */
  stats: {
    /** Total files analyzed */
    totalFiles: number
    /** Files by extension */
    filesByExtension: Record<string, number>
    /** Files by language (optional for backward compatibility) */
    filesByLanguage?: Record<SupportedLanguage, number>
    /** Total lines of code (approximate) */
    totalLines: number
  }
  /** Analysis metadata */
  metadata: {
    /** Analysis duration in ms */
    durationMs: number
    /** Analyzer version */
    version: string
    /** Languages detected (optional for backward compatibility) */
    languages?: SupportedLanguage[]
    /** Cache hit rate (0-1, optional for backward compatibility) */
    cacheHitRate?: number
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

/**
 * Framework detection rule
 */
export interface FrameworkRule {
  /** Framework name */
  name: string
  /** Dependency indicators (package names) */
  depIndicators: string[]
  /** Import indicators (module specifiers) */
  importIndicators: string[]
}

/**
 * Cache statistics
 */
export interface CacheStats {
  /** Current size in bytes */
  size: number
  /** Number of entries */
  entries: number
  /** Maximum size in bytes */
  maxSize: number
  /** Cache hit rate (0-1) */
  hitRate: number
}
