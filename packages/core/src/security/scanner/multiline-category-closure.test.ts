/**
 * SMI-5879 Wave 3 item 2 — structural closure test for cohort E's exclusion
 * proof (design doc `smi-5879-edge-twin-parity-design.md` §8.3.1.2.2).
 * @module @skillsmith/core/security/scanner/multiline-category-closure.test
 *
 * WHY THIS TEST EXISTS
 *
 * The SMI-5879 census (comparing pre-port vs post-port `skills.security_score`
 * across ~344k rows) needs to fully re-simulate every row scoring `>= 8`
 * (cohort C1) but can structurally EXCLUDE every row scoring `0-7` (cohort E)
 * from that expensive re-simulation — *if and only if* three properties about
 * how the multiline pass routes patterns hold. The design doc's §8.3.1.2.1
 * proves those properties in prose ("P1/P2/P3"); this file promotes that proof
 * to a machine-checked gate (design doc gate G-5) so a future source change
 * that silently invalidates the premise fails CI instead of silently
 * corrupting the census's soundness.
 *
 * THE +32 ARITHMETIC THIS TEST PROTECTS (not itself re-derived here — that is
 * `weights.ts` + the design doc's §8.3.1.2 arithmetic; this file only proves
 * the ROUTING facts the arithmetic depends on):
 *   max joint contribution = 100 * CATEGORY_WEIGHTS.jailbreak.coefficient (0.20)
 *                           + 100 * CATEGORY_WEIGHTS.ai_defence.coefficient (0.12)
 *                           = 32.0
 *   S <= 7  =>  S' <= S + 32 <= 39 < 40 (QUARANTINE_THRESHOLD)  =>  verdict
 *   cannot flip to quarantined for any row starting at or below 7.
 * That bound is sound ONLY IF the multiline pass can never inflate any
 * category's subtotal OTHER than jailbreak / ai_defence. The three assertions
 * below are exactly what closes that "only if".
 *
 * THE DOCUMENTED TRAP (design doc §8.3.1.2.3) — DELIBERATELY NOT REPEATED HERE
 *
 * The design doc warns against writing assertion 3 as "every pattern for
 * which `isMultilinePattern()` returns true belongs to an AI-category array"
 * — that predicate is syntactic (it fires on a NEGATED class `[^\n]`, the
 * literal opposite of "spans lines") and is false today for 9 patterns across
 * two non-AI arrays. This file does not use that predicate at all: assertions
 * 1 and 3 are asserted over the multiline pass's CALL SITES (which pattern
 * array is physically wired to `scanPatternsWithMultilineSupport`'s `patterns:`
 * config field), not over any per-pattern syntactic test. That is the
 * "routing, not predicate" distinction the trap section requires.
 *
 * SMI-5881 ADAPTATION (judgment call — flagged, not silently resolved)
 *
 * The design doc's assertion 2 is written directly against `isMultilinePattern()`
 * as the definition of "PASS-1 pattern". SMI-5881 (merged before this file was
 * written) DELETED `isMultilinePattern()` entirely — no compatibility shim —
 * and replaced the syntactic heuristic with `PATTERN_SCOPE` /
 * `resolvePatternScope()` (`./patterns.scope.ts`), an explicit per-pattern
 * `'line' | 'content' | 'both'` declaration. `isMultilinePattern` cannot be
 * imported here; it no longer exists anywhere under `packages/core/src`
 * (guarded by `packages/core/tests/security/pattern-scope.test.ts`).
 *
 * `scanPatternsWithMultilineSupport`'s pass 1 (SecurityScanner.helpers.ts) now
 * reads: `if (resolvePatternScope(pattern) === 'line') continue` — i.e. pass 1
 * tests every pattern whose resolved scope is NOT `'line'` (`'content'` or
 * `'both'`). That predicate is the faithful, current-source equivalent of the
 * design doc's `routed.filter(isMultilinePattern)` — same set membership
 * question ("which patterns does pass 1 actually read"), expressed against
 * the model that replaced the deleted one. Assertion 2 below uses
 * `resolvePatternScope(p) !== 'line'` for exactly this reason.
 *
 * CODE-REVIEW REMEDIATION (Finding 1 — NO-GO, fixed)
 *
 * A first version of this file enumerated call sites with a bounded
 * text-window regex scan (`CALL_TOKEN = 'scanPatternsWithMultilineSupport('`
 * + an `EXTRACTION_WINDOW`-char lookahead for `type:`/`patterns:`). Codex
 * (gpt-5.6-sol) review flagged that as a silent-false-negative hazard: a new
 * call site using extra whitespace before `(`, a locally-aliased identifier,
 * or a renamed import would be invisible to that regex while the existing two
 * call sites kept the count green — defeating the point of a closure proof
 * meant to catch exactly this class of drift. `extractMultilineCallSites`
 * below instead walks the real TypeScript AST (`ts.createSourceFile` +
 * `CallExpression` traversal resolved through `collectAliases`), which is
 * exhaustive by construction against all three variants. Verified via mutation
 * testing: a temporarily-added call through a whitespace-before-paren AND a
 * locally-aliased form was both correctly detected (count became 3, assertion
 * 1 failed) before being reverted.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import * as ts from 'typescript'
import { JAILBREAK_PATTERNS, AI_DEFENCE_PATTERNS } from './patterns.jailbreak.js'
import { EVIDENCE_TYPE_BY_PATTERN } from './patterns.jailbreak.evidence.js'
import { resolvePatternScope } from './patterns.scope.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const SCANNER_PATH = join(__dirname, 'SecurityScanner.ts')
const SCANNER_SRC = readFileSync(SCANNER_PATH, 'utf-8')

/** The only two pattern arrays a `scanPatternsWithMultilineSupport` call site may name. */
const AI_CATEGORY_ARRAY_NAMES = ['JAILBREAK_PATTERNS', 'AI_DEFENCE_PATTERNS'] as const

