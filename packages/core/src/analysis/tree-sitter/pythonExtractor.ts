/**
 * SMI-4293: Python query-based extraction
 *
 * Uses tree-sitter queries to extract imports, exports, and functions from
 * a parsed Python AST, producing the same ParseResult shape as the regex
 * fallback. Regression guard (finding H3): the query extractor must produce
 * a superset-or-equal result set compared to the regex baseline on every
 * fixture. Tests enforce that invariant.
 *
 * @see docs/internal/implementation/github-wave-5c-tree-sitter-incremental.md
 * @module analysis/tree-sitter/pythonExtractor
 */

import type { ParseResult, ImportInfo, ExportInfo, FunctionInfo } from '../types.js'
import type { TreeSitterLanguage, TreeSitterNode, TreeSitterTree } from './manager.js'
import {
  PYTHON_IMPORT_QUERY,
  PYTHON_FROM_IMPORT_QUERY,
  PYTHON_FUNCTION_QUERY,
  PYTHON_CLASS_QUERY,
  PYTHON_ALL_EXPORT_QUERY,
} from './queries/python.js'

/** Minimal subset of the web-tree-sitter Query API we rely on. */
export interface TreeSitterQuery {
  captures(node: TreeSitterNode): Array<{ name: string; node: TreeSitterNode }>
}

/** Constructor signature for the Query class (imported from web-tree-sitter). */
export type QueryCtor = new (lang: TreeSitterLanguage, src: string) => TreeSitterQuery

/**
 * Lazily compile and cache all Python queries for a given Language module.
 * Queries are expensive to construct (parse the DSL); compiled once per
 * Language and reused across parses.
 */
export class PythonQuerySet {
  readonly imports: TreeSitterQuery
  readonly fromImports: TreeSitterQuery
  readonly functions: TreeSitterQuery
  readonly classes: TreeSitterQuery
  readonly allExports: TreeSitterQuery

  constructor(Query: QueryCtor, lang: TreeSitterLanguage) {
    this.imports = new Query(lang, PYTHON_IMPORT_QUERY)
    this.fromImports = new Query(lang, PYTHON_FROM_IMPORT_QUERY)
    this.functions = new Query(lang, PYTHON_FUNCTION_QUERY)
    this.classes = new Query(lang, PYTHON_CLASS_QUERY)
    this.allExports = new Query(lang, PYTHON_ALL_EXPORT_QUERY)
  }
}

interface NamedFunctionCapture {
  name: string
  params: TreeSitterNode | null
  def: TreeSitterNode
}

/**
 * Extract a ParseResult from a Python parse tree using tree-sitter queries.
 *
 * This replaces the regex fallback in the query-based code path. It MUST
 * produce results that are a superset or equal set of the regex extraction
 * for every fixture (finding H3).
 */
export function extractPythonParseResult(
  tree: TreeSitterTree,
  queries: PythonQuerySet,
  filePath: string
): ParseResult {
  const root = tree.rootNode
  return {
    imports: [
      ...extractImports(root, queries.imports, filePath),
      ...extractFromImports(root, queries.fromImports, filePath),
    ],
    exports: extractExports(root, queries.classes, queries.functions, queries.allExports, filePath),
    functions: extractFunctions(root, queries.functions, filePath),
  }
}

// ------------------------------------------------------------------
// Imports
// ------------------------------------------------------------------

function extractImports(
  root: TreeSitterNode,
  query: TreeSitterQuery,
  filePath: string
): ImportInfo[] {
  const imports: ImportInfo[] = []
  const caps = query.captures(root)
  // Group captures by the enclosing import_statement node.
  const byStatement = groupCapturesByAncestor(caps, 'import_statement')
  for (const { node, captures } of byStatement) {
    const moduleCap = captures.find((c) => c.name === 'import.module')
    if (!moduleCap) continue
    const aliasCap = captures.find((c) => c.name === 'import.alias')
    imports.push({
      module: moduleCap.node.text,
      namedImports: [],
      defaultImport: aliasCap?.node.text,
      isTypeOnly: false,
      sourceFile: filePath,
      line: node.startPosition.row + 1,
    })
  }
  return imports
}

function extractFromImports(
  root: TreeSitterNode,
  query: TreeSitterQuery,
  filePath: string
): ImportInfo[] {
  const imports: ImportInfo[] = []
  const caps = query.captures(root)
  const byStatement = groupCapturesByAncestor(caps, 'import_from_statement')
  for (const { node, captures } of byStatement) {
    const moduleCap = captures.find((c) => c.name === 'from.module')
    if (!moduleCap) continue
    const wildcardCap = captures.find((c) => c.name === 'from.wildcard')
    const nameCaps = captures.filter((c) => c.name === 'from.name')
    imports.push({
      module: moduleCap.node.text,
      namedImports: wildcardCap ? [] : nameCaps.map((c) => stripAliasSuffix(c.node.text)),
      namespaceImport: wildcardCap ? '*' : undefined,
      isTypeOnly: false,
      sourceFile: filePath,
      line: node.startPosition.row + 1,
    })
  }
  return imports
}

/**
 * When the `from x import a as b` form is captured, the `from.name` capture
 * covers the full `aliased_import` node, whose text is `a as b`. Strip the
 * alias suffix so the extracted name matches what the regex path records.
 */
function stripAliasSuffix(text: string): string {
  const match = /^(\w+)\s+as\s+\w+$/.exec(text.trim())
  return match ? match[1] : text
}

// ------------------------------------------------------------------
// Functions
// ------------------------------------------------------------------

