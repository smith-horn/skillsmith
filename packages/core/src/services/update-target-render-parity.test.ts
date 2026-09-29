/**
 * @fileoverview Reason/result TABLE parity test for SMI-6532 step 6 (preparatory),
 *   §4.4
 *   of docs/internal/implementation/update-safety-and-source-resolution.md:
 *   "A parity test checks that, for every member, all three renderers
 *   return non-empty text and the same remediation kind."
 *
 *   Lives in `packages/core` — a revision of the original decision to place
 *   it in `packages/mcp-server`. That placement was reasoned from the true
 *   premise "core cannot import mcp-server" to the false conclusion "so the
 *   test must live wherever it CAN import the MCP renderer" — but the test
 *   doesn't need to import the MCP renderer any more than it needs to
 *   import the VS Code mirror (core doesn't depend on VS Code either, and
 *   the sibling `update-target-reason.test.ts` already reads that file via
 *   the TypeScript AST, not an import). AST-reading both external files
 *   symmetrically, from core, means: core already has `typescript` as a
 *   dependency (`package.json`) and `update-target-reason.test.ts` already
 *   imports it, so no new devDependency is needed anywhere; and core's own
 *   `UPDATE_TARGET_REASONS`/`UPDATE_RESULT_CODES`/`remediationFor` are
 *   reached by the plain relative import `./update-target-reason.js` this
 *   file already uses for its sibling tests — no public export of those
 *   values was needed at all. The original mcp-server placement had
 *   required both: a `typescript` devDependency for mcp-server (a lockfile
 *   hazard — `npm ci` can fail with `Missing: typescript@X from lock file`
 *   for a package.json dependency the lockfile doesn't yet know about,
 *   the same shape as the SMI-5272 `jose` anchor) and a public core export
 *   of values that exist solely to serve this test (the exact
 *   wrong-direction widening SMI-6841 finding 5 flagged for
 *   `hasGitAncestorBetween` in this same issue family).
 *
 *   `packages/mcp-server/src/tools/update-target-render.ts`'s
 *   `UPDATE_TARGET_TEXT` and `packages/vscode-extension/src/services/manifestReader.ts`'s
 *   `UPDATE_TARGET_TEXT`/`UPDATE_REMEDIATION_KIND` are read via the AST —
 *   the same `extractObjectLiteral` technique as this file's sibling
 *   `extractArrayLiteral` (see that function's doc comment in
 *   `update-target-reason.test.ts` for the "confidently wrong is worse than
 *   a loud refusal" rationale this one shares), generalised from an array
 *   literal to an object literal since these two mirrors are `Record`s, not
 *   arrays. A regex over quoted strings would read a commented-out entry as
 *   live (measured against that exact failure mode in SMI-6841) —
 *   `ts.createSourceFile` tokenizes comments as trivia, so an
 *   `ObjectLiteralExpression`'s `.properties` can only ever contain nodes
 *   that are actually live code.
 *
 *   CLI's `manage.update.render.ts` is step 5's output (blocked on
 *   SMI-6531, not yet built) — so this is a two-surface parity test (MCP,
 *   VS Code) against core's own ground truth, not the three-surface test
 *   §4.4 ultimately wants. When step 5 lands, extend this file rather than
 *   re-deriving the AST-read approach.
 *
 * @module @skillsmith/core/services/update-target-render-parity.test
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import * as ts from 'typescript'

import {
  UPDATE_TARGET_REASONS,
  UPDATE_RESULT_CODES,
  remediationFor,
  type UpdateTargetReason,
  type UpdateResultCode,
} from './update-target-reason.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ─────────────────────────────────────────────────────────────────────────────
// AST extraction — `export const <name> = { 'key': 'value', ... } as const`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Throws if `sourceFile` failed to parse cleanly, or if TypeScript's internal
 * `parseDiagnostics` field is no longer readable at all. Split out from
 * `extractObjectLiteral` so the missing-field branch can be exercised directly, by
 * passing a fabricated `SourceFile`, rather than only by way of TypeScript itself no
 * longer setting the field — which nothing in this test suite can arrange.
 */
