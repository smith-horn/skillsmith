/**
 * SMI-600: Codebase Analysis Module
 * SMI-1189: Updated to export from split modules
 * SMI-1303: Extended with multi-language support
 *
 * Provides tools for analyzing multi-language codebases
 * to extract context for skill recommendations.
 *
 * @see ADR-010: Codebase Analysis Scope
 * @see docs/architecture/multi-language-analysis.md
 */

// Main analyzer class
export { CodebaseAnalyzer } from './CodebaseAnalyzer.js'
export { default } from './CodebaseAnalyzer.js'

// Types and constants (extended for multi-language support)
export {
  // Constants
  SUPPORTED_EXTENSIONS,
  DEFAULT_EXCLUDE_DIRS,
  LANGUAGE_EXTENSIONS,
  // Type definitions
  type SupportedLanguage,
  type ImportInfo,
  type ExportInfo,
  type ExportKind,
  type FunctionInfo,
  type FrameworkInfo,
  type FrameworkRule,
  type DependencyInfo,
  type CodebaseContext,
  type AnalyzeOptions,
  type ParseResult,
  type CacheStats,
} from './types.js'

// Parser functions
export { parseFile, extractImport, extractExport, extractFunction } from './parsers.js'

// Framework detection
export {
  detectFrameworks,
  hasFramework,
  getPrimaryFramework,
  FRAMEWORK_RULES,
} from './framework-detector.js'

// SMI-1303: Multi-language infrastructure

// Language router for dispatching to appropriate adapters
export { LanguageRouter, type LanguageRouterOptions } from './router.js'

// Parse result caching
export { ParseCache, type ParseCacheOptions } from './cache.js'

// Result aggregation
export { ResultAggregator, type AggregatorInput, type AggregatorMetadata } from './aggregator.js'

// Tree-sitter parser management
export {
  TreeSitterManager,
  type TreeSitterManagerOptions,
  type TreeSitterParser,
  type TreeSitterTree,
  type TreeSitterNode,
  type TreeSitterLanguage,
} from './tree-sitter/manager.js'

// Language adapters
export { LanguageAdapter, type LanguageInfo } from './adapters/base.js'

// Re-export specific adapters
export { TypeScriptAdapter } from './adapters/typescript.js'
export { PythonAdapter } from './adapters/python.js'
export {
  GoAdapter,
  parseGoMod,
  type GoModInfo,
  type GoExportInfo,
  type GoFunctionInfo,
} from './adapters/go.js'
export {
  RustAdapter,
  parseCargoToml,
  type RustExportInfo,
  type RustFunctionInfo,
  type CargoDependency,
} from './adapters/rust.js'
export {
  JavaAdapter,
  parsePomXml,
  parseBuildGradle,
  type JavaExportInfo,
  type JavaFunctionInfo,
  type MavenDependency,
} from './adapters/java.js'

// SMI-1308: Performance optimization modules

// Worker thread pool for parallel file parsing
export {
  ParserWorkerPool,
  type ParseTask,
  type WorkerResult,
  type WorkerPoolOptions,
} from './worker-pool.js'

// Memory usage monitoring and cleanup
export {
  MemoryMonitor,
  type MemoryStats,
  type CleanupResult,
  type MemoryMonitorOptions,
} from './memory-monitor.js'

// Memory-efficient file streaming
export {
  streamFiles,
  batchReadFiles,
  readFilesAsMap,
  filterByExtension,
  getFileExtension,
  estimateMemoryUsage,
  type FileContent,
  type StreamOptions,
  type BatchReadOptions,
} from './file-streamer.js'

// SMI-1309: Incremental Parsing & Tree Caching

// Edit tracking utilities
export {
  calculateEdit,
  indexToPosition,
  positionToIndex,
  findMinimalEdit,
  batchEdits,
  isInsertion,
  isDeletion,
  isReplacement,
  editSizeDelta,
  type Point,
  type FileEdit,
  type EditDiff,
} from './incremental.js'

// Tree caching for incremental parsing
export {
  TreeCache,
  type CachedTree,
  type TreeCacheStats,
  type TreeCacheOptions,
} from './tree-cache.js'

// Incremental parser coordinator
export {
  IncrementalParser,
  type IncrementalParseResult,
  type IncrementalParserOptions,
  type IncrementalParserStats,
} from './incremental-parser.js'
