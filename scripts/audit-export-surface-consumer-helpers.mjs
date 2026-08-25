/**
 * SMI-6146: consumer-side import extractor + comparison/violation logic for
 * the export-surface coherence check (audit:standards Check 63).
 *
 * Parses a consumer package's `src/**\/*.ts` (non-test) source with
 * `ts.createSourceFile` — syntactic AST only, no `Program`, no
 * type-checker — matching the established repo idiom in
 * scripts/tests/indexer/run-gate-ast-helpers.ts. This is the one place in
 * the export-surface-coherence design that introduces AST-based parsing
 * rather than reusing audit-standards-helpers.mjs's regex-based
 * `parseTsExports` — deliberately, since the `import('pkg').Type` inline
 * type-query form (live today in
 * packages/mcp-server/src/tools/get-skill.ts:173,238) is exactly the
 * construct AST walking handles far more reliably than regex.
 *
 * Pure: takes already-read source text in, produces structured records
 * out. No fs I/O — mirrors the `srcByPath` convention used throughout
 * audit-standards-helpers.mjs (e.g. `findFunctionDefinitions`,
 * `findRelativeFunctionsV1Urls`).
 *
 * See docs/internal/implementation/smi-6146-export-surface-coherence-check.md
 * for the full design and the SMI-6143 incident this check exists to catch.
 */
import * as ts from 'typescript'

/**
 * Split a workspace-scoped module specifier into its package name and
 * export subpath, e.g.:
 *   '@skillsmith/core'            -> { packageName: '@skillsmith/core', subpath: '.' }
 *   '@skillsmith/core/telemetry'  -> { packageName: '@skillsmith/core', subpath: './telemetry' }
 *
 * Returns null for a specifier that doesn't start with any of
 * `scopePrefixes` (e.g. ['@skillsmith/', '@smith-horn/']).
 *
 * @param {string} specifier
 * @param {string[]} scopePrefixes
 * @returns {{ packageName: string, subpath: string } | null}
 */
export function splitWorkspaceSpecifier(specifier, scopePrefixes) {
  const scope = scopePrefixes.find((p) => specifier.startsWith(p))
  if (!scope) return null
  const rest = specifier.slice(scope.length) // e.g. 'core/telemetry' or 'core'
  const slashIdx = rest.indexOf('/')
  if (slashIdx === -1) {
    return { packageName: scope + rest, subpath: '.' }
  }
  const pkgSuffix = rest.slice(0, slashIdx)
  const subpathRest = rest.slice(slashIdx) // includes leading '/'
  return { packageName: scope + pkgSuffix, subpath: `.${subpathRest}` }
}

/**
 * For an `ImportTypeNode`'s `.qualifier` (an EntityName: Identifier or
 * QualifiedName, e.g. `TrustTier` or `Foo.Bar`), return the BASE name — the
 * symbol that must actually exist in the referenced module's export set.
 * For a nested access like `import('pkg').Foo.Bar`, that's `Foo` (`Bar` is
 * a member access on the already-resolved `Foo`, not itself an export of
 * `pkg`).
 */
function baseQualifierName(qualifier) {
  let q = qualifier
  while (q && ts.isQualifiedName(q)) q = q.left
  return q && ts.isIdentifier(q) ? q.text : undefined
}

/** True if `node` is a runtime dynamic `import(...)` call expression. */
function isDynamicImportCall(node) {
  return ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
}

/**
 * Walk UP through any wrapping ParenthesizedExpression / AsExpression /
 * NonNullExpression nodes around `node`, returning the outermost node
 * reachable that way. Used twice while classifying a dynamic import call:
 * once to see past `(import(...))`-style parens to find an enclosing
 * `await`, and once past `(await import(...)) as Foo`-style casts to find
 * what actually consumes the awaited value (a destructuring
 * VariableDeclaration, a PropertyAccessExpression, or neither).
 */
