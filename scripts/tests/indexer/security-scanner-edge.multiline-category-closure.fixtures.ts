/**
 * SMI-5879 Wave 3 item 2 — shared fixtures for
 * security-scanner-edge.multiline-category-closure.test.ts and
 * security-scanner-edge.multiline-category-closure.supabase-twin.test.ts
 * (split out to keep each file under the 500-line standard). See the main
 * test file's module doc for the full rationale.
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { isGitCryptEncrypted } from './parity-utils.ts'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const SHARED_DIR = join(__dirname, '..', '..', 'indexer', '_shared')
export const SCANNER_SRC = readFileSync(join(SHARED_DIR, 'security-scanner-edge.ts'), 'utf-8')
export const EXEC_SRC = readFileSync(join(SHARED_DIR, 'security-scanner-edge.exec.ts'), 'utf-8')
export const CONTEXT_SRC = readFileSync(
  join(SHARED_DIR, 'security-scanner-edge.context.ts'),
  'utf-8'
)
export const PATTERNS_SRC = readFileSync(
  join(SHARED_DIR, 'security-scanner-edge.patterns.ts'),
  'utf-8'
)
export const MULTILINE_SRC = readFileSync(
  join(SHARED_DIR, 'security-scanner-edge.multiline.ts'),
  'utf-8'
)

export const ALL_SOURCES: ReadonlyArray<{ name: string; src: string }> = [
  { name: 'security-scanner-edge.ts', src: SCANNER_SRC },
  { name: 'security-scanner-edge.exec.ts', src: EXEC_SRC },
  { name: 'security-scanner-edge.context.ts', src: CONTEXT_SRC },
  { name: 'security-scanner-edge.patterns.ts', src: PATTERNS_SRC },
  { name: 'security-scanner-edge.multiline.ts', src: MULTILINE_SRC },
]

// --------------------------------------------------------------------
// Finding 2 closure: this file's constants let both test files gate the
// DEPLOYED supabase/functions/_shared/ twin directly, not merely cite
// another test file's coverage (see the main test file's "FINDING 2
// REMEDIATION" module-doc section). git-crypt-encrypted — each `it.skipIf`
// in the supabase-twin test file matches this directory's established
// per-file skip-guard convention (parity.test.ts, quarantine-twin-parity.
// test.ts) for CI lanes without the key.
// --------------------------------------------------------------------
const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const SUPABASE_SHARED_DIR = join(REPO_ROOT, 'supabase', 'functions', '_shared')
export const SUPABASE_SCANNER_PATH = join(SUPABASE_SHARED_DIR, 'security-scanner-edge.ts')
export const SUPABASE_EXEC_PATH = join(SUPABASE_SHARED_DIR, 'security-scanner-edge.exec.ts')
export const SUPABASE_CONTEXT_PATH = join(SUPABASE_SHARED_DIR, 'security-scanner-edge.context.ts')
export const SUPABASE_PATTERNS_PATH = join(SUPABASE_SHARED_DIR, 'security-scanner-edge.patterns.ts')
export const SUPABASE_MULTILINE_PATH = join(
  SUPABASE_SHARED_DIR,
  'security-scanner-edge.multiline.ts'
)

export const supabaseScannerEncrypted = isGitCryptEncrypted(SUPABASE_SCANNER_PATH)
export const supabaseExecEncrypted = isGitCryptEncrypted(SUPABASE_EXEC_PATH)
export const supabaseContextEncrypted = isGitCryptEncrypted(SUPABASE_CONTEXT_PATH)
export const supabasePatternsEncrypted = isGitCryptEncrypted(SUPABASE_PATTERNS_PATH)
export const supabaseMultilineEncrypted = isGitCryptEncrypted(SUPABASE_MULTILINE_PATH)

/**
 * Every identifier this codebase's per-line scan functions actually bind
 * their current LINE to: `line` (the five simple per-line loops + chmod
 * compound), `raw` (obfuscated-directive's untransformed line), `transformed`
 * (obfuscated-directive's de-obfuscated variant of that SAME line — still
 * per-line, never per-document). None of these is `content` (the full
 * document — `scanSkillContent(content)`'s own parameter name) or `lines`
 * (the whole array, never passed whole to `safeRegexTest`, which expects a
 * single string).
 */
export const PER_LINE_SCOPED_IDENTIFIERS: ReadonlySet<string> = new Set([
  'line',
  'raw',
  'transformed',
])

const SAFE_REGEX_TEST_NAME = 'safeRegexTest'

/** The textual callee name of a call expression: `foo(` -> "foo"; `x.bar(` -> "bar". */
function calleeName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text
  return undefined
}

