/**
 * SMI-1306: Rust Language Adapter
 *
 * Parses Rust source files (.rs) and extracts imports, exports, and functions
 * using regex-based parsing. Rust uses explicit `pub` visibility modifiers
 * for public items.
 *
 * @see docs/architecture/multi-language-analysis.md
 */

import { LanguageAdapter, type SupportedLanguage } from './base.js'
import type { ParseResult, ImportInfo, ExportInfo, FunctionInfo, FrameworkRule } from './base.js'

// Re-export Cargo.toml parser for backwards compatibility
export { parseCargoToml, type CargoDependency } from './rust-parsers.js'

/**
 * Extended ExportInfo for Rust with visibility support
 */
export interface RustExportInfo extends ExportInfo {
  /** Rust exports via pub modifier */
  visibility: 'public' | 'private'
  /** Line number in source */
  line: number
}

/**
 * Extended FunctionInfo for Rust with attribute support
 */
export interface RustFunctionInfo extends FunctionInfo {
  /** Rust attributes (e.g., #[derive], #[test]) */
  attributes?: string[]
}

/**
 * Rust framework detection rules
 */
const RUST_FRAMEWORK_RULES: FrameworkRule[] = [
  {
    name: 'Actix',
    depIndicators: ['actix-web', 'actix-rt'],
    importIndicators: ['actix_web', 'actix_rt'],
  },
  {
    name: 'Rocket',
    depIndicators: ['rocket'],
    importIndicators: ['rocket'],
  },
  {
    name: 'Axum',
    depIndicators: ['axum'],
    importIndicators: ['axum'],
  },
  {
    name: 'Tokio',
    depIndicators: ['tokio'],
    importIndicators: ['tokio'],
  },
  {
    name: 'Serde',
    depIndicators: ['serde', 'serde_json'],
    importIndicators: ['serde', 'serde_json'],
  },
  {
    name: 'Diesel',
    depIndicators: ['diesel'],
    importIndicators: ['diesel'],
  },
  {
    name: 'SQLx',
    depIndicators: ['sqlx'],
    importIndicators: ['sqlx'],
  },
  {
    name: 'Clap',
    depIndicators: ['clap'],
    importIndicators: ['clap'],
  },
  {
    name: 'Warp',
    depIndicators: ['warp'],
    importIndicators: ['warp'],
  },
  {
    name: 'Reqwest',
    depIndicators: ['reqwest'],
    importIndicators: ['reqwest'],
  },
  {
    name: 'Hyper',
    depIndicators: ['hyper'],
    importIndicators: ['hyper'],
  },
  {
    name: 'Tonic',
    depIndicators: ['tonic'],
    importIndicators: ['tonic'],
  },
  {
    name: 'Tracing',
    depIndicators: ['tracing', 'tracing-subscriber'],
    importIndicators: ['tracing', 'tracing_subscriber'],
  },
]

/**
 * Rust Language Adapter
 *
 * Parses Rust source files using regex-based parsing.
 * Handles Rust's `pub` visibility modifiers and module system.
 *
 * @example
 * ```typescript
 * const adapter = new RustAdapter()
 * const result = adapter.parseFile(rustCode, 'lib.rs')
 * console.log(result.exports) // Items with pub modifier
 * ```
 */
export class RustAdapter extends LanguageAdapter {
  readonly language: SupportedLanguage = 'rust'
  readonly extensions = ['.rs']

  /**
   * Parse a Rust source file and extract information
   */
  parseFile(content: string, filePath: string): ParseResult {
    const imports = this.extractImports(content, filePath)
    const exports = this.extractExports(content, filePath)
    const functions = this.extractFunctions(content, filePath)
    return { imports, exports, functions }
  }

  /**
   * Parse file incrementally (currently same as full parse)
   */
  parseIncremental(content: string, filePath: string, _previousTree?: unknown): ParseResult {
    // Incremental parsing not yet implemented for Rust
    // Will be added with tree-sitter integration
    return this.parseFile(content, filePath)
  }

  /**
   * Get Rust framework detection rules
   */
  getFrameworkRules(): FrameworkRule[] {
    return RUST_FRAMEWORK_RULES
  }

  /**
   * Clean up resources (no-op for regex-based parsing)
   */
  dispose(): void {
    // No resources to clean up for regex-based parsing
  }

  /**
   * Extract use statements from Rust source
   */
  private extractImports(content: string, filePath: string): ImportInfo[] {
    const imports: ImportInfo[] = []
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      const lineNum = i + 1

      // Skip comments
      if (line.startsWith('//') || line.startsWith('/*')) {
        continue
      }

      // Match: use module::path::{item1, item2};
      const useGroupMatch = line.match(/^use\s+([\w:]+)::\{([^}]+)\};/)
      if (useGroupMatch) {
        const module = useGroupMatch[1]
        const items = useGroupMatch[2]
          .split(',')
          .map((n) => n.trim())
          .filter(Boolean)
          // Handle self in grouped imports: use foo::{self, Bar}
          .map((n) => (n === 'self' ? '' : n))
          .filter(Boolean)

        imports.push({
          module,
          namedImports: items,
          isTypeOnly: false,
          sourceFile: filePath,
          line: lineNum,
        })
        continue
      }

      // Match: use module::path::item as alias;
      // Match: use module::path::item;
      // Match: use module::*;
      const useMatch = line.match(/^use\s+([\w:*]+)(?:\s+as\s+(\w+))?;/)
      if (useMatch) {
        let module = useMatch[1]
        const alias = useMatch[2]
        let namespaceImport: string | undefined

        // Check for glob import
        if (module.endsWith('::*')) {
          module = module.slice(0, -3)
          namespaceImport = '*'
        }

        // Extract the item name from the module path
        const pathParts = module.split('::')
        const itemName = pathParts[pathParts.length - 1]

        imports.push({
          module,
          namedImports: namespaceImport ? [] : [itemName],
          defaultImport: alias || undefined,
          namespaceImport,
          isTypeOnly: false,
          sourceFile: filePath,
          line: lineNum,
        })
        continue
      }

