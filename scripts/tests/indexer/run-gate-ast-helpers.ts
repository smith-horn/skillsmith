/**
 * SMI-5879 (8.3.3.5): Shared source-scanning helpers for the run-gate census
 * and statement-order tests. Not a test file itself (no `*.test.ts` suffix),
 * mirroring the existing `parity-utils.ts` / `recheck.test-helpers.ts`
 * convention in this directory.
 *
 * These helpers deliberately work over raw source text and the TypeScript
 * compiler API's syntactic AST (no type-checker, no `Program`) rather than
 * importing the modules under test — the whole point of the census is to
 * catch a NEW file/shape that the test suite doesn't yet know to import.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'

/** Absolute path to `scripts/indexer/`, resolved relative to this file (cwd-independent). */
export const INDEXER_DIR = fileURLToPath(new URL('../../indexer', import.meta.url))

/** The guard literally used by every Shape-1 (guarded direct-entry) script. */
const DIRECT_ENTRY_GUARD_RE = /import\.meta\.url\s*===\s*`file:\/\/\$\{process\.argv\[1\]\}`/

/**
 * Recursively list every non-test `.ts` file under `scripts/indexer/`,
 * returning paths relative to `scripts/indexer/` (e.g. `run.ts`,
 * `_shared/supabase.ts`). Mirrors `getFilesRecursive` in
 * `scripts/audit-standards.mjs`.
 */
export function listIndexerSourceFiles(): string[] {
  const out: string[] = []

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) {
        walk(full)
      } else if (entry.endsWith('.ts') && !entry.includes('.test.')) {
        out.push(relative(INDEXER_DIR, full))
      }
    }
  }

  walk(INDEXER_DIR)
  return out.sort()
}

/** Read a `scripts/indexer/`-relative file's raw source text. */
export function readIndexerSource(relativePath: string): string {
  return readFileSync(join(INDEXER_DIR, relativePath), 'utf8')
}

/** Whether `source` contains the Shape-1 conditional-execution guard. */
export function hasDirectEntryGuard(source: string): boolean {
  return DIRECT_ENTRY_GUARD_RE.test(source)
}

/** Whether the file's first line is a shebang (`#!...`). */
export function hasShebang(source: string): boolean {
  return source.startsWith('#!')
}

/** Parse a `scripts/indexer/`-relative file into a syntactic (no type-checker) TS AST. */
export function parseIndexerSourceFile(relativePath: string): ts.SourceFile {
  const source = readIndexerSource(relativePath)
  return ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

/** The textual callee name of a call expression: `foo(` -> "foo"; `x.bar(` -> "bar". */
function calleeName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text
  return undefined
}

/**
 * Whether `sourceFile` has a top-level (module-scope) statement that invokes
 * an identifier named `name` as a function call — e.g. `main()` or
 * `main().catch(...)`. Only top-level statements are inspected (does not
 * descend into any function/arrow body), so a definition like
 * `const wrap = () => main()` correctly does NOT count: it never actually
 * calls `main` at module-evaluation time.
 */
export function hasTopLevelCallInvocation(sourceFile: ts.SourceFile, name: string): boolean {
  for (const stmt of sourceFile.statements) {
    if (!ts.isExpressionStatement(stmt)) continue
    if (expressionInvokes(stmt.expression, name)) return true
  }
  return false
}

/** Whether `expr` is (or chains from) a direct call to identifier `name`, e.g. `name()` or `name().catch(...)`. */
function expressionInvokes(expr: ts.Expression, name: string): boolean {
  if (!ts.isCallExpression(expr)) return false
  if (ts.isIdentifier(expr.expression) && expr.expression.text === name) return true
  // Chained call, e.g. `main().catch(...)` — expr.expression is `main().catch`.
  if (ts.isPropertyAccessExpression(expr.expression)) {
    return expressionInvokes(expr.expression.expression, name)
  }
  return false
}

/** Find a top-level `function <name>(...) {...}` (or `async function`) declaration. */
export function findTopLevelFunctionDeclaration(
  sourceFile: ts.SourceFile,
  name: string
): ts.FunctionDeclaration | undefined {
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) return stmt
  }
  return undefined
}

/**
 * First source position (`.pos`, a monotonic character offset — trivia-inclusive
 * but sufficient for before/after ordering) of a call expression anywhere inside
 * `root` whose callee name is `name` (matches both a bare identifier call like
 * `fetch(...)` and a property-access call like `db.rpc(...)` / `.insert(...)`).
 * Returns undefined when no such call exists within `root`.
 */
export function firstCallPosition(root: ts.Node, name: string): number | undefined {
  let found: number | undefined
  function visit(node: ts.Node): void {
    if (found !== undefined) return
    if (ts.isCallExpression(node) && calleeName(node.expression) === name) {
      found = node.pos
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return found
}

/** Top-level statement index of `func`'s body containing a call to `name` (or undefined). */
export function topLevelStatementIndexOfCall(
  func: ts.FunctionDeclaration,
  name: string
): number | undefined {
  if (!func.body) return undefined
  for (let i = 0; i < func.body.statements.length; i++) {
    const stmt = func.body.statements[i]
    let matches = false
    function visit(node: ts.Node): void {
      if (matches) return
      if (ts.isCallExpression(node) && calleeName(node.expression) === name) {
        matches = true
        return
      }
      ts.forEachChild(node, visit)
    }
    visit(stmt)
    if (matches) return i
  }
  return undefined
}

/** Whether an import declaration in `sourceFile` names `symbolName` from a module ending in `moduleSuffix`. */
export function importsNamedSymbolFrom(
  sourceFile: ts.SourceFile,
  moduleSuffix: string,
  symbolName: string
): boolean {
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue
    if (!stmt.moduleSpecifier.text.endsWith(moduleSuffix)) continue
    const clause = stmt.importClause
    if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue
    if (clause.namedBindings.elements.some((el) => el.name.text === symbolName)) return true
  }
  return false
}