/**
 * Every OTHER pattern array in the scanner (design doc §8.3.1.2.2 assertion 3's
 * explicit exclusion list). `BLOCKED_PATTERNS` is not a real exported const
 * (blocked patterns are an instance-level `ScannerOptions.blockedPatterns`,
 * `SecurityScanner.ts:73`) — kept in the list anyway because the design doc
 * names it explicitly and the check is "this identifier never appears as a
 * `patterns:` value", which is true (and meaningfully checked) regardless of
 * whether the identifier is otherwise reachable.
 */
const NON_AI_ARRAY_NAMES = [
  'SUSPICIOUS_PATTERNS',
  'DATA_EXFILTRATION_PATTERNS',
  'PRIVILEGE_ESCALATION_PATTERNS',
  'CODE_EXECUTION_PATTERNS',
  // SMI-6033 Wave 4 (Gap 1): the second `code_execution` pattern set
  // (patterns.exec.ts). Like CODE_EXECUTION_PATTERNS it is consumed only by
  // scanCodeExecution's per-line loop, never routed through the multiline
  // pass — added here so a future attempt to route it through
  // scanPatternsWithMultilineSupport invalidates the closure proof loudly.
  'IMPERATIVE_FETCH_EXEC_PROSE',
  'BLOCKED_PATTERNS',
] as const

interface MultilineCallSite {
  /** Source-character offset of the call expression (for error messages). */
  offset: number
  /** The `type:` string literal in the call's config object. */
  type: string
  /** The identifier bound to the call's `patterns:` config field. */
  patternsIdent: string
}

const TARGET_FUNCTION_NAME = 'scanPatternsWithMultilineSupport'

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
 * point, so a chain like `const a = target; const b = a` also resolves).
 * This is what makes the call-site walk below exhaustive against the "an
 * alias" failure mode the code review named: a call reached through a
 * renamed import or a locally-aliased identifier still resolves back to
 * `targetName` and is detected, where a literal-token text scan would miss it.
 */