/**
 * Every local identifier in `sourceFile` that resolves to `targetName` — the
 * name itself, any `import { targetName as Local }` rename, and any simple
 * `const Local = <alias>` variable alias (resolved transitively, to a fixed
 * point). `safeRegexTest` is a locally declared function (not imported) in
 * both scanner files, so the import-rename branch is a no-op for that use;
 * `scanPatternsWithMultilineSupport` IS imported (from
 * `security-scanner-edge.multiline.ts`), so the import branch is what makes
 * `extractMultilineCallSites` below robust against a future renamed import —
 * mirroring core's `multiline-category-closure.test.ts` `collectAliases`.
 * Local-alias resolution closes the "alias calls...silently ignored" class of
 * miss the code review's Finding 3 named.
 */
export function collectAliases(sourceFile: ts.SourceFile, targetName: string): Set<string> {
  const aliases = new Set<string>([targetName])

  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause?.namedBindings) continue
    const bindings = stmt.importClause.namedBindings
    if (!ts.isNamedImports(bindings)) continue
    for (const el of bindings.elements) {
      const imported = el.propertyName?.text ?? el.name.text
      if (imported === targetName) aliases.add(el.name.text)
    }
  }

  let changed = true
  while (changed) {
    changed = false
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isIdentifier(node.initializer) &&
        aliases.has(node.initializer.text) &&
        !aliases.has(node.name.text)
      ) {
        aliases.add(node.name.text)
        changed = true
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(sourceFile, visit)
  }
  return aliases
}

/**
 * Extract every `safeRegexTest(...)` call's second-argument identifier from
 * `source` — via full TypeScript AST traversal (`ts.createSourceFile` + a
 * `CallExpression` walk resolved through `collectAliases`), NOT text/regex
 * matching. This is exhaustive by construction against extra whitespace
 * before `(`, property-access or locally-aliased calls, and reordered
 * arguments — the class of miss the code review's Finding 3 identified in the
 * prior `safeRegexTest\(\s*IDENT\s*,\s*IDENT\s*\)` regex (which required BOTH
 * arguments to be bare identifiers, so a call with anything else in either
 * position didn't match the regex AT ALL and vanished from the census with no
 * signal whatsoever).
 *
 * A call whose second argument is anything other than a bare identifier
 * (property access, a call expression, a literal — the "expression
 * arguments" class Finding 3 named) throws rather than being silently
 * dropped: that shape could disguise a full-content scan as something static
 * extraction can't resolve to a known per-line identifier, and this AST
 * census exists specifically to make that impossible to evade quietly.
 */
