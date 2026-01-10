/**
 * SMI-1304: Python Language Adapter
 *
 * Parses Python source files (.py, .pyi, .pyw) and extracts
 * imports, exports, and function definitions using regex-based
 * parsing with optional tree-sitter support for incremental parsing.
 *
 * @see docs/architecture/multi-language-analysis.md
 */

import { LanguageAdapter, type SupportedLanguage, type FrameworkRule } from './base.js'
import type { ParseResult, ImportInfo, ExportInfo, FunctionInfo } from '../types.js'

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

  private parser: unknown = null
  private parserInitialized = false
  private parserInitPromise: Promise<void> | null = null

  /**
   * Initialize the tree-sitter parser (lazy loaded)
   *
   * This method is called automatically when using parseFileAsync.
   * Tree-sitter provides more accurate parsing but requires WASM modules.
   */
  async initParser(): Promise<void> {
    if (this.parserInitialized) return
    if (this.parserInitPromise) return this.parserInitPromise

    this.parserInitPromise = this.doInitParser()
    await this.parserInitPromise
  }

  private async doInitParser(): Promise<void> {
    try {
      // Lazy load web-tree-sitter (optional dependency)
      // @ts-expect-error - Optional dependency, may not have type declarations
      const treeSitterModule = await import('web-tree-sitter').catch(() => null)

      if (!treeSitterModule) {
        // Tree-sitter not available, will use regex fallback
        this.parserInitialized = false
        return
      }

      const Parser = treeSitterModule.default
      await Parser.init()
      this.parser = new Parser()

      // Load Python language WASM
      // Note: The WASM file path would need to be provided via configuration
      // For now, we use a relative path that works in typical setups
      const wasmPath = 'tree-sitter-python.wasm'
      const Python = await Parser.Language.load(wasmPath)
      ;(this.parser as { setLanguage: (lang: unknown) => void }).setLanguage(Python)

      this.parserInitialized = true
    } catch (error) {
      // Tree-sitter not available, will use regex fallback
      console.warn(
        '[PythonAdapter] tree-sitter initialization failed, using regex fallback:',
        error instanceof Error ? error.message : String(error)
      )
      this.parserInitialized = false
    }
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
    if (!this.parserInitialized && !this.parserInitPromise) {
      await this.initParser()
    } else if (this.parserInitPromise) {
      await this.parserInitPromise
    }

    if (this.parser && this.parserInitialized) {
      return this.parseWithTreeSitter(content, filePath)
    }

    return this.parseWithRegex(content, filePath)
  }

  /**
   * Parse file incrementally using previous parse tree
   *
   * Currently falls back to full regex parsing. Tree-sitter
   * incremental parsing will be implemented in SMI-1309.
   *
   * @param content - Updated Python source code
   * @param filePath - Path to the file
   * @param _previousTree - Previous parse tree (not yet used)
   * @returns Parsed imports, exports, and functions
   */
  parseIncremental(content: string, filePath: string, _previousTree?: unknown): ParseResult {
    // TODO: SMI-1309 - Implement incremental parsing with tree-sitter
    return this.parseFile(content, filePath)
  }

  /**
   * Get Python framework detection rules
   *
   * Detects common Python frameworks and libraries including:
   * - Web frameworks: Django, FastAPI, Flask
   * - Testing: pytest
   * - Data science: pandas, numpy
   * - Databases: SQLAlchemy
   * - Task queues: Celery
   *
   * @returns Array of framework detection rules
   */
  getFrameworkRules(): FrameworkRule[] {
    return [
      {
        name: 'Django',
        depIndicators: ['django', 'Django'],
        importIndicators: ['django', 'django.db', 'django.http', 'django.views', 'django.urls'],
      },
      {
        name: 'FastAPI',
        depIndicators: ['fastapi'],
        importIndicators: ['fastapi', 'starlette', 'pydantic'],
      },
      {
        name: 'Flask',
        depIndicators: ['flask', 'Flask'],
        importIndicators: ['flask', 'flask_restful', 'flask_sqlalchemy'],
      },
      {
        name: 'pytest',
        depIndicators: ['pytest'],
        importIndicators: ['pytest', 'pytest_asyncio', '_pytest'],
      },
      {
        name: 'pandas',
        depIndicators: ['pandas'],
        importIndicators: ['pandas', 'pd'],
      },
      {
        name: 'numpy',
        depIndicators: ['numpy'],
        importIndicators: ['numpy', 'np'],
      },
      {
        name: 'SQLAlchemy',
        depIndicators: ['sqlalchemy', 'SQLAlchemy'],
        importIndicators: ['sqlalchemy', 'sqlalchemy.orm', 'sqlalchemy.ext'],
      },
      {
        name: 'Celery',
        depIndicators: ['celery'],
        importIndicators: ['celery', 'celery.task'],
      },
      {
        name: 'Requests',
        depIndicators: ['requests'],
        importIndicators: ['requests'],
      },
      {
        name: 'aiohttp',
        depIndicators: ['aiohttp'],
        importIndicators: ['aiohttp'],
      },
      {
        name: 'Scrapy',
        depIndicators: ['scrapy'],
        importIndicators: ['scrapy'],
      },
      {
        name: 'TensorFlow',
        depIndicators: ['tensorflow', 'tensorflow-gpu'],
        importIndicators: ['tensorflow', 'tf'],
      },
      {
        name: 'PyTorch',
        depIndicators: ['torch', 'pytorch'],
        importIndicators: ['torch', 'torch.nn', 'torchvision'],
      },
    ]
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    if (this.parser && typeof (this.parser as { delete?: () => void }).delete === 'function') {
      ;(this.parser as { delete: () => void }).delete()
    }
    this.parser = null
    this.parserInitialized = false
    this.parserInitPromise = null
  }

  // ============================================================
  // Private parsing methods
  // ============================================================

  /**
   * Parse Python source code using regex patterns
   *
   * @param content - Python source code
   * @param filePath - Path to the file
   * @returns Parsed result
   */
  private parseWithRegex(content: string, filePath: string): ParseResult {
    const imports = this.extractImports(content, filePath)
    const exports = this.extractExports(content, filePath)
    const functions = this.extractFunctions(content, filePath)
    return { imports, exports, functions }
  }

  /**
   * Extract imports from Python source code
   *
   * Handles:
   * - `import module`
   * - `import module as alias`
   * - `from module import name`
   * - `from module import name as alias`
   * - `from module import *`
   * - `from module import (name1, name2)`
   *
   * @param content - Python source code
   * @param filePath - Path to the file
   * @returns Array of import information
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
   *
   * @param namesStr - String containing import names
   * @returns Array of imported names (without aliases)
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
   *
   * In Python, exports are determined by:
   * 1. `__all__` list (explicit exports)
   * 2. Top-level class/function definitions (implicit, if not starting with _)
   *
   * @param content - Python source code
   * @param filePath - Path to the file
   * @returns Array of export information
   */
  private extractExports(content: string, filePath: string): ExportInfo[] {
    const exports: ExportInfo[] = []
    const lines = content.split('\n')
    const explicitExports = new Set<string>()

    // Look for __all__ definition (handle multi-line with [\s\S] instead of dotAll flag)
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
        // Only add if not private (starts with _) and not already in __all__
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
        // Only add if not private (starts with _) and not already in __all__
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
   *
   * Handles:
   * - Regular functions: `def func():`
   * - Async functions: `async def func():`
   * - Methods (indented functions)
   *
   * @param content - Python source code
   * @param filePath - Path to the file
   * @returns Array of function information
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
   * Parse Python source code using tree-sitter for more accurate results
   *
   * Tree-sitter provides a full AST which enables more accurate parsing
   * of complex Python constructs.
   *
   * @param content - Python source code
   * @param filePath - Path to the file
   * @returns Parsed result
   */
  private parseWithTreeSitter(content: string, filePath: string): ParseResult {
    // Tree-sitter parsing for more accurate results
    // For now, fall back to regex until tree-sitter queries are implemented
    // TODO: SMI-1309 - Implement tree-sitter query-based extraction
    return this.parseWithRegex(content, filePath)
  }
}