function skipOuterWrappers(node) {
  let n = node
  while (
    n.parent &&
    (ts.isParenthesizedExpression(n.parent) ||
      ts.isAsExpression(n.parent) ||
      ts.isNonNullExpression(n.parent))
  ) {
    n = n.parent
  }
  return n
}

/**
 * Parse one consumer TS file's source text and extract every workspace-
 * sibling symbol import — `ImportDeclaration` named imports (handling
 * `X as Y` aliasing, per-specifier `type X`, and clause-level
 * `import type`), `ImportTypeNode` inline type queries
 * (`import('@skillsmith/core').TrustTier`), AND runtime dynamic
 * `import('@skillsmith/*')`/`import('@smith-horn/*')` CALL expressions
 * (`const { X, Y: Z } = await import('@skillsmith/core')` or
 * `(await import('@skillsmith/core')).X` — live today in
 * packages/enterprise/src/audit/scheduled-scan.ts) — plus every
 * default/namespace import (static or dynamic) from a workspace-sibling
 * specifier that cannot be symbol-checked this way, reported separately
 * for the rollup tally rather than silently dropped. A dynamic import
 * whose namespace object is bound to a plain identifier and used
 * elsewhere (the scheduled-scan.ts shape: `const mod = await import(...);
 * ...; mod.runInventoryAudit`) is exactly this unresolvable case — this
 * function does not track identifier references across statements, so it
 * is counted into `unchecked` (kind `'dynamic-unresolved'`), not silently
 * skipped.
 *
 * @param {string} filePath - repo-relative path, used only for reporting.
 * @param {string} sourceText
 * @param {string[]} scopePrefixes - e.g. ['@skillsmith/', '@smith-horn/']
 * @returns {{
 *   named: Array<{ file: string, line: number, packageName: string, subpath: string, specifier: string, name: string, kind: 'named' | 'type-query' | 'dynamic-named' | 'dynamic-property-access' }>,
 *   unchecked: Array<{ file: string, line: number, packageName: string, subpath: string, specifier: string, kind: 'default' | 'namespace' | 'dynamic-unresolved' | 'dynamic-default' }>
 * }}
 */
