/**
 * SMI-5879 (8.3.3.2): `parse-env.ts` purity backstop.
 *
 * The `run.ts` gate ordering (8.3.3.2 / run-gate-order.test.ts) is safe ONLY
 * because `parseEnv()` — which necessarily runs BEFORE the gate, since the
 * gate's argument (`env.RUN_TYPE`) is produced by it — has no side effects.
 * This test verifies that claim against the source directly (deny-listed I/O
 * identifiers, with comments and string literals stripped first so the
 * module's own "SMI-5321: opt-in fetch-with-truncation" doc-comment doesn't
 * false-positive) rather than trusting the module's own purity claim in its
 * docstring. If `parseEnv()` ever gains I/O, this test fails and the ordering
 * must be redesigned — it must never silently become unsafe.
 */

import { describe, it, expect } from 'vitest'
import * as ts from 'typescript'
import { readIndexerSource, parseIndexerSourceFile } from './run-gate-ast-helpers.ts'

const DENY_LIST = [
  'fetch',
  'fs.',
  'node:fs',
  'node:child_process',
  'execSync',
  'spawn',
  'createClient',
  'http',
  'Deno.',
  'writeFile',
  'readFile',
]

/** Tokenize with the TS scanner and drop every comment/string/template token. */
function stripCommentsAndStrings(source: string): string {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ false,
    ts.LanguageVariant.Standard,
    source
  )
  const DROP = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.SingleLineCommentTrivia,
    ts.SyntaxKind.MultiLineCommentTrivia,
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateHead,
    ts.SyntaxKind.TemplateMiddle,
    ts.SyntaxKind.TemplateTail,
  ])

  let out = ''
  let tok = scanner.scan()
  while (tok !== ts.SyntaxKind.EndOfFileToken) {
    if (!DROP.has(tok)) out += scanner.getTokenText() + ' '
    tok = scanner.scan()
  }
  return out
}

describe('parse-env.ts purity — deny-listed I/O identifiers', () => {
  const stripped = stripCommentsAndStrings(readIndexerSource('parse-env.ts'))

  it.each(DENY_LIST)('contains no occurrence of "%s" outside comments/strings', (identifier) => {
    expect(stripped.includes(identifier)).toBe(false)
  })
})

describe('parse-env.ts purity — its only import is `import type`', () => {
  it('has exactly one ImportDeclaration, and it is type-only', () => {
    const sourceFile = parseIndexerSourceFile('parse-env.ts')
    const imports = sourceFile.statements.filter((s) => ts.isImportDeclaration(s))

    expect(imports).toHaveLength(1)
    const [importDecl] = imports as ts.ImportDeclaration[]
    expect(importDecl.importClause?.isTypeOnly).toBe(true)
  })
})
