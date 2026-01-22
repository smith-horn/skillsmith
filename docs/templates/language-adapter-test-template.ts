/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * SMI-1345: Language Adapter Test Template
 *
 * TEMPLATE FILE - Copy this file when adding tests for a new language adapter.
 *
 * Steps to use this template:
 * 1. Copy to packages/core/src/analysis/adapters/__tests__/<language>.test.ts
 * 2. Replace all <LANGUAGE_*> placeholders with actual values
 * 3. Update test cases with language-specific syntax examples
 * 4. Add edge cases specific to your language
 *
 * @see docs/guides/adding-new-language-adapter.md
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// TODO: Update import path to your adapter
// import { <LANGUAGE_CLASS_NAME> } from '../<language>.js'
import type { ParseResult } from '../../types.js'

// Placeholder - replace with actual adapter import
class LanguageNameAdapter {
  readonly language = 'typescript'
  readonly extensions = ['.ts']
  canHandle(filePath: string): boolean {
    return filePath.endsWith('.ts')
  }
  parseFile(content: string, filePath: string): ParseResult {
    return { imports: [], exports: [], functions: [] }
  }
  parseIncremental(content: string, filePath: string): ParseResult {
    return this.parseFile(content, filePath)
  }
  getFrameworkRules() {
    return []
  }
  dispose(): void {}
}

// ============================================================
// PLACEHOLDER VALUES - Replace all <LANGUAGE_*> with actual values
// ============================================================
//
// <LANGUAGE_NAME>        - e.g., 'ruby', 'php', 'cpp', 'csharp'
// <LANGUAGE_DISPLAY>     - e.g., 'Ruby', 'PHP', 'C++', 'C#'
// <LANGUAGE_CLASS_NAME>  - e.g., RubyAdapter, PhpAdapter, CppAdapter
// <EXT>                  - e.g., 'rb', 'php', 'cpp', 'cs'
// <EXT_ALT>              - alternative extensions if applicable
//
// ============================================================

