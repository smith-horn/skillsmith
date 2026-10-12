// SMI-6715 R2-8 (X7b): the static boundary that runC4Candidate's interposition
// depends on.
//
// runC4Candidate traces C4 by reassigning methods on the `node:fs` DEFAULT
// export object. That only sees calls that look a method up on that object at
// call time. These bypass it silently:
//   - a named or namespace import (`import { statSync } from 'node:fs'`,
//     `import * as fs from 'node:fs'`): bound to the ESM export, not the object;
//   - `node:fs/promises`, `require('fs')`, `createRequire`, a dynamic import,
//     `process.binding`: other module instances or no fs object at all;
//   - capturing a method or the object before the run (`const { statSync } =
//     fs`, `const s = fs.statSync`, `helper(fs)`, `fs[name]`).
// So the claim "every *Sync call C4 makes on the root, its subtree or the
// destination is traced" holds only while the code C4 runs obeys this boundary.
// This module checks it by parsing (acorn), never by regex, so comments and
// strings cannot hide or fake a violation.
//
// acorn is NOT a declared dependency. It is present only transitively (through
// @vercel/nft and the acorn-jsx / acorn-import-attributes plugins in the root
// lockfile). If a dependency bump drops it, this import throws and the boundary
// selftest fails loudly at load, never silently, so a vanished acorn cannot read
// as a clean boundary. Declare it before relying on this outside the spike.

import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'acorn'

const FS_SPEC = /^(node:)?fs$/
const FS_SUB = /^(node:)?fs\//
const SKIP_KEYS = new Set(['type', 'start', 'end', 'loc', 'range', 'raw'])

function children(node) {
  const out = []
  for (const k of Object.keys(node)) {
    if (SKIP_KEYS.has(k)) continue
    const v = node[k]
    if (Array.isArray(v)) {
      for (const c of v) if (c && typeof c.type === 'string') out.push([k, c])
    } else if (v && typeof v.type === 'string') out.push([k, v])
  }
  return out
}

/**
 * Checks one module's source. Returns the violations, the local names bound to
 * the fs default export, and the relative imports (for the transitive walk).
 */
export function checkFsBoundarySource(source) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
  const violations = []
  const fsLocals = new Set()
  const localImports = []
  const isFsSource = (s) => typeof s === 'string' && (FS_SPEC.test(s) || FS_SUB.test(s))

  // Pass 1: import and re-export declarations (top level only, by the grammar).
  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration') {
      const src = node.source.value
      if (FS_SUB.test(src)) violations.push(`fs subpath import '${src}'`)
      else if (FS_SPEC.test(src)) {
        const s = node.specifiers
        if (s.length !== 1 || s[0].type !== 'ImportDefaultSpecifier') {
          violations.push(`non-default import from '${src}'`)
        } else fsLocals.add(s[0].local.name)
      }
      if (src.startsWith('.')) localImports.push(src)
    } else if (
      (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') &&
      node.source &&
      isFsSource(node.source.value)
    ) {
      violations.push(`re-export from '${node.source.value}'`)
    }
  }

  // Pass 2: everything else.
  const visit = (node, parent, key) => {
    if (node.type === 'ImportDeclaration') return
    if (node.type === 'ImportExpression') {
      const s = node.source
      if (s.type !== 'Literal' || typeof s.value !== 'string') {
        violations.push('dynamic import with a non-literal specifier')
      } else if (isFsSource(s.value)) violations.push(`dynamic import of '${s.value}'`)
    }
    if (node.type === 'CallExpression') {
      const c = node.callee
      if (c.type === 'Identifier' && c.name === 'require') violations.push('require() call')
      const calleeName =
        c.type === 'Identifier'
          ? c.name
          : c.type === 'MemberExpression' && !c.computed
            ? c.property.name
            : null
      if (calleeName === 'createRequire') violations.push('createRequire() call')
      if (
        c.type === 'MemberExpression' &&
        c.object.type === 'Identifier' &&
        c.object.name === 'process' &&
        !c.computed &&
        (c.property.name === 'binding' || c.property.name === '_linkedBinding')
      ) {
        violations.push(`process.${c.property.name}() call`)
      }
    }
    if (
      node.type === 'MemberExpression' &&
      node.object.type === 'Identifier' &&
      fsLocals.has(node.object.name)
    ) {
      const isCallee = parent?.type === 'CallExpression' && key === 'callee'
      if (node.computed) violations.push(`computed member ${node.object.name}[...]`)
      else if (typeof fs[node.property.name] === 'function' && !isCallee) {
        violations.push(`${node.object.name}.${node.property.name} referenced without being called`)
      }
      // The object identifier is the sanctioned use; the property is a name, not a reference.
      return
    }
    if (node.type === 'Identifier' && fsLocals.has(node.name)) {
      const isPropertyName =
        (parent?.type === 'Property' && key === 'key' && !parent.computed && !parent.shorthand) ||
        (parent?.type === 'MemberExpression' && key === 'property' && !parent.computed)
      if (!isPropertyName) violations.push(`bare reference to the fs default '${node.name}'`)
      return
    }
    for (const [k, c] of children(node)) visit(c, node, k)
  }
  visit(ast, null, null)
  return { violations, fsLocals: [...fsLocals], localImports }
}

/**
 * Walks `entryFile` and every module it imports by a relative specifier,
 * transitively, and checks each. Returns the files checked (the denominator)
 * and every violation with its file.
 */
export function checkFsBoundary(entryFile) {
  const seen = new Map()
  const queue = [path.resolve(entryFile)]
  while (queue.length > 0) {
    const file = queue.shift()
    if (seen.has(file)) continue
    const r = checkFsBoundarySource(fs.readFileSync(file, 'utf8'))
    seen.set(file, r)
    for (const spec of r.localImports) queue.push(path.resolve(path.dirname(file), spec))
  }
  const files = [...seen.keys()]
  const violations = []
  for (const [file, r] of seen)
    for (const v of r.violations) violations.push({ file, violation: v })
  const fsLocalsByFile = Object.fromEntries([...seen].map(([f, r]) => [f, r.fsLocals]))
  return { files, violations, fsLocalsByFile }
}
