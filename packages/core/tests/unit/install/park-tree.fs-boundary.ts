/**
 * SMI-6531: the static fs boundary of the park modules (ADR-166 D-11
 * "Enforcement in tests"), ported from the SMI-6676 spike's
 * `harness/attacks/c4-fs-boundary.mjs` from acorn to the TypeScript parser.
 *
 * Interposition on the `node:fs` default export object sees only calls that
 * look a method up on that object at call time. Everything else bypasses it
 * silently: a named or namespace import, `node:fs/promises`, `require`,
 * `createRequire` or `node:module`, a dynamic import, `process.binding`,
 * `process.getBuiltinModule`, a captured method or object, `fs.promises`, and
 * any member that is not a `*Sync` function. The walk follows every way a
 * module pulls in another and fails closed on anything it cannot read.
 *
 * TypeScript additions: a type-only import or export is erased at compile time
 * and is allowed; a relative `./x.js` specifier names `./x.ts` (NodeNext).
 */
import fs from 'node:fs'
import path from 'node:path'
import { builtinModules } from 'node:module'
import ts from 'typescript'

const FS_SPEC = /^(node:)?fs$/
const FS_SUB = /^(node:)?fs\//
const MODULE_SPEC = /^(node:)?module$/
const BUILTINS = new Set(builtinModules)
const FS_DATA_MEMBERS = new Set(['constants'])
const fsTable = fs as unknown as Record<string, unknown>
const isRelative = (s: string) =>
  s === '.' || s === '..' || s.startsWith('./') || s.startsWith('../')

export interface BoundaryOptions {
  /** fs members forbidden outright in this graph (the park never deletes). */
  forbidMembers?: string[]
}

/** How a module pulls in one specifier: the value names it binds, or another form. */
export interface ImportForm {
  spec: string
  /** 'named' (value names only, type-only elements dropped), or the other forms. */
  form: 'named' | 'default' | 'namespace' | 'side-effect' | 're-export' | 'dynamic'
  names: string[]
}

export interface SourceCheck {
  violations: string[]
  fsLocals: string[]
  localImports: string[]
  externalImports: string[]
  importForms: ImportForm[]
}

/** Every named import element is `type`-only, so the whole import is erased. */
function allTypeOnly(clause: ts.ImportClause): boolean {
  if (clause.isTypeOnly) return true
  const nb = clause.namedBindings
  return (
    clause.name === undefined &&
    nb !== undefined &&
    ts.isNamedImports(nb) &&
    nb.elements.length > 0 &&
    nb.elements.every((e) => e.isTypeOnly)
  )
}