function assertParsesCleanly(
  sourceFile: ts.SourceFile,
  fileName: string,
  exportName: string
): void {
  // PARSE ERRORS ARE FATAL HERE. `createSourceFile` RECOVERS an AST from malformed
  // syntax rather than throwing, so without this check a syntactically broken mirror
  // still yields a plausible-looking table. A mirror that does not parse cleanly is
  // not one this test can speak about.
  // `parseDiagnostics` is INTERNAL to TypeScript, so reaching it needs a cast — and a
  // cast means a rename upstream would read `undefined` and turn this guard off
  // silently, leaving the exact hole it exists to close. So its ABSENCE is fatal too:
  // if TypeScript stops setting it, this throws and someone has to look, rather than
  // the check quietly becoming a no-op.
  const parseErrors = (sourceFile as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] })
    .parseDiagnostics
  if (parseErrors === undefined) {
    throw new Error(
      `Cannot read parseDiagnostics from a TypeScript SourceFile (ts ${ts.version}). ` +
        `That field is internal; if it has been renamed or removed, this guard is off ` +
        `and a malformed mirror would extract as if it were valid. Find the new way to ` +
        `detect parse errors before re-enabling extraction.`
    )
  }
  if (parseErrors.length > 0) {
    const first = ts.flattenDiagnosticMessageText(parseErrors[0]?.messageText ?? '', ' ')
    throw new Error(
      `${fileName} does not parse cleanly (${parseErrors.length} diagnostic(s)); ` +
        `first: ${first}. Refusing to extract "${exportName}" from a file the parser ` +
        `had to recover.`
    )
  }
}

/**
 * Extract `export const <exportName> = { ... }`'s string-keyed,
 * string-valued properties via the TypeScript AST. Refuses (throws) rather
 * than guessing on anything that isn't a plain top-level `const` object
 * literal of string-to-string properties: a non-`const` binding's
 * initializer is not necessarily its current value, a nested declaration
 * (e.g. inside a namespace) is not reachable the way a flat top-level export
 * is, and a non-string-literal property value (spread, computed key,
 * shorthand, method, getter/setter) has no single static string this parser
 * can extract without guessing. Sibling of `extractArrayLiteral` in
 * `update-target-reason.test.ts` — same principle, generalised from array
 * elements to object properties.
 */
function extractObjectLiteral(
  source: string,
  exportName: string,
  fileName: string
): Record<string, string> {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS
  )

  assertParsesCleanly(sourceFile, fileName, exportName)

  // Top-level statements only — a `const` nested inside a namespace or
  // function is not what a flat mirror file is supposed to export.
  let found: Record<string, string> | undefined
  for (const node of sourceFile.statements) {
    if (found !== undefined) break
    if (
      !ts.isVariableStatement(node) ||
      !node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ||
      (node.declarationList.flags & ts.NodeFlags.Const) === 0
    ) {
      continue
    }
    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== exportName || !decl.initializer) {
        continue
      }
      const init = ts.isAsExpression(decl.initializer)
        ? decl.initializer.expression
        : decl.initializer
      if (!ts.isObjectLiteralExpression(init)) continue

      const entries: Record<string, string> = {}
      for (const prop of init.properties) {
        if (!ts.isPropertyAssignment(prop)) {
          throw new Error(
            `${fileName} "${exportName}" has a non-plain-assignment member (spread, shorthand, ` +
              'method, or accessor) -- mirror parser only understands plain key: "value" entries'
          )
        }
        const keyNode = prop.name
        const key = ts.isIdentifier(keyNode)
          ? keyNode.text
          : ts.isStringLiteral(keyNode)
            ? keyNode.text
            : undefined
        if (key === undefined) {
          throw new Error(
            `${fileName} "${exportName}" has a computed or non-string property key -- ` +
              'mirror parser only understands identifier or plain string keys'
          )
        }
        if (!ts.isStringLiteral(prop.initializer)) {
          throw new Error(
            `${fileName} "${exportName}" property "${key}" is not a plain string literal -- ` +
              'mirror parser only understands string values'
          )
        }
        entries[key] = prop.initializer.text
      }
      found = entries
    }
  }

  if (found === undefined) {
    throw new Error(
      `${fileName} has no "export const ${exportName} = {...}" object -- mirror missing or renamed`
    )
  }

  // Same "the binding may be mutated after declaration" concern as
  // `extractArrayLiteral`: refuse any in-file reference to the exported name
  // beyond its own declaration, since a static read of the initializer is
  // not a read of the live value if something downstream mutates it.
  const offending: string[] = []
  const scanReferences = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === exportName) {
      const parent = node.parent as ts.Node | undefined
      const isOwnDeclarationName =
        parent !== undefined && ts.isVariableDeclaration(parent) && parent.name === node
      const isTypePosition = parent !== undefined && ts.isTypeQueryNode(parent)
      if (!isOwnDeclarationName && !isTypePosition) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
        offending.push(`line ${line}`)
      }
    }
    ts.forEachChild(node, scanReferences)
  }
  scanReferences(sourceFile)
  if (offending.length > 0) {
    throw new Error(
      `${fileName} references "${exportName}" outside its declaration (${offending.join(', ')}) -- ` +
        'the initializer may not be the exported value, so this parity check refuses to guess'
    )
  }

  return found
}