export function extractSafeRegexTestSecondArgs(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    'snippet.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const aliases = collectAliases(sourceFile, SAFE_REGEX_TEST_NAME)
  const args: string[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression)
      if (name && aliases.has(name)) {
        const offset = node.getStart(sourceFile)
        const second = node.arguments[1]
        if (!second) {
          throw new Error(
            `[multiline-category-closure/edge] ${SAFE_REGEX_TEST_NAME} call at offset ${offset} has ` +
              `fewer than 2 arguments — the call shape changed; update this extraction.`
          )
        }
        if (!ts.isIdentifier(second)) {
          throw new Error(
            `[multiline-category-closure/edge] ${SAFE_REGEX_TEST_NAME} call at offset ${offset} has a ` +
              `non-identifier second argument (${ts.SyntaxKind[second.kind]}: ` +
              `"${second.getText(sourceFile)}") — this AST census exists exactly to catch this: a ` +
              `full-content scan could be disguised as a property/member/call expression rather than ` +
              `a plain per-line identifier. Resolve explicitly (confirm it is still per-line-scoped and ` +
              `extend the known-identifier allowlist, or this is the multiline-pass port landing — see ` +
              `the module doc's TRIPWIRE note) before this test can pass.`
          )
        }
        args.push(second.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return args
}

/**
 * Extract a top-level function's full body (matching braces, not a bounded
 * window) from `source`. Used to scope the per-array "never routed through a
 * full-content scan" checks to exactly the function that consumes each named
 * pattern array, so the assertion stays meaningful even as unrelated
 * functions in the same file change shape.
 */
export function extractFunctionBody(
  source: string,
  fileLabel: string,
  functionName: string
): string {
  const declRe = new RegExp(`function\\s+${functionName}\\s*\\(`)
  const declMatch = declRe.exec(source)
  if (!declMatch) {
    throw new Error(
      `[multiline-category-closure/edge] function ${functionName} not found in ${fileLabel} — ` +
        `the array-to-function mapping this test depends on is stale; update it.`
    )
  }
  const openBraceIdx = source.indexOf('{', declMatch.index)
  if (openBraceIdx === -1) {
    throw new Error(`[multiline-category-closure/edge] no '{' found after ${functionName}(`)
  }
  let depth = 1
  for (let i = openBraceIdx + 1; i < source.length; i++) {
    const c = source[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return source.slice(openBraceIdx, i + 1)
    }
  }
  throw new Error(
    `[multiline-category-closure/edge] unbalanced braces scanning ${functionName} in ${fileLabel}`
  )
}

// ============================================================================
// scanPatternsWithMultilineSupport call-site census — the port has landed
// (SMI-5879 Wave 2), mirroring core's already-reviewed
// `extractMultilineCallSites` (packages/core/src/security/scanner/
// multiline-category-closure.test.ts) rather than reinventing it.
// ============================================================================

export const TARGET_MULTILINE_FUNCTION_NAME = 'scanPatternsWithMultilineSupport'

/** The only two pattern arrays a `scanPatternsWithMultilineSupport` call site may name, edge-side. */
export const AI_CATEGORY_ARRAY_NAMES = ['JAILBREAK_PATTERNS', 'PROMPT_INJECTION_PATTERNS'] as const

/** Every other pattern array in the edge scanner (design doc §8.3.1.2.2 assertion 3's exclusion list, edge-adapted). */
export const NON_AI_ARRAY_NAMES = [
  'SUSPICIOUS_PATTERNS',
  'DATA_EXFILTRATION_PATTERNS',
  'PRIVILEGE_ESCALATION_PATTERNS',
  'CODE_EXECUTION_PATTERNS',
] as const

export interface MultilineCallSite {
  /** Source-character offset of the call expression (for error messages). */
  offset: number
  /** The `type:` string literal in the call's config object. */
  type: string
  /** The identifier bound to the call's `patterns:` config field. */
  patternsIdent: string
}

/** The textual name of an object-literal member (identifier or string-literal key). */
function memberName(prop: ts.ObjectLiteralElementLike): string | undefined {
  if (!prop.name) return undefined
  if (ts.isIdentifier(prop.name)) return prop.name.text
  if (ts.isStringLiteral(prop.name)) return prop.name.text
  return undefined
}

/** Extract and validate the `{ type, patterns }` config object of a matched call. */
function extractCallSiteConfig(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  filePath: string
): MultilineCallSite {
  const offset = call.getStart(sourceFile)
  const configArg = call.arguments.find(
    (arg): arg is ts.ObjectLiteralExpression =>
      ts.isObjectLiteralExpression(arg) &&
      arg.properties.some((p) => memberName(p) === 'type') &&
      arg.properties.some((p) => memberName(p) === 'patterns')
  )
  if (!configArg) {
    throw new Error(
      `[multiline-category-closure/edge] ${TARGET_MULTILINE_FUNCTION_NAME} call at ${filePath}:${offset} ` +
        `has no object-literal argument with both 'type' and 'patterns' properties. Either the call ` +
        `shape changed (update this extraction) or this is a genuine new/malformed call site — both ` +
        `invalidate the closure proof and must be resolved before this test can pass.`
    )
  }

  const typeProp = configArg.properties.find((p) => memberName(p) === 'type')
  const patternsProp = configArg.properties.find((p) => memberName(p) === 'patterns')

  if (
    !typeProp ||
    !ts.isPropertyAssignment(typeProp) ||
    !ts.isStringLiteral(typeProp.initializer)
  ) {
    throw new Error(
      `[multiline-category-closure/edge] ${TARGET_MULTILINE_FUNCTION_NAME} call at ${filePath}:${offset} ` +
        `has a 'type' property that is not a plain string literal — this is exactly the "expression ` +
        `argument" shape this AST census exists to catch. Resolve explicitly before this test can pass.`
    )
  }
  if (
    !patternsProp ||
    !ts.isPropertyAssignment(patternsProp) ||
    !ts.isIdentifier(patternsProp.initializer)
  ) {
    throw new Error(
      `[multiline-category-closure/edge] ${TARGET_MULTILINE_FUNCTION_NAME} call at ${filePath}:${offset} ` +
        `has a 'patterns' property that is not a bare identifier — either a property-access / expression ` +
        `argument was introduced (the exact "silent miss" class this test exists to catch) or the call ` +
        `shape genuinely changed. Resolve explicitly before this test can pass.`
    )
  }

  return {
    offset,
    type: typeProp.initializer.text,
    patternsIdent: patternsProp.initializer.text,
  }
}

/**
 * Extract every `scanPatternsWithMultilineSupport(...)` call site in `source`
 * (at path `filePath`, used only for error messages), via full TypeScript AST
 * traversal resolved through `collectAliases` (which now also resolves
 * `import { X as Local }` renames — see that function's doc comment) — NOT
 * text/regex matching over a bounded window, for the same "silent false
 * negative on a renamed import / aliased call / extra whitespace" reason
 * `extractSafeRegexTestSecondArgs` above already gives.
 */
export function extractMultilineCallSites(filePath: string, source: string): MultilineCallSite[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const aliases = collectAliases(sourceFile, TARGET_MULTILINE_FUNCTION_NAME)
  const sites: MultilineCallSite[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression)
      if (name && aliases.has(name)) {
        sites.push(extractCallSiteConfig(node, sourceFile, filePath))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return sites
}
