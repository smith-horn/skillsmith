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

  // PARSE ERRORS ARE FATAL HERE, checked rather than assumed.
  // `createSourceFile` RECOVERS an AST from malformed syntax rather than
  // throwing, so without this a syntactically broken mirror could still yield a
  // plausible-looking table — and the prose above used to claim a malformed
  // declaration "fails loudly", which the gate correctly called too broad. The
  // cheap fix is to make the claim true instead of narrowing it: a mirror that
  // does not parse cleanly is not a mirror this test can speak about.
  const parseErrors = (sourceFile as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] })
    .parseDiagnostics
  if (parseErrors !== undefined && parseErrors.length > 0) {
    const first = ts.flattenDiagnosticMessageText(parseErrors[0]?.messageText ?? '', ' ')
    throw new Error(
      `${fileName} does not parse cleanly (${parseErrors.length} diagnostic(s)); ` +
        `first: ${first}. Refusing to extract "${exportName}" from a file the parser ` +
        `had to recover.`
    )
  }

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

// WHAT THIS TEST MEASURES, AND WHAT IT DOES NOT. Stated precisely because two
// cross-family rounds on PR #2952 each found this note claiming more than the
// assertions below deliver.
//
// It establishes three things, not the "exactly two" an earlier version of this note
// claimed -- that was an UNDERCLAIM, and the direction I had just been corrected for
// overshooting. First, the member arithmetic itself: 23 reasons + 15 results = 38
// tagged members, asserted directly, so a change to either closed set fails here
// before any table is read. Second, each table COVERS those sets with non-empty text
// -- checked per table, independently. Third, the VS Code remediation-kind table
// AGREES WITH CORE, member by member. The extractor additionally refuses a mirror it
// cannot read cleanly, which is a precondition rather than a parity property.
//
// It does NOT compare the MCP text with the VS Code text. The two could hold
// completely different sentences and still pass, which is deliberate: §4.4 has each
// surface write its own wording, so identical text is not the property worth pinning.
// An earlier version of this note said the tables "agree with each other", which was
// simply false.
//
// It also does not establish rendering. §4.4's "Every renderer is a `Record<...>`"
// constrains a renderer's REPRESENTATION; it does not make a conforming Record a
// renderer. Neither table has a consumer -- the MCP tools still emit their own older
// diagnosis shapes and the VS Code reader only declares its copy -- so no arm here can
// fail because a surface rendered the wrong thing at runtime. Step 6 is therefore
// PREPARATORY and not complete against §4.4 / T-R4; completion is wiring the tables
// into surface output and testing that boundary, which needs step 5's call sites.
//
// Arms fail when a table omits a member, leaves one blank, or disagrees with core
// about a remediation kind -- and also, not exhaustively, when the AST extraction
// rejects the mirror outright: a malformed declaration, unsupported object syntax, a
// rename, or an in-file value reference all fail loudly rather than yielding an empty
// table.
describe('SMI-6532 step 6: reason/result TABLE parity (MCP + VS Code)', () => {
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
