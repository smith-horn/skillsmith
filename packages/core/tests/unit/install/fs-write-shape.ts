/**
 * SMI-6531 (A1 step 6c-ii-a, governance round 2 F7/F8): the ONE list of fs
 * members that can change the tree, and the AST predicates every read-only
 * invariant test shares (the install import graph, and the services and CLI
 * modules the `doctor backups` path reaches).
 *
 * A write is more than `fs.<member>Sync(...)`. It is any member in any form (sync,
 * callback, `fs.promises`), reached by a computed key, destructured out of `fs`
 * or `fs.promises`, carried off in an alias of `fs`, imported by name or as a
 * namespace from `node:fs` or `node:fs/promises`, or imported from another
 * module that does one of those, by name, as a namespace, or through a
 * re-export. Anything the predicates cannot prove read-only they call a write: a
 * test built on them fails closed.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const SYNC_WRITES = [
  'unlinkSync',
  'rmdirSync',
  'rmSync',
  'renameSync',
  'mkdirSync',
  'mkdtempSync',
  'writeFileSync',
  'appendFileSync',
  'openSync',
  'fsyncSync',
  'fdatasyncSync',
  'writeSync',
  'writevSync',
  'linkSync',
  'symlinkSync',
  'copyFileSync',
  'cpSync',
  'truncateSync',
  'ftruncateSync',
  'chmodSync',
  'fchmodSync',
  'lchmodSync',
  'chownSync',
  'fchownSync',
  'lchownSync',
  'utimesSync',
  'futimesSync',
  'lutimesSync',
]

/** fs members that change the tree or the descriptor table's contents: sync, callback and promise forms. */
export const WRITE_MEMBERS: ReadonlySet<string> = new Set([
  ...SYNC_WRITES,
  // `unlinkSync` -> `unlink`: the callback form and the `fs.promises` form share the name.
  ...SYNC_WRITES.map((n) => n.slice(0, -'Sync'.length)),
  'createWriteStream',
])

const FS_SPEC = /^(node:)?fs$/
const FS_PROMISES_SPEC = /^(node:)?fs\/promises$/
/** The members that read when opened read-only (`fs.openSync(p, 'r')`), and write otherwise. */
const OPENERS = new Set(['openSync', 'open'])

/** `fs.openSync(p, O_RDONLY | ...)` and `fs.openSync(p, 'r')` read; any other flag may write. */
function openReads(member: ts.PropertyAccessExpression): boolean {
  const call = member.parent
  if (!ts.isCallExpression(call) || call.expression !== member) return false
  const flags = call.arguments[1]?.getText() ?? ''
  return (
    /^(['"]r['"]|[\w.]*O_RDONLY\b[\w.| ]*)$/.test(flags) && !/O_(WRONLY|RDWR|CREAT)/.test(flags)
  )
}

/** What a module binds from `node:fs` and `node:fs/promises`. */
export interface FsBindings {
  /** Locals that ARE the fs object: a default or namespace import of `fs`. */
  fsObjects: Set<string>
  /** Locals that are the promises object: `fs/promises` (default or namespace), or `promises` from `fs`. */
  promiseObjects: Set<string>
  /** Named imports that are a write member: `local -> imported name`. */
  writeNamed: Map<string, string>
}

/** Reads the fs-related imports of `sf`. A module with no fs import has no bindings. */
export function fsBindingsOf(sf: ts.SourceFile): FsBindings {
  const b: FsBindings = { fsObjects: new Set(), promiseObjects: new Set(), writeNamed: new Map() }
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue
    const spec = st.moduleSpecifier.text
    const clause = st.importClause
    if (clause === undefined || clause.isTypeOnly) continue
    const isFs = FS_SPEC.test(spec)
    const isPromises = FS_PROMISES_SPEC.test(spec)
    if (!isFs && !isPromises) continue
    if (clause.name !== undefined) (isFs ? b.fsObjects : b.promiseObjects).add(clause.name.text)
    const nb = clause.namedBindings
    if (nb === undefined) continue
    if (ts.isNamespaceImport(nb)) (isFs ? b.fsObjects : b.promiseObjects).add(nb.name.text)
    else {
      for (const e of nb.elements) {
        if (e.isTypeOnly) continue
        const imported = (e.propertyName ?? e.name).text
        if (isFs && imported === 'promises') b.promiseObjects.add(e.name.text)
        else if (WRITE_MEMBERS.has(imported)) b.writeNamed.set(e.name.text, imported)
      }
    }
  }
  return b
}

/**
 * True when `n` (or a node under it) can write through `fs`: a write member in
 * any access form, a bare `fs` / `fs.promises` that escapes (alias, argument,
 * spread, rest), a destructuring that takes a write member (or everything), or
 * a mention of a write member imported by name.
 */
export function usesWrite(n: ts.Node, b: FsBindings): boolean {
  const isFs = (x: ts.Node): boolean => ts.isIdentifier(x) && b.fsObjects.has(x.text)
  const isPromisesId = (x: ts.Node): boolean => ts.isIdentifier(x) && b.promiseObjects.has(x.text)
  const isPromises = (x: ts.Node): boolean =>
    isPromisesId(x) ||
    (ts.isPropertyAccessExpression(x) && isFs(x.expression) && x.name.text === 'promises')
  const isObject = (x: ts.Node): boolean => isFs(x) || isPromises(x)
  const visit = (x: ts.Node): boolean => {
    // A type position (`fs.promises.FileHandle`) names the module, it does not call it.
    if (ts.isTypeNode(x)) return false
    if (ts.isPropertyAccessExpression(x) && isObject(x.expression)) {
      const name = x.name.text
      if (!WRITE_MEMBERS.has(name)) return false
      return OPENERS.has(name) ? !openReads(x) : true
    }
    if (ts.isElementAccessExpression(x) && isObject(x.expression)) {
      const key = x.argumentExpression
      return !ts.isStringLiteralLike(key) || WRITE_MEMBERS.has(key.text)
    }
    if (
      ts.isVariableDeclaration(x) &&
      ts.isObjectBindingPattern(x.name) &&
      x.initializer !== undefined &&
      isObject(x.initializer)
    ) {
      return x.name.elements.some(
        (e) =>
          e.dotDotDotToken !== undefined || WRITE_MEMBERS.has((e.propertyName ?? e.name).getText())
      )
    }
    if (ts.isIdentifier(x)) {
      if (b.writeNamed.has(x.text)) return true
      // Reached by descent, so it is not the object of a member access above: it escapes.
      if (isFs(x) || isPromisesId(x)) {
        const p = x.parent
        const isName =
          (ts.isPropertyAccessExpression(p) && p.name === x) ||
          (ts.isPropertyAssignment(p) && p.name === x) ||
          (ts.isBindingElement(p) && p.propertyName === x)
        return !isName
      }
      return false
    }
    if (isPromises(x)) return true
    return ts.forEachChild(x, visit) === true
  }
  return visit(n)
}

/** Every identifier mentioned under `n`. */
function mentions(n: ts.Node, out = new Set<string>()): Set<string> {
  if (ts.isIdentifier(n)) out.add(n.text)
  ts.forEachChild(n, (c) => void mentions(c, out))
  return out
}

/** A relative specifier's TypeScript file (`./x.js` names `./x.ts`), or null when it is not one that exists. */
export function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null
  const abs = path.resolve(path.dirname(fromFile), spec)
  const ts_ = abs.endsWith('.js') ? `${abs.slice(0, -3)}.ts` : abs
  return fs.existsSync(ts_) && fs.statSync(ts_).isFile() ? ts_ : null
}

