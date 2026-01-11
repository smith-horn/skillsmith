/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * SMI-1345: Language Adapter Template
 *
 * TEMPLATE FILE - Copy this file when adding a new language adapter.
 *
 * Steps to use this template:
 * 1. Copy this file to packages/core/src/analysis/adapters/<language>.ts
 * 2. Replace all <LANGUAGE_*> placeholders with actual values
 * 3. Implement language-specific parsing logic
 * 4. Add tests using language-adapter-test-template.ts
 * 5. Register adapter in AdapterFactory
 *
 * @see docs/guides/adding-new-language-adapter.md
 * @module analysis/adapters/<language>
 */

import { LanguageAdapter, type SupportedLanguage, type FrameworkRule } from './base.js'
import type { ParseResult, ImportInfo, ExportInfo, FunctionInfo } from '../types.js'

// ============================================================
// PLACEHOLDER VALUES - Replace all <LANGUAGE_*> with actual values
// ============================================================
//
// <LANGUAGE_NAME>        - e.g., 'ruby', 'php', 'cpp', 'csharp'
// <LANGUAGE_DISPLAY>     - e.g., 'Ruby', 'PHP', 'C++', 'C#'
// <LANGUAGE_EXTENSIONS>  - e.g., ['.rb'], ['.php'], ['.cpp', '.cc', '.cxx', '.hpp', '.h']
// <LANGUAGE_CLASS_NAME>  - e.g., RubyAdapter, PhpAdapter, CppAdapter, CSharpAdapter
// <LANGUAGE_WASM_FILE>   - e.g., 'tree-sitter-ruby.wasm'
//
// ============================================================

/**
 * <LANGUAGE_DISPLAY> adapter using regex-based parsing with optional tree-sitter
 *
 * The adapter provides:
 * - Synchronous regex-based parsing for basic analysis
 * - Async tree-sitter parsing for enhanced accuracy (when available)
 * - Framework detection rules for common <LANGUAGE_DISPLAY> frameworks
 *
 * @example
 * ```typescript
 * const adapter = new <LANGUAGE_CLASS_NAME>()
 *
 * const result = adapter.parseFile(`
 *   // <LANGUAGE_DISPLAY> source code here
 * `, 'example.<ext>')
 *
 * console.log(result.imports)
 * console.log(result.functions)
 * ```
 */
export class /* <LANGUAGE_CLASS_NAME> */ LanguageNameAdapter extends LanguageAdapter {
  // ============================================================
  // Required Properties - Update these for your language
  // ============================================================

  /**
   * Language identifier - must match SupportedLanguage type
   * NOTE: Add your language to SupportedLanguage in types.ts first
   */
  readonly language: SupportedLanguage = 'typescript' // <LANGUAGE_NAME>

  /**
   * File extensions this adapter handles (including the dot)
   */
  readonly extensions = ['.ts'] // <LANGUAGE_EXTENSIONS>

  // ============================================================
  // Parser State - Tree-sitter support (optional but recommended)
  // ============================================================

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

      // Load language WASM
      // Note: Download from https://github.com/AstroNvim/astraea
      // or build from tree-sitter grammar
      const wasmPath = 'tree-sitter-<language>.wasm' // <LANGUAGE_WASM_FILE>
      const Language = await Parser.Language.load(wasmPath)
      ;(this.parser as { setLanguage: (lang: unknown) => void }).setLanguage(Language)

