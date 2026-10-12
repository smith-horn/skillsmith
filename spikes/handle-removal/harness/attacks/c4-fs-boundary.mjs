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
//     fs`, `const s = fs.statSync`, `helper(fs)`, `fs[name]`);
//   - `fs.promises.*`: a separate API object the interposition never wraps;
//   - any non-*Sync member (fs.rm, fs.readFile, streams), never wrapped;
//   - the module loader (`node:module`, aliased createRequire) and
//     `process.getBuiltinModule`: fs without any fs import.
// The walk follows EVERY way a module pulls in another -- static import,
// `export ... from`, `export * from`, and a literal dynamic import -- and fails
// closed on anything it cannot read: a relative specifier that is not exactly a
// readable file (ESM adds no extension and resolves no directory index), a bare
// package or absolute specifier, or a non-literal dynamic import.
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
import { builtinModules } from 'node:module'
import { parse } from 'acorn'

const FS_SPEC = /^(node:)?fs$/
const FS_SUB = /^(node:)?fs\//
const BUILTINS = new Set(builtinModules)
const isRelative = (s) => s === '.' || s === '..' || s.startsWith('./') || s.startsWith('../')
const MODULE_SPEC = /^(node:)?module$/
/** Non-function members of the fs default that are plain data and safe to read. */
const FS_DATA_MEMBERS = new Set(['constants'])
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
  // Sol round 2: EVERY way this module pulls in another goes through here --
  // static import, `export ... from`, `export * from`, and a literal dynamic
  // import. A relative specifier is walked; a builtin is fine; anything else (a
  // package, an absolute path, a file: URL) is code this check cannot see, so it
  // fails closed rather than being skipped.
  const noteSpecifier = (src) => {
    // rt3 (a): the module loader hands out require(), and require('fs') is a
    // DIFFERENT path to fs that the interposition never sees. Matching the name
    // createRequire is not enough (it can be aliased or computed), so any import
    // of the module itself is a violation.
    if (MODULE_SPEC.test(src)) violations.push(`import of '${src}'`)
    if (isRelative(src)) localImports.push(src)
    else if (!src.startsWith('node:') && !BUILTINS.has(src)) {
      violations.push(`unchecked non-relative, non-builtin import '${src}'`)
    }
  }

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
      noteSpecifier(src)
    } else if (
      (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') &&
      node.source
    ) {
      if (isFsSource(node.source.value)) violations.push(`re-export from '${node.source.value}'`)
      else noteSpecifier(node.source.value)
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
      else noteSpecifier(s.value)
    }
    if (node.type === 'CallExpression') {
      const c = node.callee
      if (c.type === 'Identifier' && c.name === 'require') violations.push('require() call')
      // No separate createRequire-by-name rule: every way to obtain it (an
      // import of node:module, require, getBuiltinModule) is already a
      // violation on its own, so a name check was redundant and no mutation of
      // it could turn a test red.
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
      // G3-5b: fs.promises is a separate API object whose methods the
      // interposition never wraps, so ANY access to it is a bypass. (constants
      // is plain data and stays allowed.)
      else if (node.property.name === 'promises') {
        violations.push(`${node.object.name}.promises access`)
      } else if (FS_DATA_MEMBERS.has(node.property.name)) {
        // plain data, allowed
      } else if (
        !(node.property.name.endsWith('Sync') && typeof fs[node.property.name] === 'function')
      ) {
        // rt3 (c): async (fs.rm, fs.readFile), stream, callback and unknown
        // members are never wrapped, so they never appear in the trace.
        violations.push(`${node.object.name}.${node.property.name} is not a traced *Sync function`)
      } else if (!isCallee) {
        violations.push(`${node.object.name}.${node.property.name} referenced without being called`)
      }
      // The object identifier is the sanctioned use; the property is a name, not a reference.
      return
    }
    // rt3 (b): process.getBuiltinModule('node:fs') returns the fs module without
    // any import. Flag the name wherever it appears -- member, destructuring key
    // or computed string -- rather than one call shape.
    if (
      (node.type === 'Identifier' && node.name === 'getBuiltinModule') ||
      (node.type === 'Literal' && node.value === 'getBuiltinModule')
    ) {
      violations.push('getBuiltinModule reference')
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
  const unresolved = []
  // A relative specifier must name a readable regular file EXACTLY: ESM does not
  // add extensions or resolve a directory index, so anything else would fail to
  // load at runtime -- and a check that cannot read a module cannot vouch for it.
  // Either way it is a violation, never a silent skip.
  const readable = (abs) => {
    try {
      return fs.statSync(abs).isFile() ? fs.readFileSync(abs, 'utf8') : null
    } catch {
      return null
    }
  }
  const queue = [{ file: path.resolve(entryFile), from: null, spec: null }]
  while (queue.length > 0) {
    const { file, from, spec } = queue.shift()
    if (seen.has(file)) continue
    const src = from === null ? fs.readFileSync(file, 'utf8') : readable(file)
    if (src === null) {
      unresolved.push({ file: from, violation: `unresolvable relative import '${spec}'` })
      continue
    }
    const r = checkFsBoundarySource(src)
    seen.set(file, r)
    for (const s of r.localImports) {
      queue.push({ file: path.resolve(path.dirname(file), s), from: file, spec: s })
    }
  }
  const files = [...seen.keys()]
  const violations = [...unresolved]
  for (const [file, r] of seen)
    for (const v of r.violations) violations.push({ file, violation: v })
  const fsLocalsByFile = Object.fromEntries([...seen].map(([f, r]) => [f, r.fsLocals]))
  return { files, violations, fsLocalsByFile }
}