function readMirroredObject(relPath: string, exportName: string): Record<string, string> {
  const filePath = path.join(__dirname, relPath)
  const source = readFileSync(filePath, 'utf-8')
  return extractObjectLiteral(source, exportName, filePath)
}

const MCP_RENDERER_PATH = '../../../mcp-server/src/tools/update-target-render.ts'
const VSCODE_MANIFEST_READER_PATH = '../../../vscode-extension/src/services/manifestReader.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Every member, tagged as a reason or a result (§4.4's `UpdateCode`)
// ─────────────────────────────────────────────────────────────────────────────

type TaggedMember =
  | { readonly kind: 'reason'; readonly value: UpdateTargetReason }
  | { readonly kind: 'result'; readonly value: UpdateResultCode }

const ALL_MEMBERS: TaggedMember[] = [
  ...UPDATE_TARGET_REASONS.map((value): TaggedMember => ({ kind: 'reason', value })),
  ...UPDATE_RESULT_CODES.map((value): TaggedMember => ({ kind: 'result', value })),
]

// SCOPE. This compares TABLES, not rendering.
//
// Established:
//   1. 23 reasons + 15 results = 38 tagged members, asserted directly, so a change
//      to either closed set fails before any table is read.
//   2. Each table covers those sets with non-empty text — per table, independently.
//   3. The VS Code remediation-kind table agrees with core, member by member.
//
// Not established:
//   - That MCP text and VS Code text say the same thing. They need not: §4.4 has each
//     surface write its own wording, so identical text is not a property worth pinning.
//   - That anything renders. §4.4's "Every renderer is a `Record<…>`" constrains a
//     renderer's representation; it does not make an unconsumed Record a renderer.
//     Neither table has a consumer yet, so no arm can fail because a surface rendered
//     the wrong thing at runtime. Step 6 is PREPARATORY on that account; completion
//     is wiring these tables into surface output, which needs step 5's call sites.
//
// An arm fails when a table omits a member, leaves one blank, or disagrees with core
// on a remediation kind. Extraction failures — a file that does not parse, a missing
// or non-object export, a value reference where a literal belongs — throw instead,
// which is a precondition rather than a parity result.
//
// SMI-6532 and PR #2952 hold the review history that produced these boundaries. It is
// deliberately not repeated here: four consecutive rounds found a defect in this note
// while it recounted the previous round, which is the pattern `pr-reviewer` names.
describe('SMI-6532 step 6: reason/result TABLE parity (MCP + VS Code)', () => {
  // THE EXTRACTOR'S OWN REFUSALS, tested rather than hand-checked once. The parse
  // guard's two branches — a missing `parseDiagnostics` field, and parse errors
  // present — are each pinned by a direct test below; a third test pins the separate
  // absent-export refusal, and the canary between them confirms today's real
  // `SourceFile` still exposes the field, as an array, without itself testing either
  // guard branch.
  describe('extractObjectLiteral refusals', () => {
    it('throws on a source file the parser had to recover, naming the diagnostic', () => {
      expect(() => extractObjectLiteral('export const ((( T = { a: 1 }', 'T', 'broken.ts')).toThrow(
        /does not parse cleanly/
      )
    })

    it('throws when parseDiagnostics is missing from the SourceFile entirely', () => {
      // Nothing can make TypeScript itself stop setting this internal field, so the
      // branch is exercised directly instead: a bare object cast to `ts.SourceFile`
      // has no `parseDiagnostics` at all, the same shape the guard would see if
      // TypeScript ever renamed or removed the field.
      const fieldless = {} as unknown as ts.SourceFile
      expect(() => assertParsesCleanly(fieldless, 'fieldless.ts', 'T')).toThrow(
        /Cannot read parseDiagnostics/
      )
    })

    it('reads parseDiagnostics off a real SourceFile — the field the guard depends on', () => {
      // If TypeScript ever stops setting this internal field, the mirrored reads
      // further down (`readMirroredObject` calls, outside any `it()`) run in the
      // `describe` body, so vitest executes them at COLLECTION time: they would throw
      // first and abort the whole file, and no `it()` here — canary included — would
      // run (measured: `Tests  no tests`). This assertion is a separate, more explicit
      // signal for whoever reads the wreckage: it also verifies the field is still an
      // array, which `assertParsesCleanly` itself does not check (it only rejects
      // `undefined`), so a future non-array replacement would pass the guard silently
      // and only this assertion would catch it.
      const probe = ts.createSourceFile('probe.ts', 'export const T = {}', ts.ScriptTarget.Latest)
      const diagnostics = (probe as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] })
        .parseDiagnostics
      expect(diagnostics, `ts ${ts.version} no longer exposes parseDiagnostics`).toBeDefined()
      expect(Array.isArray(diagnostics)).toBe(true)
    })

    it('throws when the named export is absent rather than returning an empty table', () => {
      expect(() => extractObjectLiteral('export const OTHER = { a: 1 }', 'T', 'absent.ts')).toThrow(
        /has no "export const T = \{\.\.\.\}"/
      )
    })
  })

  it('sanity: 23 reasons + 15 results = 38 tagged members', () => {
    expect(UPDATE_TARGET_REASONS.length).toBe(23)
    expect(UPDATE_RESULT_CODES.length).toBe(15)
    expect(ALL_MEMBERS.length).toBe(38)
  })

  const mcpText = readMirroredObject(MCP_RENDERER_PATH, 'UPDATE_TARGET_TEXT')
  const vsCodeText = readMirroredObject(VSCODE_MANIFEST_READER_PATH, 'UPDATE_TARGET_TEXT')
  const vsCodeKind = readMirroredObject(VSCODE_MANIFEST_READER_PATH, 'UPDATE_REMEDIATION_KIND')

  it.each(ALL_MEMBERS)('$kind "$value": the MCP table carries non-empty text', ({ value }) => {
    expect(mcpText[value], `MCP has no text for "${value}"`).toBeTruthy()
    expect(mcpText[value]?.length, `MCP text for "${value}" is empty`).toBeGreaterThan(0)
  })

  it.each(ALL_MEMBERS)('$kind "$value": the VS Code table carries non-empty text', ({ value }) => {
    expect(vsCodeText[value], `VS Code has no text for "${value}"`).toBeTruthy()
    expect(vsCodeText[value]?.length, `VS Code text for "${value}" is empty`).toBeGreaterThan(0)
  })

  it.each(ALL_MEMBERS)(
    '$kind "$value": VS Code remediation kind matches core\'s remediationFor()',
    (member) => {
      const expectedKind =
        member.kind === 'reason'
          ? remediationFor({ kind: 'reason', reason: member.value }).kind
          : remediationFor({ kind: 'result', result: member.value }).kind
      expect(
        vsCodeKind[member.value],
        `VS Code remediation kind for "${member.value}" (${member.kind}) should be "${expectedKind}"`
      ).toBe(expectedKind)
    }
  )
})
