/**
 * SMI-600: Source File Parsers
 * SMI-1189: Extracted from CodebaseAnalyzer.ts
 *
 * Functions for parsing TypeScript/JavaScript source files
 * and extracting imports, exports, and functions.
 */

import * as ts from 'typescript'
import type { ImportInfo, ExportInfo, FunctionInfo, ParseResult } from './types.js'

/**
 * Parse a single file and extract information
 *
 * @param content - File content to parse
 * @param relativePath - Relative path for source file tracking
 * @returns Parsed imports, exports, and functions
 */
export function parseFile(content: string, relativePath: string): ParseResult {
  const imports: ImportInfo[] = []
  const exports: ExportInfo[] = []
  const functions: FunctionInfo[] = []

  // Create source file
  const sourceFile = ts.createSourceFile(
    relativePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith('.tsx') || relativePath.endsWith('.jsx')
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS
  )

  // Walk the AST
  const visit = (node: ts.Node): void => {
    // Import declarations
    if (ts.isImportDeclaration(node)) {
      const importInfo = extractImport(node, relativePath)
      if (importInfo) {
        imports.push(importInfo)
      }
    }

    // Export declarations
    if (ts.isExportDeclaration(node) || ts.isExportAssignment(node)) {
      const exportInfos = extractExport(node, relativePath)
      exports.push(...exportInfos)
    }

    // Function declarations
    if (ts.isFunctionDeclaration(node) && node.name) {
      const funcInfo = extractFunction(node, relativePath, sourceFile)
      if (funcInfo) {
        functions.push(funcInfo)

        // Also track as export if exported
        if (funcInfo.isExported) {
          const isDefault = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
          exports.push({
            name: node.name.text,
            kind: 'function',
            isDefault: isDefault ?? false,
            sourceFile: relativePath,
          })
        }
      }
    }

    // Arrow functions assigned to variables
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (
          decl.initializer &&
          ts.isArrowFunction(decl.initializer) &&
          ts.isIdentifier(decl.name)
        ) {
          const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
          functions.push({
            name: decl.name.text,
            parameterCount: decl.initializer.parameters.length,
            isAsync:
              decl.initializer.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ??
              false,
            isExported: isExported ?? false,
            sourceFile: relativePath,
            line: line + 1,
          })

          // Also track as export if exported
          if (isExported) {
            exports.push({
              name: decl.name.text,
              kind: 'function',
              isDefault: false,
              sourceFile: relativePath,
            })
          }
        }
      }
    }

    // Class declarations
    if (ts.isClassDeclaration(node) && node.name) {
      const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      const isDefault = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)

      if (isExported) {
        exports.push({
          name: node.name.text,
          kind: 'class',
          isDefault: isDefault ?? false,
          sourceFile: relativePath,
        })
      }
    }

    // Interface declarations
    if (ts.isInterfaceDeclaration(node)) {
      const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)

      if (isExported) {
        exports.push({
          name: node.name.text,
          kind: 'interface',
          isDefault: false,
          sourceFile: relativePath,
        })
      }
    }

    // Type alias declarations
    if (ts.isTypeAliasDeclaration(node)) {
      const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)

      if (isExported) {
        exports.push({
          name: node.name.text,
          kind: 'type',
          isDefault: false,
          sourceFile: relativePath,
        })
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  return { imports, exports, functions }
}

/**
 * Extract import information from an import declaration
 *
 * @param node - Import declaration node
 * @param sourceFile - Source file path
 * @returns Import info or null if invalid
 */
export function extractImport(node: ts.ImportDeclaration, sourceFile: string): ImportInfo | null {
  const moduleSpecifier = node.moduleSpecifier
  if (!ts.isStringLiteral(moduleSpecifier)) {
    return null
  }

  const importInfo: ImportInfo = {
    module: moduleSpecifier.text,
    namedImports: [],
    isTypeOnly: node.importClause?.isTypeOnly ?? false,
    sourceFile,
  }

  const importClause = node.importClause
  if (importClause) {
    // Default import
    if (importClause.name) {
      importInfo.defaultImport = importClause.name.text
    }

    // Named imports
    const namedBindings = importClause.namedBindings
    if (namedBindings) {
      if (ts.isNamespaceImport(namedBindings)) {
        importInfo.namespaceImport = namedBindings.name.text
      } else if (ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          importInfo.namedImports.push(element.name.text)
        }
      }
    }
  }

  return importInfo
}

/**
 * Extract export information from an export declaration
 *
 * @param node - Export declaration or assignment node
 * @param sourceFile - Source file path
 * @returns Array of export info
 */
export function extractExport(
  node: ts.ExportDeclaration | ts.ExportAssignment,
  sourceFile: string
): ExportInfo[] {
  const exports: ExportInfo[] = []

  if (ts.isExportAssignment(node)) {
    // export default X
    exports.push({
      name: 'default',
      kind: 'unknown',
      isDefault: true,
      sourceFile,
    })
  } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
    // export { X, Y }
    for (const element of node.exportClause.elements) {
      exports.push({
        name: element.name.text,
        kind: 'unknown',
        isDefault: false,
        sourceFile,
      })
    }
  }

  return exports
}

/**
 * Extract function information from a function declaration
 *
 * @param node - Function declaration node
 * @param relativePath - Relative file path
 * @param sourceFile - Source file for position lookup
 * @returns Function info or null if no name
 */
export function extractFunction(
  node: ts.FunctionDeclaration,
  relativePath: string,
  sourceFile: ts.SourceFile
): FunctionInfo | null {
  if (!node.name) return null

  const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  const isAsync = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)

  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())

  return {
    name: node.name.text,
    parameterCount: node.parameters.length,
    isAsync: isAsync ?? false,
    isExported: isExported ?? false,
    sourceFile: relativePath,
    line: line + 1,
  }
}