function extractFunctions(
  root: TreeSitterNode,
  query: TreeSitterQuery,
  filePath: string
): FunctionInfo[] {
  const capturesByDef = collectFunctionCaptures(root, query)
  const functions: FunctionInfo[] = []
  for (const capture of capturesByDef) {
    const { name, params, def } = capture
    if (!name) continue
    const paramCount = countPythonParams(params)
    const isAsync = def.children.some((c) => c.type === 'async')
    const isTopLevel = def.startPosition.column === 0
    const isExported = isTopLevel && !name.startsWith('_')
    functions.push({
      name,
      parameterCount: paramCount,
      isAsync,
      isExported,
      sourceFile: filePath,
      line: def.startPosition.row + 1,
    })
  }
  return functions
}

function collectFunctionCaptures(
  root: TreeSitterNode,
  query: TreeSitterQuery
): NamedFunctionCapture[] {
  const caps = query.captures(root)
  const byDef = groupCapturesByAncestor(caps, 'function_definition')
  const out: NamedFunctionCapture[] = []
  for (const { node, captures } of byDef) {
    const name = captures.find((c) => c.name === 'function.name')?.node.text
    if (!name) continue
    const params = captures.find((c) => c.name === 'function.params')?.node ?? null
    out.push({ name, params, def: node })
  }
  return out
}

function countPythonParams(params: TreeSitterNode | null): number {
  if (!params) return 0
  let count = 0
  for (let i = 0; i < params.namedChildCount; i++) {
    const child = params.namedChild(i)
    if (!child) continue
    const text = child.text.trim()
    if (text === 'self' || text === 'cls') continue
    if (child.type === 'identifier' || child.type === 'typed_parameter') count++
    else if (child.type === 'default_parameter' || child.type === 'typed_default_parameter') count++
    else if (child.type === 'list_splat_pattern' || child.type === 'dictionary_splat_pattern')
      count++
  }
  return count
}

// ------------------------------------------------------------------
// Exports (__all__, top-level class/function names)
// ------------------------------------------------------------------

function extractExports(
  root: TreeSitterNode,
  classesQuery: TreeSitterQuery,
  functionsQuery: TreeSitterQuery,
  allQuery: TreeSitterQuery,
  filePath: string
): ExportInfo[] {
  const exports: ExportInfo[] = []
  const explicit = new Set<string>()

  // 1. __all__ literal
  const allCaps = allQuery.captures(root)
  for (const cap of allCaps) {
    if (cap.name !== 'all.name') continue
    const raw = cap.node.text.replace(/^['"]|['"]$/g, '')
    if (!raw) continue
    explicit.add(raw)
    exports.push({
      name: raw,
      kind: 'unknown',
      isDefault: false,
      sourceFile: filePath,
    })
  }

  // 2. Top-level class definitions
  const classCaps = groupCapturesByAncestor(classesQuery.captures(root), 'class_definition')
  for (const { node, captures } of classCaps) {
    if (node.startPosition.column !== 0) continue
    const name = captures.find((c) => c.name === 'class.name')?.node.text
    if (!name || name.startsWith('_') || explicit.has(name)) continue
    exports.push({
      name,
      kind: 'class',
      isDefault: false,
      sourceFile: filePath,
      line: node.startPosition.row + 1,
    })
  }

  // 3. Top-level function definitions
  const funcCaps = groupCapturesByAncestor(functionsQuery.captures(root), 'function_definition')
  for (const { node, captures } of funcCaps) {
    if (node.startPosition.column !== 0) continue
    const name = captures.find((c) => c.name === 'function.name')?.node.text
    if (!name || name.startsWith('_') || explicit.has(name)) continue
    exports.push({
      name,
      kind: 'function',
      isDefault: false,
      sourceFile: filePath,
      line: node.startPosition.row + 1,
    })
  }

  return exports
}

// ------------------------------------------------------------------
// Utilities
// ------------------------------------------------------------------

interface GroupedCaptures {
  node: TreeSitterNode
  captures: Array<{ name: string; node: TreeSitterNode }>
}

/**
 * Group query captures by their nearest enclosing ancestor of the given type.
 * This bundles all captures that belong to the same syntactic construct,
 * sidestepping the need for `@parent` captures in the query DSL.
 *
 * Keyed by the ancestor's byte range (rather than object identity) because
 * web-tree-sitter instantiates wrapper node objects lazily, so two lookups
 * of the same underlying node can return different wrappers.
 */
function groupCapturesByAncestor(
  caps: Array<{ name: string; node: TreeSitterNode }>,
  ancestorType: string
): GroupedCaptures[] {
  const buckets = new Map<string, GroupedCaptures>()
  for (const cap of caps) {
    const ancestor = findAncestor(cap.node, ancestorType)
    if (!ancestor) continue
    const key = ancestorKey(ancestor)
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { node: ancestor, captures: [] }
      buckets.set(key, bucket)
    }
    bucket.captures.push(cap)
  }
  return Array.from(buckets.values())
}

function ancestorKey(node: TreeSitterNode): string {
  const withRange = node as TreeSitterNode & {
    startIndex?: number
    endIndex?: number
  }
  if (typeof withRange.startIndex === 'number' && typeof withRange.endIndex === 'number') {
    return `${node.type}:${withRange.startIndex}:${withRange.endIndex}`
  }
  // Fallback: startPosition row/col (unique within a file).
  return `${node.type}:${node.startPosition.row}:${node.startPosition.column}`
}

function findAncestor(node: TreeSitterNode, type: string): TreeSitterNode | null {
  let current: TreeSitterNode | null = node
  while (current) {
    if (current.type === type) return current
    // web-tree-sitter exposes `parent` on nodes at runtime; TreeSitterNode
    // in manager.ts doesn't list it, so we duck-type here.
    const withParent = current as TreeSitterNode & { parent?: TreeSitterNode | null }
    current = withParent.parent ?? null
  }
  return null
}