function collectAliases(sourceFile: ts.SourceFile, targetName: string): Set<string> {
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

/** The textual name of an object-literal member (identifier or string-literal key). */
function memberName(prop: ts.ObjectLiteralElementLike): string | undefined {
  if (!prop.name) return undefined
  if (ts.isIdentifier(prop.name)) return prop.name.text
  if (ts.isStringLiteral(prop.name)) return prop.name.text
  return undefined
}

/**
 * Extract every `scanPatternsWithMultilineSupport(...)` call site in `source`
 * (at path `filePath`, used only for error messages), together with its
 * config object's `type:` and `patterns:` values — via full TypeScript AST
 * traversal (`ts.createSourceFile` + a `CallExpression` walk resolved through
 * `collectAliases`), NOT text/regex matching over a bounded window. This is
 * exhaustive by construction: extra whitespace before `(`, a call reached
 * through a renamed import or a locally-aliased identifier, and a config
 * object appearing in any argument position are all still found — closing
 * the class of silent false-negative a bounded text-window regex scan cannot
 * rule out (the defect the code review's Finding 1 identified).
 *
 * Throws (rather than silently skipping) when a matched call's arguments
 * don't have the expected `{ type: '<string literal>', patterns: <bare
 * identifier> }` shape — an unparseable/unexpected call site must fail
 * loudly, not be dropped from the count assertion 1 depends on, exactly as
 * the prior text-based version did for its own class of unparseable input.
 */
function extractMultilineCallSites(filePath: string, source: string): MultilineCallSite[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const aliases = collectAliases(sourceFile, TARGET_FUNCTION_NAME)
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
      `[multiline-category-closure] ${TARGET_FUNCTION_NAME} call at ${filePath}:${offset} has no ` +
        `object-literal argument with both 'type' and 'patterns' properties. Either the call shape ` +
        `changed (update this extraction) or this is a genuine new/malformed call site — both ` +
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
      `[multiline-category-closure] ${TARGET_FUNCTION_NAME} call at ${filePath}:${offset} has a ` +
        `'type' property that is not a plain string literal — this is exactly the "expression ` +
        `argument" shape this AST census exists to catch. Resolve explicitly before this test can pass.`
    )
  }
  if (
    !patternsProp ||
    !ts.isPropertyAssignment(patternsProp) ||
    !ts.isIdentifier(patternsProp.initializer)
  ) {
    throw new Error(
      `[multiline-category-closure] ${TARGET_FUNCTION_NAME} call at ${filePath}:${offset} has a ` +
        `'patterns' property that is not a bare identifier — either a property-access / expression ` +
        `argument was introduced (the exact "silent miss" class this test exists to catch) or the ` +
        `call shape genuinely changed. Resolve explicitly before this test can pass.`
    )
  }

  return {
    offset,
    type: typeProp.initializer.text,
    patternsIdent: patternsProp.initializer.text,
  }
}

describe('SMI-5879 Wave 3 item 2 — multiline-pass category closure (design doc §8.3.1.2.2)', () => {
  const callSites = extractMultilineCallSites(SCANNER_PATH, SCANNER_SRC)

  // --------------------------------------------------------------------
  // Assertion 1 — the multiline pass has exactly two call sites, both AI-category
  // --------------------------------------------------------------------
  describe('assertion 1 — exactly two call sites, both AI-category (design doc P1/P2)', () => {
    it('scanPatternsWithMultilineSupport is called exactly twice in SecurityScanner.ts', () => {
      expect(callSites).toHaveLength(2)
    })

    it('the extracted type: multiset equals exactly [ai_defence, jailbreak] — no more, no fewer, no substitution', () => {
      const types = callSites.map((s) => s.type).sort()
      expect(types).toEqual(['ai_defence', 'jailbreak'])
    })
  })

  // --------------------------------------------------------------------
  // Assertion 2 — every PASS-1 pattern is explicitly classified
  // --------------------------------------------------------------------
  describe('assertion 2 — every pass-1 pattern is explicitly classified (SMI-5881-adapted)', () => {
    // "Pass 1" = every pattern scanPatternsWithMultilineSupport's first pass
    // actually reads: resolvePatternScope(pattern) !== 'line' (see the
    // SMI-5881 ADAPTATION module-doc comment above for why this replaces the
    // design doc's isMultilinePattern-filter wording).
    const routed = [...JAILBREAK_PATTERNS, ...AI_DEFENCE_PATTERNS]
    const pass1 = routed.filter((p) => resolvePatternScope(p) !== 'line')

    it('the pass-1 subset is non-empty — the pass is not vacuous', () => {
      expect(pass1.length).toBeGreaterThan(0)
    })

    it('every pass-1 pattern has an explicit EVIDENCE_TYPE_BY_PATTERN entry (object identity, not fail-closed default)', () => {
      for (const p of pass1) {
        expect(
          EVIDENCE_TYPE_BY_PATTERN.has(p),
          `pattern /${p.source}/${p.flags} has no explicit evidence-tier entry`
        ).toBe(true)
      }
    })
  })

  // --------------------------------------------------------------------
  // Assertion 3 — no non-AI pattern array is routed through the multiline pass
  // --------------------------------------------------------------------
  describe('assertion 3 — no non-AI pattern array is routed through the multiline pass (design doc P3, NOT the isMultilinePattern predicate)', () => {
    it('every call site patterns: identifier is one of the two AI-category arrays', () => {
      for (const site of callSites) {
        expect(
          AI_CATEGORY_ARRAY_NAMES as readonly string[],
          `call site at offset ${site.offset} routes ${site.patternsIdent}, not an AI-category array`
        ).toContain(site.patternsIdent)
      }
    })

    it.each(NON_AI_ARRAY_NAMES)(
      '%s never appears as a patterns: identifier at any call site',
      (arrayName) => {
        const idents = callSites.map((s) => s.patternsIdent)
        expect(idents).not.toContain(arrayName)
      }
    )
  })
})
