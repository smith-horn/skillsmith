/**
 * TypeScript-compiler-API local-import-graph tracer, for the G-5
 * fixture-corpus corroboration watch-list-closure assertion (SMI-5879 Wave 1).
 * @module scripts/tests/indexer/smi5879-corroboration.import-graph
 *
 * Split out of `smi5879-corroboration.edge.test.ts` to keep that file under
 * CLAUDE.md's 500-line convention. `typescript` is already a dependency of
 * `security-scanner-edge.multiline-category-closure.fixtures.ts` (spec doc
 * §5's assertion 5), which uses the same compiler API for a different
 * purpose (call-site AST matching, not import resolution).
 *
 * Deliberately narrow: only RELATIVE (`.`-prefixed) `import`/`export ... from`
 * specifiers are followed — bare specifiers (npm packages, `node:*` builtins)
 * are skipped, since they are not part of "this repo's own source" and are
 * covered by `package-lock.json`/CI's own dependency-audit surface instead.
 * An unresolvable relative specifier is a hard failure (never silently
 * skipped) — the whole point of this tracer is to make "what does this test
 * actually execute" a computed fact, not a hand-maintained guess.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as ts from 'typescript'

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile()
}

/** Every relative `import`/`export ... from '...'` specifier in `filePath`, including type-only ones. */
function collectRelativeImportSpecifiers(filePath: string): string[] {
  const text = readFileSync(filePath, 'utf8')
  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const specifiers: string[] = []

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text)
    }
    // dynamic import('./foo.ts')
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return specifiers.filter((s) => s.startsWith('.'))
}

/**
 * Resolves a relative specifier to an on-disk `.ts` file, handling both
 * conventions this repo uses: `NodeNext`-style `.js`-suffixed specifiers that
 * resolve to a co-located `.ts` source file (`packages/core/src`,
 * `scripts/indexer/_shared`), and this task's own literal `.ts`-suffixed
 * specifiers.
 */
function resolveRelativeSpecifier(fromFile: string, specifier: string): string {
  const base = join(dirname(fromFile), specifier)
  const candidates = base.endsWith('.js')
    ? [`${base.slice(0, -3)}.ts`, base]
    : base.endsWith('.ts') || base.endsWith('.tsx')
      ? [base]
      : [`${base}.ts`, `${base}/index.ts`, base]

  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate
  }
  throw new Error(
    `smi5879-corroboration.import-graph: unresolvable relative specifier "${specifier}" from ` +
      `"${fromFile}" (tried: ${candidates.join(', ')})`
  )
}

/**
 * Breadth-first traversal of every file reachable from `entryFiles` via
 * relative imports/exports (including type-only and dynamic). Returns
 * absolute paths, entry files included.
 */
export function traceLocalImportGraph(entryFiles: readonly string[]): Set<string> {
  const visited = new Set<string>()
  const queue = [...entryFiles]
  while (queue.length > 0) {
    const current = queue.pop()
    if (current === undefined || visited.has(current)) continue
    visited.add(current)
    for (const specifier of collectRelativeImportSpecifiers(current)) {
      const resolved = resolveRelativeSpecifier(current, specifier)
      if (!visited.has(resolved)) queue.push(resolved)
    }
  }
  return visited
}
