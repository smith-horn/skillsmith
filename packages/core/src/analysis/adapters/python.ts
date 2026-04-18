/**
 * SMI-1304: Python Language Adapter
 *
 * Parses Python source files (.py, .pyi, .pyw) and extracts
 * imports, exports, and function definitions using regex-based
 * parsing with optional tree-sitter support for incremental parsing.
 *
 * @see docs/internal/architecture/multi-language-analysis.md
 */

import { LanguageAdapter, type SupportedLanguage, type FrameworkRule } from './base.js'
import type { ParseResult, ImportInfo, ExportInfo, FunctionInfo } from '../types.js'
import { PYTHON_FRAMEWORK_RULES } from './python-frameworks.js'
import { PythonIncrementalParser } from '../tree-sitter/pythonIncremental.js'

/**
 * Python adapter using regex-based parsing with optional tree-sitter
 *
 * The adapter provides:
 * - Synchronous regex-based parsing for basic analysis
 * - Async tree-sitter parsing for enhanced accuracy (when available)
 * - Framework detection rules for Django, FastAPI, Flask, etc.
 *
 * @example
 * ```typescript
 * const adapter = new PythonAdapter()
 *
 * const result = adapter.parseFile(`
 *   import os
 *   from django.http import HttpResponse
 *
 *   def hello(request):
 *       return HttpResponse("Hello")
 * `, 'views.py')
 *
 * console.log(result.imports)  // [{ module: 'os', ... }, { module: 'django.http', ... }]
 * console.log(result.functions)  // [{ name: 'hello', ... }]
 * ```
 */
export class PythonAdapter extends LanguageAdapter {
  readonly language: SupportedLanguage = 'python'
  readonly extensions = ['.py', '.pyi', '.pyw']

  private incremental: PythonIncrementalParser | null = null
  private initPromise: Promise<void> | null = null

  /**
   * Initialize the tree-sitter parser (lazy loaded)
   *
   * Instantiates the WASM-backed PythonIncrementalParser so subsequent
   * incremental / query-based calls can run synchronously.
   */
  async initParser(): Promise<void> {
    if (this.incremental?.isReady) return
    if (this.initPromise) return this.initPromise
    if (!this.incremental) this.incremental = new PythonIncrementalParser()
    this.initPromise = this.incremental.ensureReady().finally(() => {
      this.initPromise = null
    })
    await this.initPromise
  }

  /**
   * Parse a Python file using regex-based parsing
   *
   * @param content - Python source code
   * @param filePath - Path to the file (for source tracking)
   * @returns Parsed imports, exports, and functions
   */
  parseFile(content: string, filePath: string): ParseResult {
    return this.parseWithRegex(content, filePath)
  }

  /**
   * Parse a Python file asynchronously with tree-sitter (if available)
   *
   * Falls back to regex parsing if tree-sitter is not available.
   *
   * @param content - Python source code
   * @param filePath - Path to the file (for source tracking)
   * @returns Promise resolving to parsed imports, exports, and functions
   */
  async parseFileAsync(content: string, filePath: string): Promise<ParseResult> {
    await this.initParser()
    if (this.incremental?.isReady) {
      const result = this.incremental.parseSync(content, filePath)
      if (result) return result
    }
    return this.parseWithRegex(content, filePath)
  }

  /**
   * Parse file incrementally using a previously cached parse tree.
   *
   * When the WASM parser has been initialised (via `parseFileAsync` or
   * `initParser`), this path reuses the cached tree with `tree.edit()` and
   * re-parses only the changed region, delegating extraction to
   * tree-sitter queries. On any failure it gracefully falls back to the
   * regex baseline.
   *
   * @param content - Updated Python source code
   * @param filePath - Path to the file
   * @param _previousTree - Reserved for external callers that want to pass
   *   a tree explicitly; the adapter manages its own cache and ignores it.
   * @returns Parsed imports, exports, and functions
   */
  parseIncremental(content: string, filePath: string, _previousTree?: unknown): ParseResult {
    if (this.incremental?.isReady) {
      const result = this.incremental.parseSync(content, filePath)
      if (result) return result
    }
    return this.parseWithRegex(content, filePath)
  }

  /**
   * Get Python framework detection rules
   *
   * @returns Array of framework detection rules
   */
  getFrameworkRules(): FrameworkRule[] {
    return PYTHON_FRAMEWORK_RULES
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    if (this.incremental) {
      this.incremental.dispose()
      this.incremental = null
    }
    this.initPromise = null
  }

  // ============================================================
  // Private parsing methods
  // ============================================================

  /**
   * Parse Python source code using regex patterns
   */
  private parseWithRegex(content: string, filePath: string): ParseResult {
    const imports = this.extractImports(content, filePath)
    const exports = this.extractExports(content, filePath)
    const functions = this.extractFunctions(content, filePath)
    return { imports, exports, functions }
  }