/**
 * The top-level functions and arrow constants of `file` (an absolute path) that
 * can write: a body that `usesWrite`, OR mentions a writing name of the same
 * module, OR a named import that is itself writing in the module it comes from,
 * OR a namespace or default import of a module that writes anything. A re-export
 * of a writing name (or an export-star of a module that has any) makes the
 * re-exporting module write under that name. Followed to a fixpoint through any
 * depth of imports; a cycle adds nothing.
 */
export function writingNames(file: string, inProgress = new Set<string>()): Set<string> {
  if (inProgress.has(file)) return new Set()
  inProgress.add(file)
  const sf = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const bindings = fsBindingsOf(sf)
  const foreign = new Map<string, Set<string>>()
  const namesOf = (target: string): Set<string> => {
    if (!foreign.has(target)) foreign.set(target, writingNames(target, inProgress))
    return foreign.get(target) as Set<string>
  }
  const bodies = new Map<string, ts.Node>()
  const imported = new Map<string, { file: string; name: string }>()
  const wholeModule = new Map<string, string>()
  const out = new Set<string>()
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name !== undefined) bodies.set(st.name.text, st)
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer !== undefined) {
          bodies.set(d.name.text, d.initializer)
        }
      }
    }
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const target = resolveSpec(file, st.moduleSpecifier.text)
      const clause = st.importClause
      if (target === null || clause === undefined || clause.isTypeOnly) continue
      if (clause.name !== undefined) wholeModule.set(clause.name.text, target)
      const nb = clause.namedBindings
      if (nb !== undefined && ts.isNamespaceImport(nb)) wholeModule.set(nb.name.text, target)
      else if (nb !== undefined) {
        for (const e of nb.elements) {
          if (e.isTypeOnly) continue
          imported.set(e.name.text, { file: target, name: (e.propertyName ?? e.name).text })
        }
      }
    }
    if (ts.isExportDeclaration(st) && st.moduleSpecifier !== undefined && !st.isTypeOnly) {
      const target = ts.isStringLiteral(st.moduleSpecifier)
        ? resolveSpec(file, st.moduleSpecifier.text)
        : null
      if (target === null) continue
      const theirs = namesOf(target)
      const ec = st.exportClause
      if (ec === undefined) for (const n of theirs) out.add(n)
      else if (ts.isNamespaceExport(ec)) {
        if (theirs.size > 0) out.add(ec.name.text)
      } else {
        for (const e of ec.elements) {
          if (theirs.has((e.propertyName ?? e.name).text)) out.add(e.name.text)
        }
      }
    }
  }
  const importWrites = (local: string): boolean => {
    const i = imported.get(local)
    if (i !== undefined) return namesOf(i.file).has(i.name)
    const w = wholeModule.get(local)
    return w !== undefined && namesOf(w).size > 0
  }
  const refs = new Map([...bodies].map(([name, n]) => [name, mentions(n)] as const))
  for (const [name, n] of bodies) if (usesWrite(n, bindings)) out.add(name)
  for (let changed = true; changed; ) {
    changed = false
    for (const [name, m] of refs) {
      if (out.has(name)) continue
      if ([...m].some((x) => (x !== name && out.has(x)) || importWrites(x))) {
        out.add(name)
        changed = true
      }
    }
  }
  inProgress.delete(file)
  return out
}
