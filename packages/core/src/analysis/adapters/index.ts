/**
 * SMI-1303, SMI-1310: Language Adapters Module
 *
 * Exports all language adapter classes and types for multi-language
 * codebase analysis.
 *
 * @see docs/architecture/multi-language-analysis.md
 */

// Base adapter class and types
export {
  LanguageAdapter,
  type SupportedLanguage,
  type LanguageInfo,
  type FrameworkRule,
  type ParseResult,
} from './base.js'

// Language-specific adapters
export { TypeScriptAdapter } from './typescript.js'
export { PythonAdapter } from './python.js'

// SMI-1305: Go Language Adapter
export { GoAdapter, parseGoMod } from './go.js'
export type { GoExportInfo, GoFunctionInfo, GoModInfo } from './go.js'

// SMI-1306: Rust Language Adapter
export { RustAdapter, parseCargoToml } from './rust.js'
export type { RustExportInfo, RustFunctionInfo, CargoDependency } from './rust.js'

// SMI-1307: Java Language Adapter
export { JavaAdapter, parsePomXml, parseBuildGradle } from './java.js'
export type { JavaExportInfo, JavaFunctionInfo, MavenDependency } from './java.js'
