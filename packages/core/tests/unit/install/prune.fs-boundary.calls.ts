/**
 * SMI-6531 (A1 step 6c-i, governance round m6): the argument shapes the prune
 * modules may pass to the fs calls that change the tree, checked on the
 * TypeScript AST of each module. The name-level boundary
 * (`park-tree.fs-boundary.ts`) allows `rmdirSync` and `writeFileSync`; these
 * rules pin how they are called:
 *  - `fs.rmdirSync(p)` and `fs.unlinkSync(p)`: exactly one argument, so never
 *    `{ recursive: true }`;
 *  - `fs.writeFileSync(p, data, { flag: 'wx', ... })`: exclusive, never over
 *    an existing file;
 *  - `fs.renameSync(from, to)`: only inside `renameNoReplace`, after its
 *    `fs.lstatSync(to)` check, so no rename replaces an entry.
 */
import ts from 'typescript'

/** Violations of the call-shape rules in one module's source. */
export function callShapeViolations(source: string): string[] {
  const sf = ts.createSourceFile('m.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out: string[] = []
  const enclosingFunction = (n: ts.Node): ts.FunctionDeclaration | null => {
    for (let p: ts.Node | undefined = n.parent; p !== undefined; p = p.parent) {
      if (ts.isFunctionDeclaration(p)) return p
    }
    return null
  }
  const fsCall = (n: ts.Node, name: string): n is ts.CallExpression =>
    ts.isCallExpression(n) &&
    ts.isPropertyAccessExpression(n.expression) &&
    ts.isIdentifier(n.expression.expression) &&
    n.expression.expression.text === 'fs' &&
    n.expression.name.text === name
  const visit = (n: ts.Node): void => {
    for (const one of ['rmdirSync', 'unlinkSync']) {
      if (fsCall(n, one) && n.arguments.length !== 1) {
        out.push(`fs.${one} with ${n.arguments.length} arguments (exactly one allowed)`)
      }
    }
    if (fsCall(n, 'writeFileSync')) {
      const opts = n.arguments[2]
      const wx =
        n.arguments.length === 3 &&
        opts !== undefined &&
        ts.isObjectLiteralExpression(opts) &&
        opts.properties.some(
          (p) =>
            ts.isPropertyAssignment(p) &&
            ts.isIdentifier(p.name) &&
            p.name.text === 'flag' &&
            ts.isStringLiteral(p.initializer) &&
            p.initializer.text === 'wx'
        )
      if (!wx) out.push("fs.writeFileSync without { flag: 'wx' }")
    }
    if (fsCall(n, 'renameSync')) {
      const fn = enclosingFunction(n)
      const name = fn?.name?.text ?? null
      if (name !== 'renameNoReplace') out.push('fs.renameSync outside renameNoReplace')
      else {
        let checked = false
        const find = (m: ts.Node): void => {
          if (fsCall(m, 'lstatSync') && m.getStart() < n.getStart()) checked = true
          ts.forEachChild(m, find)
        }
        if (fn !== null) find(fn)
        if (!checked) out.push('fs.renameSync in renameNoReplace without an earlier lstat')
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}