/** Checks one module's source. */
export function checkFsBoundarySource(
  source: string,
  { forbidMembers = [] }: BoundaryOptions = {}
): SourceCheck {
  const forbidden = new Set(forbidMembers)
  const sf = ts.createSourceFile('m.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const violations: string[] = []
  const fsLocals = new Set<string>()
  const localImports: string[] = []
  const externalImports: string[] = []
  const importForms: ImportForm[] = []
  const isFsSource = (s: string) => FS_SPEC.test(s) || FS_SUB.test(s)
  const noteSpecifier = (src: string) => {
    if (MODULE_SPEC.test(src)) violations.push(`import of '${src}'`)
    if (isRelative(src)) localImports.push(src)
    else if (!src.startsWith('node:') && !BUILTINS.has(src)) externalImports.push(src)
  }

  // Pass 1: import and re-export declarations.
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const src = st.moduleSpecifier.text
      const clause = st.importClause
      if (clause !== undefined && allTypeOnly(clause)) continue
      if (clause === undefined) importForms.push({ spec: src, form: 'side-effect', names: [] })
      else {
        if (clause.name !== undefined) {
          importForms.push({ spec: src, form: 'default', names: [clause.name.text] })
        }
        const nb = clause.namedBindings
        if (nb !== undefined && ts.isNamespaceImport(nb)) {
          importForms.push({ spec: src, form: 'namespace', names: [nb.name.text] })
        } else if (nb !== undefined) {
          const names = nb.elements
            .filter((e) => !e.isTypeOnly)
            .map((e) => (e.propertyName ?? e.name).text)
          importForms.push({ spec: src, form: 'named', names })
        }
      }
      if (FS_SUB.test(src)) violations.push(`fs subpath import '${src}'`)
      else if (FS_SPEC.test(src)) {
        if (
          clause === undefined ||
          clause.name === undefined ||
          clause.namedBindings !== undefined
        ) {
          violations.push(`non-default import from '${src}'`)
        } else fsLocals.add(clause.name.text)
      }
      noteSpecifier(src)
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier !== undefined) {
      if (st.isTypeOnly || !ts.isStringLiteral(st.moduleSpecifier)) continue
      const src = st.moduleSpecifier.text
      importForms.push({ spec: src, form: 're-export', names: [] })
      if (isFsSource(src)) violations.push(`re-export from '${src}'`)
      else noteSpecifier(src)
    } else if (ts.isImportEqualsDeclaration(st)) {
      violations.push('import = require(...) declaration')
    }
  }

  // Pass 2: everything else.
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return
    if (ts.isCallExpression(node)) {
      const c = node.expression
      if (c.kind === ts.SyntaxKind.ImportKeyword) {
        const a = node.arguments[0]
        if (a === undefined || !ts.isStringLiteral(a)) {
          violations.push('dynamic import with a non-literal specifier')
        } else {
          importForms.push({ spec: a.text, form: 'dynamic', names: [] })
          if (isFsSource(a.text)) violations.push(`dynamic import of '${a.text}'`)
          else noteSpecifier(a.text)
        }
      }
      if (ts.isIdentifier(c) && c.text === 'require') violations.push('require() call')
      if (
        ts.isPropertyAccessExpression(c) &&
        ts.isIdentifier(c.expression) &&
        c.expression.text === 'process' &&
        (c.name.text === 'binding' || c.name.text === '_linkedBinding')
      ) {
        violations.push(`process.${c.name.text}() call`)
      }
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      fsLocals.has(node.expression.text)
    ) {
      violations.push(`computed member ${node.expression.text}[...]`)
      visit(node.argumentExpression)
      return
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      fsLocals.has(node.expression.text)
    ) {
      const obj = node.expression.text
      const name = node.name.text
      const isCallee = ts.isCallExpression(node.parent) && node.parent.expression === node
      if (name === 'promises') violations.push(`${obj}.promises access`)
      else if (forbidden.has(name)) violations.push(`${obj}.${name} is forbidden here`)
      else if (FS_DATA_MEMBERS.has(name)) {
        // plain data, allowed
      } else if (!(name.endsWith('Sync') && typeof fsTable[name] === 'function')) {
        violations.push(`${obj}.${name} is not a traced *Sync function`)
      } else if (!isCallee) violations.push(`${obj}.${name} referenced without being called`)
      return
    }
    if (
      (ts.isIdentifier(node) && node.text === 'getBuiltinModule') ||
      (ts.isStringLiteral(node) && node.text === 'getBuiltinModule')
    ) {
      violations.push('getBuiltinModule reference')
    }
    if (ts.isIdentifier(node) && fsLocals.has(node.text)) {
      const p = node.parent
      const isPropertyName =
        (ts.isPropertyAssignment(p) && p.name === node) ||
        (ts.isPropertyAccessExpression(p) && p.name === node) ||
        (ts.isMethodDeclaration(p) && p.name === node) ||
        (ts.isPropertySignature(p) && p.name === node)
      if (!isPropertyName) violations.push(`bare reference to the fs default '${node.text}'`)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { violations, fsLocals: [...fsLocals], localImports, externalImports, importForms }
}

