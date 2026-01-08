/**
 * SMI-600: Codebase Analysis Module
 * SMI-1189: Updated to export from split modules
 *
 * Provides tools for analyzing TypeScript/JavaScript codebases
 * to extract context for skill recommendations.
 *
 * @see ADR-010: Codebase Analysis Scope
 */

// Main analyzer class
export { CodebaseAnalyzer } from './CodebaseAnalyzer.js'
export { default } from './CodebaseAnalyzer.js'

// Types and constants
export {
  SUPPORTED_EXTENSIONS,
  DEFAULT_EXCLUDE_DIRS,
  type ImportInfo,
  type ExportInfo,
  type FunctionInfo,
  type FrameworkInfo,
  type DependencyInfo,
  type CodebaseContext,
  type AnalyzeOptions,
  type ParseResult,
} from './types.js'

// Parser functions
export { parseFile, extractImport, extractExport, extractFunction } from './parsers.js'

// Framework detection
export {
  detectFrameworks,
  hasFramework,
  getPrimaryFramework,
  FRAMEWORK_RULES,
  type FrameworkRule,
} from './framework-detector.js'