      this.parserInitialized = true
    } catch (error) {
      // Tree-sitter not available, will use regex fallback
      console.warn(
        '[<LANGUAGE_CLASS_NAME>] tree-sitter initialization failed, using regex fallback:',
        error instanceof Error ? error.message : String(error)
      )
      this.parserInitialized = false
    }
  }

  // ============================================================
  // Required Methods - Implement these for your language
  // ============================================================

  /**
   * Parse a file using regex-based parsing
   *
   * @param content - Source code content
   * @param filePath - Path to the file (for source tracking)
   * @returns Parsed imports, exports, and functions
   */
  parseFile(content: string, filePath: string): ParseResult {
    return this.parseWithRegex(content, filePath)
  }

  /**
   * Parse a file asynchronously with tree-sitter (if available)
   *
   * Falls back to regex parsing if tree-sitter is not available.
   *
   * @param content - Source code content
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
   * incremental parsing will be implemented when needed.
   *
   * @param content - Updated source code
   * @param filePath - Path to the file
   * @param _previousTree - Previous parse tree (not yet used)
   * @returns Parsed imports, exports, and functions
   */
  parseIncremental(content: string, filePath: string, _previousTree?: unknown): ParseResult {
    // TODO: Implement incremental parsing with tree-sitter
    return this.parseFile(content, filePath)
  }

  /**
   * Get framework detection rules for this language
   *
   * Add rules for common frameworks in your language.
   * Each rule has:
   * - name: Framework name (e.g., 'Rails', 'Laravel')
   * - depIndicators: Package/gem/dependency names
   * - importIndicators: Import/require statement patterns
   *
   * @returns Array of framework detection rules
   */
  getFrameworkRules(): FrameworkRule[] {
    // TODO: Add framework rules specific to <LANGUAGE_DISPLAY>
    // Example structure:
    return [
      // {
      //   name: 'FrameworkName',
      //   depIndicators: ['package-name'],
      //   importIndicators: ['import_pattern', 'require_pattern'],
      // },
    ]
  }

  /**
   * Clean up resources (parser instances, etc.)
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
  // Private Parsing Methods - Implement language-specific logic
  // ============================================================

  /**
   * Parse source code using regex patterns
   *
   * @param content - Source code
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
   * Extract imports from source code
   *
   * TODO: Implement language-specific import extraction
   *
   * Common patterns to handle:
   * - Standard library imports
   * - Third-party package imports
   * - Relative/local imports
   * - Aliased imports
   * - Wildcard imports
   * - Multi-line imports
   *
   * @param content - Source code
   * @param filePath - Path to the file
   * @returns Array of import information
   */
  private extractImports(content: string, filePath: string): ImportInfo[] {
    const imports: ImportInfo[] = []
    const lines = content.split('\n')

    // ============================================================
    // TODO: Add regex patterns for your language's import syntax
    // ============================================================
    //
    // Example regex patterns for common languages:
    //
    // Ruby:
    //   /^require\s+['"]([^'"]+)['"]/
    //   /^require_relative\s+['"]([^'"]+)['"]/
    //   /^include\s+(\w+)/
    //
    // PHP:
    //   /^use\s+([\w\\]+)(?:\s+as\s+(\w+))?;/
    //   /^require(?:_once)?\s+['"]([^'"]+)['"]/
    //   /^include(?:_once)?\s+['"]([^'"]+)['"]/
    //
    // C/C++:
    //   /^#include\s*[<"]([^>"]+)[>"]/
    //
    // C#:
    //   /^using\s+([\w.]+)(?:\s*=\s*([\w.]+))?;/
    //
    // ============================================================

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()

      // Skip comments and empty lines
      // TODO: Update comment detection for your language
      if (line === '' || this.isComment(line)) {
        continue
      }

      // TODO: Add import extraction logic
      // Example:
      // const importMatch = line.match(/your_import_regex/)
      // if (importMatch) {
      //   imports.push({
      //     module: importMatch[1],
      //     namedImports: [],
      //     isTypeOnly: false,
      //     sourceFile: filePath,
      //     language: this.language,
      //     line: i + 1,
      //   })
      // }
    }

    return imports
  }

  /**
   * Extract exports from source code
   *
   * TODO: Implement language-specific export extraction
   *
   * Consider how your language defines "exports":
   * - Public classes/functions (visibility modifiers)
   * - Module exports (module.exports, __all__, etc.)
   * - Package-level visibility
   *
   * @param content - Source code
   * @param filePath - Path to the file
   * @returns Array of export information
   */
  private extractExports(content: string, filePath: string): ExportInfo[] {
    const exports: ExportInfo[] = []
    const lines = content.split('\n')

    // ============================================================
    // TODO: Add regex patterns for your language's export syntax
    // ============================================================
    //
    // Example patterns:
    //
    // Ruby (public methods/classes are exports):
    //   /^class\s+(\w+)/
    //   /^module\s+(\w+)/
    //   /^def\s+(\w+)/  (at top level)
    //
    // PHP:
    //   /^class\s+(\w+)/
    //   /^function\s+(\w+)/
    //
    // C# (public members):
    //   /^public\s+class\s+(\w+)/
    //   /^public\s+(?:static\s+)?(?:async\s+)?\w+\s+(\w+)\s*\(/
    //
    // ============================================================

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // TODO: Add export extraction logic
      // Consider:
      // - Visibility modifiers (public, private, etc.)
      // - Module/package level exports
      // - Default exports vs named exports
    }

    return exports
  }

  /**
   * Extract function definitions from source code
   *
   * TODO: Implement language-specific function extraction
   *
   * Information to extract:
   * - Function name
   * - Parameter count
   * - Whether async (if applicable)
   * - Whether exported/public
   * - Line number
   *
   * @param content - Source code
   * @param filePath - Path to the file
   * @returns Array of function information
   */
  private extractFunctions(content: string, filePath: string): FunctionInfo[] {
    const functions: FunctionInfo[] = []
    const lines = content.split('\n')

    // ============================================================
    // TODO: Add regex patterns for your language's function syntax
    // ============================================================
    //
    // Example patterns:
    //
    // Ruby:
    //   /^(\s*)def\s+(\w+)(?:\s*\(([^)]*)\))?/
    //
    // PHP:
    //   /^(\s*)(?:public|private|protected)?\s*(?:static)?\s*function\s+(\w+)\s*\(([^)]*)\)/
    //
    // C/C++:
    //   /^(\s*)(?:\w+\s+)+(\w+)\s*\(([^)]*)\)\s*{?/
    //
    // C#:
    //   /^(\s*)(?:public|private|protected)?\s*(?:static)?\s*(?:async)?\s*\w+\s+(\w+)\s*\(([^)]*)\)/
    //
    // ============================================================

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // TODO: Add function extraction logic
      // const match = line.match(/your_function_regex/)
      // if (match) {
      //   const indentation = match[1]
      //   const name = match[2]
      //   const paramsStr = match[3] || ''
      //
      //   // Count parameters
      //   const params = paramsStr
      //     .split(',')
      //     .map(p => p.trim())
      //     .filter(p => p !== '')
      //
      //   // Determine if exported based on language rules
      //   const isTopLevel = indentation === ''
      //   const isExported = isTopLevel && !name.startsWith('_')
      //
      //   functions.push({
      //     name,
      //     parameterCount: params.length,
      //     isAsync: false, // Detect async if language supports it
      //     isExported,
      //     sourceFile: filePath,
      //     language: this.language,
      //     line: i + 1,
      //   })
      // }
    }

    return functions
  }

  /**
   * Parse source code using tree-sitter for more accurate results
   *
   * Tree-sitter provides a full AST which enables more accurate parsing
   * of complex constructs.
   *
   * @param content - Source code
   * @param filePath - Path to the file
   * @returns Parsed result
   */
  private parseWithTreeSitter(content: string, filePath: string): ParseResult {
    // TODO: Implement tree-sitter query-based extraction
    // For now, fall back to regex until tree-sitter queries are implemented
    return this.parseWithRegex(content, filePath)
  }

  // ============================================================
  // Helper Methods
  // ============================================================

  /**
   * Check if a line is a comment
   *
   * TODO: Update for your language's comment syntax
   *
   * @param line - Line to check
   * @returns True if line is a comment
   */
  private isComment(line: string): boolean {
    // TODO: Update these patterns for your language
    // Common patterns:
    // - // single line (C-style)
    // - # single line (Python, Ruby, Shell)
    // - -- single line (SQL, Lua)
    // - /* multi-line */ (C-style)
    // - ''' or """ (Python docstrings)

    return (
      line.startsWith('//') || line.startsWith('#') || line.startsWith('/*') || line.startsWith('*')
    )
  }

  /**
   * Parse comma-separated parameter/import names
   *
   * Handles common patterns like aliases (name as alias)
   *
   * @param namesStr - Comma-separated string of names
   * @returns Array of names (without aliases)
   */
  private parseNames(namesStr: string): string[] {
    return namesStr
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n !== '')
      .map((n) => {
        // Handle 'name as alias' patterns
        // TODO: Update for your language's alias syntax
        const asMatch = n.match(/^(\w+)\s+as\s+\w+$/)
        if (asMatch) return asMatch[1]
        return n.replace(/[()]/g, '').trim()
      })
      .filter((n) => n !== '')
  }
}

// ============================================================
// CHECKLIST - Complete these steps before submitting
// ============================================================
//
// [ ] Update SupportedLanguage type in types.ts
// [ ] Update LANGUAGE_EXTENSIONS mapping in types.ts
// [ ] Replace all <LANGUAGE_*> placeholders in this file
// [ ] Implement extractImports() with language-specific regex
// [ ] Implement extractExports() with language-specific regex
// [ ] Implement extractFunctions() with language-specific regex
// [ ] Update isComment() for language's comment syntax
// [ ] Add framework detection rules in getFrameworkRules()
// [ ] Create comprehensive tests using test template
// [ ] Register adapter in AdapterFactory
// [ ] Add tree-sitter WASM file (optional but recommended)
// [ ] Update documentation
//
// ============================================================
