/**
 * SMI-600: Codebase Analysis Module
 *
 * Provides tools for analyzing TypeScript/JavaScript codebases
 * to extract context for skill recommendations.
 *
 * @see ADR-010: Codebase Analysis Scope
 */

export {
  CodebaseAnalyzer,
  type CodebaseContext,
  type ImportInfo,
  type ExportInfo,
  type FunctionInfo,
  type FrameworkInfo,
  type DependencyInfo,
  type AnalyzeOptions,
} from './CodebaseAnalyzer.js'