describe('<LANGUAGE_CLASS_NAME>', () => {
  let adapter: LanguageNameAdapter

  beforeEach(() => {
    adapter = new LanguageNameAdapter()
  })

  afterEach(() => {
    adapter.dispose()
  })

  // ============================================================
  // canHandle Tests
  // ============================================================

  describe('canHandle', () => {
    it('handles primary extension files', () => {
      // TODO: Update with your language's primary extension
      expect(adapter.canHandle('main.<EXT>')).toBe(true)
      expect(adapter.canHandle('/path/to/script.<EXT>')).toBe(true)
    })

    // TODO: Add tests for alternative extensions if applicable
    // it('handles alternative extension files', () => {
    //   expect(adapter.canHandle('types.<EXT_ALT>')).toBe(true)
    // })

    it('does not handle other file types', () => {
      expect(adapter.canHandle('main.ts')).toBe(false)
      expect(adapter.canHandle('main.js')).toBe(false)
      expect(adapter.canHandle('main.py')).toBe(false)
      expect(adapter.canHandle('main.go')).toBe(false)
      expect(adapter.canHandle('main.rs')).toBe(false)
      expect(adapter.canHandle('main.java')).toBe(false)
      expect(adapter.canHandle('main.txt')).toBe(false)
    })

    it('handles case insensitively (for cross-platform compatibility)', () => {
      // TODO: Update with your language's extension
      expect(adapter.canHandle('main.<EXT_UPPER>')).toBe(true)
    })
  })

  // ============================================================
  // parseFile - Import Extraction Tests
  // ============================================================

  describe('parseFile - imports', () => {
    it('extracts simple import statements', () => {
      // TODO: Replace with your language's import syntax
      const content = `
// Example: import something
// Your language's import syntax here
      `

      const result = adapter.parseFile(content, 'test.<EXT>')

      // TODO: Update assertions based on expected behavior
      expect(result.imports.length).toBeGreaterThanOrEqual(0)
    })

    it('extracts import with alias', () => {
      // TODO: Replace with your language's aliased import syntax
      const content = `
// Example: import something as alias
      `

      const result = adapter.parseFile(content, 'test.<EXT>')

      // TODO: Add assertions
      expect(result.imports.length).toBeGreaterThanOrEqual(0)
    })

    it('extracts named imports', () => {
      // TODO: Replace with your language's named import syntax
      const content = `
// Example: from module import name1, name2
      `

      const result = adapter.parseFile(content, 'test.<EXT>')

      // TODO: Add assertions for namedImports array
      expect(result.imports.length).toBeGreaterThanOrEqual(0)
    })

    it('extracts wildcard imports', () => {
      // TODO: Replace with your language's wildcard import syntax
      const content = `
// Example: from module import *
      `

      const result = adapter.parseFile(content, 'test.<EXT>')

      // TODO: Check namespaceImport field
      expect(result.imports.length).toBeGreaterThanOrEqual(0)
    })

    it('extracts multi-line imports', () => {
      // TODO: Replace with your language's multi-line import syntax
      const content = `
// Example:
// from module import (
//   item1,
//   item2,
//   item3,
// )
      `

      const result = adapter.parseFile(content, 'test.<EXT>')

      // TODO: Verify all items are captured
      expect(result.imports.length).toBeGreaterThanOrEqual(0)
    })

    it('skips comments and empty lines', () => {
      // TODO: Replace with your language's comment syntax
      const content = `
// This is a comment
# Alternative comment style

// import statement here
      `

      const result = adapter.parseFile(content, 'test.<EXT>')

      // Should not extract comments as imports
      expect(result.imports.length).toBeGreaterThanOrEqual(0)
    })

    it('includes line numbers', () => {
      // TODO: Replace with actual import statements
      const content = `// import on line 1
// import on line 2
`

      const result = adapter.parseFile(content, 'test.<EXT>')

      // Check line numbers are captured
      if (result.imports.length > 0) {
        expect(result.imports[0].line).toBeDefined()
      }
    })
  })

  // ============================================================
  // parseFile - Export Extraction Tests
  // ============================================================

  describe('parseFile - exports', () => {
    it('extracts public class exports', () => {
      // TODO: Replace with your language's class syntax
      const content = `
// public class PublicClass { }
// private class _PrivateClass { }
      `

      const result = adapter.parseFile(content, 'test.<EXT>')

      const exportNames = result.exports.map((e) => e.name)
      // TODO: Verify public classes are exported, private are not
      expect(exportNames.length).toBeGreaterThanOrEqual(0)
    })

    it('extracts public function exports', () => {
      // TODO: Replace with your language's function syntax
      const content = `
// public function publicFunc() { }
// private function _privateFunc() { }
      `

      const result = adapter.parseFile(content, 'test.<EXT>')

      const exportNames = result.exports.map((e) => e.name)
      // TODO: Verify public functions are exported
      expect(exportNames.length).toBeGreaterThanOrEqual(0)
    })

    it('identifies export kinds correctly', () => {
      // TODO: Replace with mixed content
      const content = `
// function myFunction() { }
// class MyClass { }
      `

      const result = adapter.parseFile(content, 'test.<EXT>')

      // Check kind property is set correctly
      const funcExport = result.exports.find((e) => e.name === 'myFunction')
      const classExport = result.exports.find((e) => e.name === 'MyClass')

      if (funcExport) expect(funcExport.kind).toBe('function')
      if (classExport) expect(classExport.kind).toBe('class')
    })

    it('does not export methods (only top-level)', () => {
      // TODO: Replace with class with methods
      const content = `
// class MyClass {
//   method() { }
// }
      `

      const result = adapter.parseFile(content, 'test.<EXT>')

      const exportNames = result.exports.map((e) => e.name)
      // Methods should not appear as exports
      expect(exportNames).not.toContain('method')
    })
  })

  // ============================================================
  // parseFile - Function Extraction Tests
  // ============================================================

  describe('parseFile - functions', () => {
    it('extracts sync function definitions', () => {
      // TODO: Replace with your language's function syntax
      const content = `
// function syncFunction(a, b, c) { }
      `

      const result = adapter.parseFile(content, 'test.<EXT>')

      expect(result.functions.length).toBeGreaterThanOrEqual(0)
      if (result.functions.length > 0) {
        expect(result.functions[0]).toMatchObject({
          name: 'syncFunction',
          parameterCount: 3,
          isAsync: false,
        })
      }
    })

    // TODO: Only include if your language supports async
    it('extracts async function definitions', () => {
      // TODO: Replace with your language's async syntax
      const content = `
// async function asyncFunction(x) { }
      `

      const result = adapter.parseFile(content, 'test.<EXT>')

      if (result.functions.length > 0) {
        expect(result.functions[0].isAsync).toBe(true)
      }
    })

    it('counts parameters correctly', () => {
      // TODO: Replace with functions having various parameter counts
      const content = `
// function noParams() { }
// function oneParam(a) { }
// function manyParams(a, b, c, d) { }
      `

      const result = adapter.parseFile(content, 'test.<EXT>')

      // Verify parameter counts
      const noParams = result.functions.find((f) => f.name === 'noParams')
      const oneParam = result.functions.find((f) => f.name === 'oneParam')
      const manyParams = result.functions.find((f) => f.name === 'manyParams')

      if (noParams) expect(noParams.parameterCount).toBe(0)
      if (oneParam) expect(oneParam.parameterCount).toBe(1)
      if (manyParams) expect(manyParams.parameterCount).toBe(4)
    })

    it('marks top-level functions as exported', () => {
      // TODO: Replace with top-level and nested functions
      const content = `
// function topLevel() { }
// class MyClass {
//   method() { }
// }
      `

      const result = adapter.parseFile(content, 'test.<EXT>')

      const topLevel = result.functions.find((f) => f.name === 'topLevel')
      const method = result.functions.find((f) => f.name === 'method')

      if (topLevel) expect(topLevel.isExported).toBe(true)
      if (method) expect(method.isExported).toBe(false)
    })

    it('includes line numbers', () => {
      // TODO: Replace with actual functions
      const content = `// function first() { }

// function second() { }
`

      const result = adapter.parseFile(content, 'test.<EXT>')

      if (result.functions.length >= 2) {
        expect(result.functions[0].line).toBe(1)
        expect(result.functions[1].line).toBe(3)
      }
    })
  })

  // ============================================================
  // parseFile - Complete File Tests
  // ============================================================

  describe('parseFile - complete parsing', () => {
    it('parses a complete application file', () => {
      // TODO: Replace with a realistic example file in your language
      const content = `
// Example: A complete file with imports, classes, functions
//
// import framework
// from utils import helper
//
// class UserController {
//   def index(request) { }
//   def show(request, id) { }
// }
//
// function main() { }
      `

      const result = adapter.parseFile(content, 'app.<EXT>')

      // Verify imports
      expect(result.imports.length).toBeGreaterThanOrEqual(0)

      // Verify exports
      expect(result.exports.length).toBeGreaterThanOrEqual(0)

      // Verify functions
      expect(result.functions.length).toBeGreaterThanOrEqual(0)
    })

    it('returns empty arrays for empty file', () => {
      const result = adapter.parseFile('', 'empty.<EXT>')

      expect(result.imports).toEqual([])
      expect(result.exports).toEqual([])
      expect(result.functions).toEqual([])
    })

    it('handles file with only comments', () => {
      // TODO: Replace with your language's comment styles
      const content = `
// This is a comment
// Another comment
/*
 * Block comment
 */
      `

      const result = adapter.parseFile(content, 'comments.<EXT>')

      expect(result.imports).toEqual([])
      expect(result.exports).toEqual([])
      expect(result.functions).toEqual([])
    })
  })

  // ============================================================
  // getFrameworkRules Tests
  // ============================================================

  describe('getFrameworkRules', () => {
    // TODO: Add tests for each framework your adapter detects
    // Example structure:

    // it('includes <FRAMEWORK_NAME> detection rules', () => {
    //   const rules = adapter.getFrameworkRules()
    //   const framework = rules.find((r) => r.name === '<FRAMEWORK_NAME>')
    //
    //   expect(framework).toBeDefined()
    //   expect(framework?.depIndicators).toContain('<package-name>')
    //   expect(framework?.importIndicators).toContain('<import-pattern>')
    // })

    it('returns array (possibly empty if no frameworks defined)', () => {
      const rules = adapter.getFrameworkRules()
      expect(Array.isArray(rules)).toBe(true)
    })
  })

  // ============================================================
  // parseIncremental Tests
  // ============================================================

  describe('parseIncremental', () => {
    it('falls back to full parsing without previous tree', () => {
      // TODO: Replace with simple function
      const content = `
// function myFunction() { }
      `

      const result = adapter.parseIncremental(content, 'test.<EXT>')

      // Should produce same result as parseFile
      expect(result.functions.length).toBeGreaterThanOrEqual(0)
    })

    it('handles incremental updates', () => {
      // TODO: Replace with your language's syntax
      const content1 = `
// function original() { }
      `
      const content2 = `
// function original() { }
// function newFunction() { }
      `

      const result1 = adapter.parseIncremental(content1, 'test.<EXT>')
      const result2 = adapter.parseIncremental(content2, 'test.<EXT>')

      // Second parse should find more functions
      expect(result2.functions.length).toBeGreaterThanOrEqual(result1.functions.length)
    })
  })

  // ============================================================
  // dispose Tests
  // ============================================================

  describe('dispose', () => {
    it('can be called multiple times without error', () => {
      adapter.dispose()
      adapter.dispose()
      adapter.dispose()

      // Should not throw
      expect(true).toBe(true)
    })

    it('cleans up parser resources', () => {
      // Parse something to initialize any internal state
      adapter.parseFile('// some code', 'test.<EXT>')

      // Dispose should clean up
      adapter.dispose()

      // Should still be able to parse after dispose
      const result = adapter.parseFile('// more code', 'test.<EXT>')
      expect(result).toBeDefined()
    })
  })

  // ============================================================
  // Language and Extensions Properties Tests
  // ============================================================

  describe('properties', () => {
    it('has correct language identifier', () => {
      // TODO: Update with your language name
      expect(adapter.language).toBe('<LANGUAGE_NAME>')
    })

    it('has correct extensions', () => {
      // TODO: Update with your language's extensions
      expect(adapter.extensions).toContain('.<EXT>')
      // Add more extension checks if applicable
    })
  })

  // ============================================================
  // Edge Cases - Language Specific
  // ============================================================

  describe('edge cases', () => {
    // TODO: Add edge cases specific to your language
    // Common edge cases to consider:

    it('handles nested functions/classes', () => {
      // TODO: If your language supports nested definitions
      const content = `
// function outer() {
//   function inner() { }
// }
      `

      const result = adapter.parseFile(content, 'test.<EXT>')

      // Verify nested functions are found
      expect(result.functions.length).toBeGreaterThanOrEqual(0)
    })

    it('handles decorators/annotations', () => {
      // TODO: If your language has decorators/annotations
      const content = `
// @decorator
// function decorated() { }
      `

      const result = adapter.parseFile(content, 'test.<EXT>')

      // Should find decorated functions
      expect(result.functions.length).toBeGreaterThanOrEqual(0)
    })

    it('handles generics/templates', () => {
      // TODO: If your language has generics/templates
      const content = `
// function generic<T>(param: T): T { }
// class Container<T> { }
      `

      const result = adapter.parseFile(content, 'test.<EXT>')

      // Should parse without errors
      expect(result).toBeDefined()
    })

    it('handles multiline signatures', () => {
      // TODO: If your language allows multiline function signatures
      const content = `
// function longFunction(
//   param1,
//   param2,
//   param3
// ) { }
      `

      const result = adapter.parseFile(content, 'test.<EXT>')

      // May or may not find the function depending on implementation
      expect(result).toBeDefined()
    })

    it('handles relative imports', () => {
      // TODO: If your language has relative import syntax
      const content = `
// from . import module
// from .. import parentModule
      `

      const result = adapter.parseFile(content, 'test.<EXT>')

      expect(result.imports.length).toBeGreaterThanOrEqual(0)
    })

    it('handles special characters in strings (no false positives)', () => {
      // TODO: Ensure parsing doesn't match content inside strings
      const content = `
// const str = "import fakeImport from 'fake'"
// const comment = "// not a real comment"
      `

      const result = adapter.parseFile(content, 'test.<EXT>')

      // Should not find fake import from string content
      const fakeImport = result.imports.find((i) => i.module === 'fake')
      expect(fakeImport).toBeUndefined()
    })
  })
})

// ============================================================
// CHECKLIST - Complete these steps before submitting
// ============================================================
//
// [ ] Replace all <LANGUAGE_*> placeholders
// [ ] Update import statement to actual adapter
// [ ] Replace placeholder content with real language syntax
// [ ] Add language-specific import test cases
// [ ] Add language-specific export test cases
// [ ] Add language-specific function test cases
// [ ] Add framework detection tests
// [ ] Add edge cases for language-specific features:
//     [ ] Decorators/annotations
//     [ ] Generics/templates
//     [ ] Nested definitions
//     [ ] Multi-line constructs
//     [ ] String/comment handling
// [ ] Run tests with: docker exec skillsmith-dev-1 npm test
// [ ] Verify >80% coverage for new adapter
//
// ============================================================
