/**
 * SMI-1305: Go Language Adapter
 *
 * Parses Go source files and extracts imports, exports, and functions
 * using regex-based parsing. Go uses capitalization-based visibility:
 * identifiers starting with uppercase are exported (public).
 *
 * @see docs/architecture/multi-language-analysis.md
 */

import { LanguageAdapter, type SupportedLanguage } from './base.js'
import type { ParseResult, ImportInfo, ExportInfo, FunctionInfo, FrameworkRule } from './base.js'

/**
 * Extended ExportInfo for Go with visibility support
 */
export interface GoExportInfo extends ExportInfo {
  /** Go exports via capitalization */
  visibility: 'public' | 'private'
  /** Line number in source */
  line: number
}

/**
 * Extended FunctionInfo for Go with receiver support
 */
export interface GoFunctionInfo extends FunctionInfo {
  /** Method receiver type (e.g., "*MyStruct") */
  receiver?: string
}

/**
 * Go module information from go.mod
 */
export interface GoModInfo {
  /** Module path (e.g., "github.com/user/project") */
  module: string
  /** Go version (e.g., "1.21") */
  goVersion?: string
  /** Direct dependencies */
  require: Array<{ path: string; version: string }>
  /** Replaced dependencies */
  replace: Array<{ old: string; new: string; version?: string }>
}

/**
 * Go Language Adapter
 *
 * Parses Go source files using regex-based parsing.
 * Handles Go's capitalization-based visibility rules.
 *
 * @example
 * ```typescript
 * const adapter = new GoAdapter()
 * const result = adapter.parseFile(goCode, 'main.go')
 * console.log(result.exports) // Uppercase identifiers only
 * ```
 */
export class GoAdapter extends LanguageAdapter {
  readonly language: SupportedLanguage = 'go'
  readonly extensions = ['.go']

  /**
   * Parse a Go source file and extract information
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
    // Incremental parsing not yet implemented for Go
    // Will be added with tree-sitter integration
    return this.parseFile(content, filePath)
  }

  /**
   * Get Go framework detection rules
   */
  getFrameworkRules(): FrameworkRule[] {
    return [
      {
        name: 'Gin',
        depIndicators: ['github.com/gin-gonic/gin'],
        importIndicators: ['github.com/gin-gonic/gin'],
      },
      {
        name: 'Echo',
        depIndicators: ['github.com/labstack/echo'],
        importIndicators: ['github.com/labstack/echo', 'github.com/labstack/echo/v4'],
      },
      {
        name: 'Fiber',
        depIndicators: ['github.com/gofiber/fiber'],
        importIndicators: ['github.com/gofiber/fiber', 'github.com/gofiber/fiber/v2'],
      },
      {
        name: 'GORM',
        depIndicators: ['gorm.io/gorm'],
        importIndicators: ['gorm.io/gorm', 'gorm.io/driver/postgres', 'gorm.io/driver/mysql'],
      },
      {
        name: 'Cobra',
        depIndicators: ['github.com/spf13/cobra'],
        importIndicators: ['github.com/spf13/cobra'],
      },
      {
        name: 'Viper',
        depIndicators: ['github.com/spf13/viper'],
        importIndicators: ['github.com/spf13/viper'],
      },
      {
        name: 'Chi',
        depIndicators: ['github.com/go-chi/chi'],
        importIndicators: ['github.com/go-chi/chi', 'github.com/go-chi/chi/v5'],
      },
      {
        name: 'Gorilla Mux',
        depIndicators: ['github.com/gorilla/mux'],
        importIndicators: ['github.com/gorilla/mux'],
      },
      {
        name: 'gRPC',
        depIndicators: ['google.golang.org/grpc'],
        importIndicators: ['google.golang.org/grpc', 'google.golang.org/protobuf'],
      },
      {
        name: 'testify',
        depIndicators: ['github.com/stretchr/testify'],
        importIndicators: [
          'github.com/stretchr/testify/assert',
          'github.com/stretchr/testify/require',
          'github.com/stretchr/testify/mock',
        ],
      },
    ]
  }

  /**
   * Clean up resources (no-op for regex-based parsing)
   */
  dispose(): void {
    // No resources to clean up for regex-based parsing
  }

  /**
   * Check if an identifier is exported (starts with uppercase)
   *
   * In Go, identifiers starting with uppercase are exported (public)
   * and can be accessed from other packages.
   *
   * @param name - Identifier name
   * @returns True if the identifier is exported
   */
  private isExported(name: string): boolean {
    return /^[A-Z]/.test(name)
  }