  /**
   * Extract imports from Python source code
   */
  private extractImports(content: string, filePath: string): ImportInfo[] {
    const imports: ImportInfo[] = []
    const lines = content.split('\n')

    // Regex patterns for import statements
    const importRegex = /^import\s+([\w.]+)(?:\s+as\s+(\w+))?$/
    const fromImportRegex = /^from\s+([\w.]+)\s+import\s+(.+)$/

    // Track multi-line imports
    let multiLineBuffer = ''
    let inMultiLineImport = false
    let multiLineModule = ''

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()

      // Skip comments and empty lines
      if (line.startsWith('#') || line === '') {
        continue
      }

      // Handle multi-line imports (with parentheses)
      if (inMultiLineImport) {
        multiLineBuffer += ' ' + line
        if (line.includes(')')) {
          inMultiLineImport = false
          // Parse the complete multi-line import
          const names = this.parseImportNames(multiLineBuffer.replace(/[()]/g, ''))
          imports.push({
            module: multiLineModule,
            namedImports: names.filter((n) => n !== '*'),
            namespaceImport: names.includes('*') ? '*' : undefined,
            isTypeOnly: false,
            sourceFile: filePath,
            line: i + 1,
          })
          multiLineBuffer = ''
          multiLineModule = ''
        }
        continue
      }

      // Check for multi-line import start
      const fromMatch = line.match(fromImportRegex)
      if (fromMatch && line.includes('(') && !line.includes(')')) {
        inMultiLineImport = true
        multiLineModule = fromMatch[1]
        multiLineBuffer = fromMatch[2]
        continue
      }

      // Simple import: `import module`
      const importMatch = line.match(importRegex)
      if (importMatch) {
        imports.push({
          module: importMatch[1],
          namedImports: [],
          defaultImport: importMatch[2] || undefined, // alias becomes "default-like" import
          isTypeOnly: false,
          sourceFile: filePath,
          line: i + 1,
        })
        continue
      }

      // From import: `from module import name`
      if (fromMatch) {
        const names = this.parseImportNames(fromMatch[2])
        imports.push({
          module: fromMatch[1],
          namedImports: names.filter((n) => n !== '*'),
          namespaceImport: names.includes('*') ? '*' : undefined,
          isTypeOnly: false,
          sourceFile: filePath,
          line: i + 1,
        })
      }
    }

    return imports
  }

  /**
   * Parse comma-separated import names, handling aliases
   */
  private parseImportNames(namesStr: string): string[] {
    return namesStr
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n !== '')
      .map((n) => {
        // Handle 'name as alias' - we only want the original name
        const asMatch = n.match(/^(\w+)\s+as\s+\w+$/)
        if (asMatch) return asMatch[1]
        return n.replace(/[()]/g, '').trim()
      })
      .filter((n) => n !== '')
  }

  /**
   * Extract exports from Python source code
   */
  private extractExports(content: string, filePath: string): ExportInfo[] {
    const exports: ExportInfo[] = []
    const lines = content.split('\n')
    const explicitExports = new Set<string>()

    // Look for __all__ definition
    const allMatch = content.match(/__all__\s*=\s*\[([^\]]+)\]/)
    if (allMatch) {
      const names = allMatch[1].match(/['"](\w+)['"]/g) || []
      for (const name of names) {
        const cleanName = name.replace(/['"]/g, '')
        explicitExports.add(cleanName)
        exports.push({
          name: cleanName,
          kind: 'unknown',
          isDefault: false,
          sourceFile: filePath,
        })
      }
    }

    // Find top-level class and function definitions
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // Skip if not at column 0 (not top-level)
      if (line.startsWith(' ') || line.startsWith('\t')) {
        continue
      }

      // Class definition
      const classMatch = line.match(/^class\s+(\w+)/)
      if (classMatch) {
        const name = classMatch[1]
        // Only add if not private and not already in __all__
        if (!name.startsWith('_') && !explicitExports.has(name)) {
          exports.push({
            name,
            kind: 'class',
            isDefault: false,
            sourceFile: filePath,
            line: i + 1,
          })
        }
      }

      // Function definition (not method - those are indented)
      const funcMatch = line.match(/^(?:async\s+)?def\s+(\w+)/)
      if (funcMatch) {
        const name = funcMatch[1]
        // Only add if not private and not already in __all__
        if (!name.startsWith('_') && !explicitExports.has(name)) {
          exports.push({
            name,
            kind: 'function',
            isDefault: false,
            sourceFile: filePath,
            line: i + 1,
          })
        }
      }
    }

    return exports
  }

  /**
   * Extract function definitions from Python source code
   */
  private extractFunctions(content: string, filePath: string): FunctionInfo[] {
    const functions: FunctionInfo[] = []
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // Match function definitions (both sync and async)
      const match = line.match(/^(\s*)(async\s+)?def\s+(\w+)\s*\(([^)]*)\)/)
      if (match) {
        const indentation = match[1]
        const isAsync = !!match[2]
        const name = match[3]
        const paramsStr = match[4]

        // Count parameters (excluding self, cls)
        const params = paramsStr
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p !== '' && p !== 'self' && p !== 'cls')

        // Is top-level (exported) if no indentation and not private
        const isTopLevel = indentation === ''
        const isExported = isTopLevel && !name.startsWith('_')

        functions.push({
          name,
          parameterCount: params.length,
          isAsync,
          isExported,
          sourceFile: filePath,
          line: i + 1,
        })
      }
    }

    return functions
  }

  /**
   * Parse Python source code using tree-sitter for more accurate results.
   *
   * Delegates to the query-based extractor when the WASM parser is ready;
   * falls back to regex otherwise so the adapter always returns a result.
   */
  private parseWithTreeSitter(content: string, filePath: string): ParseResult {
    if (this.incremental?.isReady) {
      const result = this.incremental.parseSync(content, filePath)
      if (result) return result
    }
    return this.parseWithRegex(content, filePath)
  }
}