      // Match: extern crate foo;
      // Match: extern crate foo as bar;
      const externMatch = line.match(/^extern\s+crate\s+(\w+)(?:\s+as\s+(\w+))?;/)
      if (externMatch) {
        imports.push({
          module: externMatch[1],
          namedImports: [],
          defaultImport: externMatch[2] || undefined,
          isTypeOnly: false,
          sourceFile: filePath,
          line: lineNum,
        })
      }
    }

    return imports
  }

  /**
   * Extract exports (pub items) from Rust source
   */
  private extractExports(content: string, filePath: string): ExportInfo[] {
    const exports: ExportInfo[] = []
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lineNum = i + 1

      // Skip comments and empty lines
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed === '') {
        continue
      }

      // pub struct Name
      const structMatch = line.match(/^(pub(?:\([^)]+\))?)\s+struct\s+(\w+)/)
      if (structMatch) {
        exports.push({
          name: structMatch[2],
          kind: 'struct',
          isDefault: false,
          sourceFile: filePath,
          visibility: 'public',
          line: lineNum,
        })
        continue
      }

      // pub enum Name
      const enumMatch = line.match(/^(pub(?:\([^)]+\))?)\s+enum\s+(\w+)/)
      if (enumMatch) {
        exports.push({
          name: enumMatch[2],
          kind: 'enum',
          isDefault: false,
          sourceFile: filePath,
          visibility: 'public',
          line: lineNum,
        })
        continue
      }

      // pub trait Name
      const traitMatch = line.match(/^(pub(?:\([^)]+\))?)\s+trait\s+(\w+)/)
      if (traitMatch) {
        exports.push({
          name: traitMatch[2],
          kind: 'trait',
          isDefault: false,
          sourceFile: filePath,
          visibility: 'public',
          line: lineNum,
        })
        continue
      }

      // pub fn name or pub async fn name
      const fnMatch = line.match(/^(pub(?:\([^)]+\))?)\s+(?:async\s+)?fn\s+(\w+)/)
      if (fnMatch) {
        exports.push({
          name: fnMatch[2],
          kind: 'function',
          isDefault: false,
          sourceFile: filePath,
          visibility: 'public',
          line: lineNum,
        })
        continue
      }

      // pub mod name
      const modMatch = line.match(/^(pub(?:\([^)]+\))?)\s+mod\s+(\w+)/)
      if (modMatch) {
        exports.push({
          name: modMatch[2],
          kind: 'module',
          isDefault: false,
          sourceFile: filePath,
          visibility: 'public',
          line: lineNum,
        })
        continue
      }

      // pub type Name = ...
      const typeMatch = line.match(/^(pub(?:\([^)]+\))?)\s+type\s+(\w+)/)
      if (typeMatch) {
        exports.push({
          name: typeMatch[2],
          kind: 'type',
          isDefault: false,
          sourceFile: filePath,
          visibility: 'public',
          line: lineNum,
        })
        continue
      }

      // pub const NAME or pub static NAME
      const constMatch = line.match(/^(pub(?:\([^)]+\))?)\s+(?:const|static)\s+(\w+)/)
      if (constMatch) {
        exports.push({
          name: constMatch[2],
          kind: 'variable',
          isDefault: false,
          sourceFile: filePath,
          visibility: 'public',
          line: lineNum,
        })
      }
    }

    return exports
  }

  /**
   * Extract function definitions from Rust source
   */
  private extractFunctions(content: string, filePath: string): FunctionInfo[] {
    const functions: FunctionInfo[] = []
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lineNum = i + 1

      // Match: fn name(params) or async fn name(params) or pub fn name(params)
      // Handle generics: fn name<T, U>(params)
      const match = line.match(
        /^(\s*)(pub(?:\([^)]+\))?\s+)?(async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/
      )
      if (match) {
        const pubModifier = match[2]
        const isAsync = !!match[3]
        const name = match[4]
        const paramsStr = match[5]

        // Count parameters (excluding self/&self/&mut self)
        let paramCount = 0
        if (paramsStr.trim()) {
          const params = paramsStr.split(',')
          for (const param of params) {
            const trimmed = param.trim()
            // Skip self parameters
            if (trimmed && !trimmed.match(/^&?(?:mut\s+)?self$/)) {
              paramCount++
            }
          }
        }

        // Check for attributes (decorators) above the function
        const attributes: string[] = []
        for (let j = i - 1; j >= 0; j--) {
          const prevLine = lines[j].trim()
          if (prevLine.startsWith('#[')) {
            // Extract attribute name
            const attrMatch = prevLine.match(/#\[([^\]]+)\]/)
            if (attrMatch) {
              // Get just the attribute name, not its arguments
              const attrContent = attrMatch[1]
              const attrName = attrContent.split('(')[0].trim()
              attributes.unshift(attrName)
            }
          } else if (prevLine === '' || prevLine.startsWith('//')) {
            // Skip empty lines and comments
            continue
          } else {
            // Stop if we hit non-attribute, non-comment content
            break
          }
        }

        functions.push({
          name,
          parameterCount: paramCount,
          isAsync,
          isExported: !!pubModifier,
          sourceFile: filePath,
          line: lineNum,
          attributes: attributes.length > 0 ? attributes : undefined,
        })
      }
    }

    return functions
  }
}