  /**
   * Extract import statements from Go source
   *
   * Handles both single imports and import blocks:
   * - import "fmt"
   * - import ( "fmt" \n "os" )
   * - import alias "path/to/package"
   */
  private extractImports(content: string, filePath: string): ImportInfo[] {
    const imports: ImportInfo[] = []

    // Single import: import "fmt" or import alias "path"
    const singleImportRegex = /import\s+(?:(\w+)\s+)?"([^"]+)"/g
    let match
    while ((match = singleImportRegex.exec(content)) !== null) {
      imports.push({
        module: match[2],
        namedImports: [],
        defaultImport: match[1] || undefined,
        isTypeOnly: false,
        sourceFile: filePath,
      })
    }

    // Import block: import ( "fmt" \n "os" )
    const blockImportRegex = /import\s*\(\s*([\s\S]*?)\)/g
    while ((match = blockImportRegex.exec(content)) !== null) {
      const block = match[1]
      // Match each line in the block: optional alias followed by quoted path
      // Handles: "fmt", alias "path", . "path", _ "path"
      const lineRegex = /(?:([._]|\w+)\s+)?"([^"]+)"/g
      let lineMatch
      while ((lineMatch = lineRegex.exec(block)) !== null) {
        imports.push({
          module: lineMatch[2],
          namedImports: [],
          defaultImport: lineMatch[1] || undefined,
          isTypeOnly: false,
          sourceFile: filePath,
        })
      }
    }

    return imports
  }

  /**
   * Extract exports (public declarations) from Go source
   *
   * In Go, any top-level declaration starting with uppercase is exported:
   * - type Foo struct/interface
   * - func Foo() or func (r *Receiver) Foo()
   * - const/var Foo
   */
  private extractExports(content: string, filePath: string): ExportInfo[] {
    const exports: ExportInfo[] = []
    const lines = content.split('\n')

    // Track if we're inside a const or var block
    let inConstBlock = false
    let inVarBlock = false

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmedLine = line.trim()

      // Check for start of const/var blocks
      if (/^const\s*\(/.test(line)) {
        inConstBlock = true
        continue
      }
      if (/^var\s*\(/.test(line)) {
        inVarBlock = true
        continue
      }

      // Check for end of blocks (closing paren at start of line)
      if ((inConstBlock || inVarBlock) && /^\)/.test(trimmedLine)) {
        inConstBlock = false
        inVarBlock = false
        continue
      }

      // Inside const block: extract exported identifiers
      if (inConstBlock) {
        const blockConstMatch = trimmedLine.match(/^([A-Z]\w*)/)
        if (blockConstMatch) {
          exports.push({
            name: blockConstMatch[1],
            kind: 'variable',
            isDefault: false,
            sourceFile: filePath,
          })
        }
        continue
      }

      // Inside var block: extract exported identifiers
      if (inVarBlock) {
        const blockVarMatch = trimmedLine.match(/^([A-Z]\w*)/)
        if (blockVarMatch) {
          exports.push({
            name: blockVarMatch[1],
            kind: 'variable',
            isDefault: false,
            sourceFile: filePath,
          })
        }
        continue
      }

      // Type declarations: type Foo struct/interface/...
      const typeMatch = line.match(/^type\s+([A-Z]\w*)\s+(struct|interface)/)
      if (typeMatch) {
        exports.push({
          name: typeMatch[1],
          kind: typeMatch[2] === 'struct' ? 'struct' : 'interface',
          isDefault: false,
          sourceFile: filePath,
        })
        continue
      }

      // Type alias or simple type: type Foo = Other or type Foo Other
      const typeAliasMatch = line.match(/^type\s+([A-Z]\w*)\s+(?:=\s+)?(\w+)/)
      if (typeAliasMatch && !line.includes('struct') && !line.includes('interface')) {
        exports.push({
          name: typeAliasMatch[1],
          kind: 'type',
          isDefault: false,
          sourceFile: filePath,
        })
        continue
      }

      // Function declarations: func Foo() or func (r *Receiver) Foo()
      const funcMatch = line.match(/^func\s+(?:\([^)]+\)\s+)?([A-Z]\w*)\s*\(/)
      if (funcMatch) {
        exports.push({
          name: funcMatch[1],
          kind: 'function',
          isDefault: false,
          sourceFile: filePath,
        })
        continue
      }

      // Single-line const declarations: const Foo = ... (not inside a block)
      const constMatch = line.match(/^const\s+([A-Z]\w*)/)
      if (constMatch && !line.includes('(')) {
        exports.push({
          name: constMatch[1],
          kind: 'variable',
          isDefault: false,
          sourceFile: filePath,
        })
        continue
      }

      // Single-line var declarations: var Foo = ... (not inside a block)
      const varMatch = line.match(/^var\s+([A-Z]\w*)/)
      if (varMatch && !line.includes('(')) {
        exports.push({
          name: varMatch[1],
          kind: 'variable',
          isDefault: false,
          sourceFile: filePath,
        })
        continue
      }
    }

    return exports
  }

  /**
   * Extract function definitions from Go source
   *
   * Handles both regular functions and methods:
   * - func name(params) return
   * - func (r *Receiver) name(params) return
   */
  private extractFunctions(content: string, filePath: string): FunctionInfo[] {
    const functions: FunctionInfo[] = []
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lineNum = i + 1

      // Match: func Name(params) or func (r *Receiver) Name(params)
      // Captures: [1] receiver, [2] name, [3] params
      const match = line.match(/^func\s+(?:\(([^)]+)\)\s+)?(\w+)\s*\(([^)]*)\)/)
      if (match) {
        // SMI-1334: Capture receiver for method output
        const receiver = match[1]?.trim() || undefined
        const name = match[2]
        const paramsStr = match[3]

        // Count parameters (split by comma, filter empty)
        const params = paramsStr
          ? paramsStr
              .split(',')
              .map((p) => p.trim())
              .filter((p) => p.length > 0).length
          : 0

        functions.push({
          name,
          parameterCount: params,
          isAsync: false, // Go uses goroutines, not async/await
          isExported: this.isExported(name),
          sourceFile: filePath,
          line: lineNum,
          // SMI-1334: Include receiver in function output
          receiver,
        })
      }
    }

    return functions
  }
}