export function extractWorkspaceImportsFromSource(filePath, sourceText, scopePrefixes) {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const named = []
  const unchecked = []

  const lineOf = (pos) => sourceFile.getLineAndCharacterOfPosition(pos).line + 1

  // ImportDeclarations are always top-level module statements — no need to
  // descend for these.
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue
    const specifier = stmt.moduleSpecifier.text
    const split = splitWorkspaceSpecifier(specifier, scopePrefixes)
    if (!split) continue
    const line = lineOf(stmt.getStart(sourceFile))
    const clause = stmt.importClause
    if (!clause) continue // side-effect-only import (`import '@skillsmith/x'`) — nothing to check

    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        // `X as Y` -> propertyName is the pre-`as` name ('X'); plain `X` (or
        // `type X`) -> propertyName is undefined, name.text is 'X' either way.
        const name = el.propertyName ? el.propertyName.text : el.name.text
        named.push({
          file: filePath,
          line,
          packageName: split.packageName,
          subpath: split.subpath,
          specifier,
          name,
          kind: 'named',
        })
      }
      // A combined `import Default, { Named } from 'pkg'` still carries a
      // default import alongside the named bindings handled above — without
      // this, `clause.name` here is silently dropped from both `named` and
      // `unchecked` (the standalone-default branch below requires
      // `!clause.namedBindings`, which is false in the combined case),
      // undercounting the informational unchecked-import tally.
      if (clause.name) {
        unchecked.push({
          file: filePath,
          line,
          packageName: split.packageName,
          subpath: split.subpath,
          specifier,
          kind: 'default',
        })
      }
    } else if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      unchecked.push({
        file: filePath,
        line,
        packageName: split.packageName,
        subpath: split.subpath,
        specifier,
        kind: 'namespace',
      })
    } else if (clause.name && !clause.namedBindings) {
      unchecked.push({
        file: filePath,
        line,
        packageName: split.packageName,
        subpath: split.subpath,
        specifier,
        kind: 'default',
      })
    }
  }

  // ImportTypeNode (`import('pkg').Foo`) and dynamic `import('pkg')` CALL
  // expressions can appear anywhere a type/expression is written, not just
  // at the top level — walk the whole tree.
  function visit(node) {
    if (ts.isImportTypeNode(node)) {
      const argument = node.argument
      const specifier =
        ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)
          ? argument.literal.text
          : undefined
      if (specifier) {
        const split = splitWorkspaceSpecifier(specifier, scopePrefixes)
        if (split) {
          const name = baseQualifierName(node.qualifier)
          // A qualifier-less `import('pkg')` type query (used as a whole
          // module-namespace type, e.g. `typeof import('pkg')`) names no
          // specific symbol — nothing to check, nothing to roll up either
          // (it isn't a default/namespace VALUE import).
          if (name) {
            named.push({
              file: filePath,
              line: lineOf(node.getStart(sourceFile)),
              packageName: split.packageName,
              subpath: split.subpath,
              specifier,
              name,
              kind: 'type-query',
            })
          }
        }
      }
    } else if (isDynamicImportCall(node)) {
      const [argNode] = node.arguments
      const specifier = argNode && ts.isStringLiteral(argNode) ? argNode.text : undefined
      const split = specifier ? splitWorkspaceSpecifier(specifier, scopePrefixes) : null
      if (split) {
        const line = lineOf(node.getStart(sourceFile))
        const pushNamed = (name, kind) =>
          named.push({
            file: filePath,
            line,
            packageName: split.packageName,
            subpath: split.subpath,
            specifier,
            name,
            kind,
          })
        const pushUnchecked = (kind) =>
          unchecked.push({
            file: filePath,
            line,
            packageName: split.packageName,
            subpath: split.subpath,
            specifier,
            kind,
          })

        // See past any `(import(...))`-style wrapping parens to find an
        // enclosing `await` — an un-awaited dynamic import (e.g.
        // `import('pkg').then(...)`, or the bare Promise passed around) has
        // no statically-resolvable destructuring/property-access shape.
        const afterCallWrappers = skipOuterWrappers(node)
        const awaitNode =
          afterCallWrappers.parent && ts.isAwaitExpression(afterCallWrappers.parent)
            ? afterCallWrappers.parent
            : null

        if (!awaitNode) {
          pushUnchecked('dynamic-unresolved')
        } else {
          // See past `(await import(...)) as Foo`-style casts to find what
          // actually consumes the awaited namespace object.
          const afterAwaitWrappers = skipOuterWrappers(awaitNode)
          const consumer = afterAwaitWrappers.parent

          if (
            consumer &&
            ts.isVariableDeclaration(consumer) &&
            consumer.initializer === afterAwaitWrappers
          ) {
            // `const { X, Y: Z } = await import('pkg')` (optionally cast) —
            // every destructured property is a statically-known name.
            // `const mod = await import('pkg')` (a plain identifier, not a
            // destructuring pattern) binds the WHOLE namespace object —
            // this function doesn't track identifier references across
            // later statements (the scheduled-scan.ts shape:
            // `mod.runInventoryAudit` used in a separate `return`), so
            // that shape is genuinely unresolvable here and must be
            // counted, not silently dropped.
            if (ts.isObjectBindingPattern(consumer.name)) {
              for (const el of consumer.name.elements) {
                if (el.dotDotDotToken) {
                  // `const { ...rest } = await import('pkg')` captures an
                  // unknown breadth of the namespace.
                  pushUnchecked('dynamic-unresolved')
                  continue
                }
                const exportedName = el.propertyName
                  ? ts.isIdentifier(el.propertyName)
                    ? el.propertyName.text
                    : undefined
                  : ts.isIdentifier(el.name)
                    ? el.name.text
                    : undefined
                if (!exportedName) {
                  pushUnchecked('dynamic-unresolved')
                } else if (exportedName === 'default') {
                  // The namespace object's `default` property is the
                  // module's default export, not a named export to look
                  // up — same reasoning as an unchecked default import.
                  pushUnchecked('dynamic-default')
                } else {
                  pushNamed(exportedName, 'dynamic-named')
                }
              }
            } else {
              pushUnchecked('dynamic-unresolved')
            }
          } else if (
            consumer &&
            ts.isPropertyAccessExpression(consumer) &&
            consumer.expression === afterAwaitWrappers
          ) {
            // `(await import('pkg')).X` (optionally cast) — direct
            // property access on the awaited namespace object. Only the
            // FIRST accessed property is the symbol that must exist in the
            // sibling's export set (mirrors ImportTypeNode's
            // baseQualifierName reasoning for a chained `.X.Y`).
            if (ts.isIdentifier(consumer.name)) {
              const exportedName = consumer.name.text
              if (exportedName === 'default') {
                pushUnchecked('dynamic-default')
              } else {
                pushNamed(exportedName, 'dynamic-property-access')
              }
            } else {
              pushUnchecked('dynamic-unresolved')
            }
          } else {
            // Awaited but consumed some other way not statically resolved
            // here (passed to a function, returned bare, spread, etc.).
            pushUnchecked('dynamic-unresolved')
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  return { named, unchecked }
}

/**
 * Run extractWorkspaceImportsFromSource across every file in `srcByPath`
 * (repo-relative path -> source text; caller is responsible for filtering
 * to non-test `.ts` files under a package's `src/**`) and group the named
 * results by (siblingPackageName, subpath) — the shape SMI-6146's design
 * calls for grouping into before comparison, while retaining
 * per-occurrence file/line for reporting.
 *
 * @param {Record<string, string>} srcByPath
 * @param {string[]} scopePrefixes
 * @returns {{
 *   groups: Map<string, { packageName: string, subpath: string, specifier: string, occurrences: Array<{ name: string, file: string, line: number, kind: string }> }>,
 *   unchecked: Array<{ file: string, line: number, packageName: string, subpath: string, specifier: string, kind: 'default' | 'namespace' }>
 * }}
 */
export function groupConsumerWorkspaceImports(srcByPath, scopePrefixes) {
  const groups = new Map()
  const unchecked = []
  for (const [file, text] of Object.entries(srcByPath)) {
    const { named, unchecked: fileUnchecked } = extractWorkspaceImportsFromSource(
      file,
      text,
      scopePrefixes
    )
    for (const rec of named) {
      const key = `${rec.packageName}::${rec.subpath}`
      if (!groups.has(key)) {
        groups.set(key, {
          packageName: rec.packageName,
          subpath: rec.subpath,
          specifier: rec.specifier,
          occurrences: [],
        })
      }
      groups.get(key).occurrences.push({
        name: rec.name,
        file: rec.file,
        line: rec.line,
        kind: rec.kind,
      })
    }
    unchecked.push(...fileUnchecked)
  }
  return { groups, unchecked }
}

/**
 * Compare grouped consumer imports against resolved export surfaces and
 * produce structured violations. `resolveExportSet(packageName, subpath)`
 * is expected to return the same result shape as
 * audit-export-surface-resolver-helpers.mjs's `resolveExportSetForSubpath`:
 * `{ status: 'ok', names: Set<string>, entrySourcePath: string }` |
 * `{ status: 'no-exports-surface' }` | `{ status: 'subpath-not-declared' }` |
 * `{ status: 'unmappable-dist-path', ... }`.
 *
 * @param {Map<string, { packageName: string, subpath: string, specifier: string, occurrences: Array<{ name: string, file: string, line: number, kind: string }> }>} groups
 * @param {(packageName: string, subpath: string) => object} resolveExportSet
 * @returns {{
 *   missingExportViolations: Array<{ file: string, line: number, name: string, packageName: string, subpath: string, specifier: string, exportCount: number, entrySourcePath: string }>,
 *   subpathViolations: Array<{ packageName: string, subpath: string, specifier: string, occurrences: Array<{ file: string, line: number, name: string }> }>,
 *   unresolvableSurfaceWarnings: Array<{ packageName: string, subpath: string, specifier: string, status: string, occurrences: Array<{ file: string, line: number, name: string }> }>,
 * }}
 */
export function evaluateExportSurfaceCoherence(groups, resolveExportSet) {
  const missingExportViolations = []
  const subpathViolations = []
  const unresolvableSurfaceWarnings = []

  for (const group of groups.values()) {
    const result = resolveExportSet(group.packageName, group.subpath)

    if (result.status === 'subpath-not-declared') {
      subpathViolations.push({
        packageName: group.packageName,
        subpath: group.subpath,
        specifier: group.specifier,
        occurrences: group.occurrences.map(({ file, line, name }) => ({ file, line, name })),
      })
      continue
    }

    if (result.status === 'no-exports-surface' || result.status === 'unmappable-dist-path') {
      unresolvableSurfaceWarnings.push({
        packageName: group.packageName,
        subpath: group.subpath,
        specifier: group.specifier,
        status: result.status,
        occurrences: group.occurrences.map(({ file, line, name }) => ({ file, line, name })),
      })
      continue
    }

    // status === 'ok'
    for (const occ of group.occurrences) {
      if (!result.names.has(occ.name)) {
        missingExportViolations.push({
          file: occ.file,
          line: occ.line,
          name: occ.name,
          packageName: group.packageName,
          subpath: group.subpath,
          specifier: group.specifier,
          exportCount: result.names.size,
          entrySourcePath: result.entrySourcePath,
        })
      }
    }
  }

  return { missingExportViolations, subpathViolations, unresolvableSurfaceWarnings }
}

/**
 * Pure decision logic for Check 63's shadow-burn-in + opt-out-marker gate,
 * extracted out of audit-standards.mjs's inline Check 63 driver block so
 * the gate/marker behavior is unit-testable without spawning the whole
 * audit-standards.mjs script. Matches the inline pattern already used by
 * Check 59/60 in audit-standards.mjs (`CHECK_N_SHADOW_END_DATE` /
 * `inShadow` / `shadowSuffix` / `skipAcknowledged`) — factored out here
 * specifically for Check 63's own driver rather than touching those
 * existing inline blocks.
 *
 * @param {object} params
 * @param {string} params.shadowEndDate - ISO date string, e.g. '2026-09-01'
 * @param {Date} params.now
 * @param {string} params.prBody
 * @param {string} params.skipMarker - e.g. '[skip-export-surface-check]'
 * @returns {{
 *   inShadow: boolean,
 *   report: 'warn' | 'fail',
 *   shadowSuffix: string,
 *   skipAcknowledged: boolean,
 * }}
 */
export function evaluateExportSurfaceShadowGate({ shadowEndDate, now, prBody, skipMarker }) {
  const inShadow = now < new Date(shadowEndDate)
  const shadowSuffix = inShadow ? ` [shadow mode through ${shadowEndDate} — advisory only]` : ''
  // Matches Check 60's precedent: the marker is only meaningful once the
  // gate can actually fail — during shadow mode every finding is already
  // warn-level regardless, so checking the marker then would add a
  // confusing "acknowledged" suffix implying something was blocked when
  // nothing was.
  const skipAcknowledged = !inShadow && (prBody || '').includes(skipMarker)
  return { inShadow, report: inShadow ? 'warn' : 'fail', shadowSuffix, skipAcknowledged }
}