/** A relative TS specifier's file: `./x.js` names `./x.ts`; nothing else is guessed. */
function resolveRelative(fromFile: string, spec: string): string {
  const abs = path.resolve(path.dirname(fromFile), spec)
  return abs.endsWith('.js') ? `${abs.slice(0, -3)}.ts` : abs
}

/**
 * A declared exemption: `file` may import exactly `names`, as plain named
 * imports and in no other form, from `spec`. The target is not walked.
 */
export interface ExemptEdge {
  file: string
  spec: string
  names: string[]
}

export interface GraphCheck {
  files: string[]
  violations: { file: string; violation: string }[]
  fsLocalsByFile: Record<string, string[]>
  /** Exempt edges actually used, so a test can pin that each is still needed. */
  exemptUsed: { file: string; spec: string }[]
}

/**
 * Walks `entryFile` and every module it imports by a relative specifier,
 * transitively. A bare or absolute specifier, a relative one that is not
 * exactly a readable file, and, with `confineTo`, a relative one resolving
 * outside that directory are violations and are not walked. The only way past
 * `confineTo` is an `exempt` edge, matched on the importing file and the
 * specifier, whose import forms must be exactly one named import of `names`.
 */
export function checkFsBoundary(
  entryFile: string,
  options: BoundaryOptions & { confineTo?: string; exempt?: ExemptEdge[] } = {}
): GraphCheck {
  const confine = options.confineTo === undefined ? null : path.resolve(options.confineTo)
  const exempt = options.exempt ?? []
  const seen = new Map<string, SourceCheck>()
  const violations: { file: string; violation: string }[] = []
  const exemptUsed: { file: string; spec: string }[] = []
  const readable = (abs: string): string | null => {
    try {
      return fs.statSync(abs).isFile() ? fs.readFileSync(abs, 'utf8') : null
    } catch {
      return null
    }
  }
  const exemptFor = (file: string, spec: string): ExemptEdge | undefined =>
    exempt.find((e) => path.resolve(e.file) === file && e.spec === spec)
  const queue: { file: string; from: string | null; spec: string | null }[] = [
    { file: path.resolve(entryFile), from: null, spec: null },
  ]
  while (queue.length > 0) {
    const { file, from, spec } = queue.shift() as (typeof queue)[number]
    if (seen.has(file)) continue
    const src = readable(file)
    if (src === null) {
      violations.push({
        file: from ?? file,
        violation: `unresolvable ${from === null ? 'entry' : 'relative import'} '${spec ?? file}'`,
      })
      continue
    }
    const r = checkFsBoundarySource(src, options)
    seen.set(file, r)
    for (const v of r.violations) violations.push({ file, violation: v })
    for (const s of new Set([...r.localImports, ...r.externalImports])) {
      const e = exemptFor(file, s)
      if (e !== undefined) {
        const forms = r.importForms.filter((f) => f.spec === s)
        const exact =
          forms.length === 1 &&
          forms[0]?.form === 'named' &&
          [...forms[0].names].sort().join(',') === [...e.names].sort().join(',')
        if (exact) exemptUsed.push({ file, spec: s })
        else {
          violations.push({
            file,
            violation: `exempt import '${s}' must be exactly { ${e.names.join(', ')} }, got ${JSON.stringify(forms)}`,
          })
        }
        continue
      }
      if (!isRelative(s)) {
        violations.push({ file, violation: `unchecked non-relative, non-builtin import '${s}'` })
        continue
      }
      const target = resolveRelative(file, s)
      if (confine !== null && path.dirname(target) !== confine) {
        violations.push({ file, violation: `import '${s}' leaves the confined directory` })
        continue
      }
      queue.push({ file: target, from: file, spec: s })
    }
  }
  return {
    files: [...seen.keys()],
    violations,
    fsLocalsByFile: Object.fromEntries([...seen].map(([f, r]) => [f, r.fsLocals])),
    exemptUsed,
  }
}