/**
 * Parse go.mod file to extract module info and dependencies
 *
 * @param content - Content of go.mod file
 * @returns Parsed go.mod information
 *
 * @example
 * ```typescript
 * const modInfo = parseGoMod(goModContent)
 * console.log(modInfo.module) // "github.com/user/project"
 * console.log(modInfo.require) // [{ path: "...", version: "..." }]
 * ```
 */
export function parseGoMod(content: string): GoModInfo {
  const result: GoModInfo = {
    module: '',
    require: [],
    replace: [],
  }

  // Extract module name
  const moduleMatch = content.match(/^module\s+(\S+)/m)
  if (moduleMatch) {
    result.module = moduleMatch[1]
  }

  // Extract Go version
  const goVersionMatch = content.match(/^go\s+(\d+\.\d+(?:\.\d+)?)/m)
  if (goVersionMatch) {
    result.goVersion = goVersionMatch[1]
  }

  // Extract require blocks first
  const requireBlockRegex = /require\s*\(\s*([\s\S]*?)\)/gm
  let match
  while ((match = requireBlockRegex.exec(content)) !== null) {
    const block = match[1]
    // Match package path and version (path must start with a letter or domain)
    const lineRegex = /^\s*([a-zA-Z][\w./-]+)\s+(v[\d.]+\S*)/gm
    let lineMatch
    while ((lineMatch = lineRegex.exec(block)) !== null) {
      result.require.push({
        path: lineMatch[1],
        version: lineMatch[2],
      })
    }
  }

  // Extract single-line require directives (not followed by parenthesis)
  // Match: require github.com/pkg v1.0.0
  const singleRequireRegex = /^require\s+([a-zA-Z][\w./-]+)\s+(v[\d.]+\S*)/gm
  while ((match = singleRequireRegex.exec(content)) !== null) {
    // Check if this is not part of a block (no opening paren on same line)
    const lineStart = content.lastIndexOf('\n', match.index) + 1
    const lineEnd = content.indexOf('\n', match.index)
    const fullLine = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
    if (!fullLine.includes('(')) {
      result.require.push({
        path: match[1],
        version: match[2],
      })
    }
  }

  // Extract replace blocks first
  const replaceBlockRegex = /replace\s*\(\s*([\s\S]*?)\)/gm
  while ((match = replaceBlockRegex.exec(content)) !== null) {
    const block = match[1]
    const lineRegex = /^\s*([a-zA-Z][\w./-]+)\s+=>\s+(\S+)(?:\s+(v[\d.]+\S*))?/gm
    let lineMatch
    while ((lineMatch = lineRegex.exec(block)) !== null) {
      result.replace.push({
        old: lineMatch[1],
        new: lineMatch[2],
        version: lineMatch[3],
      })
    }
  }

  // Extract single-line replace directives
  const singleReplaceRegex = /^replace\s+([a-zA-Z][\w./-]+)\s+=>\s+(\S+)(?:\s+(v[\d.]+\S*))?/gm
  while ((match = singleReplaceRegex.exec(content)) !== null) {
    // Check if this is not part of a block
    const lineStart = content.lastIndexOf('\n', match.index) + 1
    const lineEnd = content.indexOf('\n', match.index)
    const fullLine = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
    if (!fullLine.includes('(')) {
      result.replace.push({
        old: match[1],
        new: match[2],
        version: match[3],
      })
    }
  }

  return result
}
