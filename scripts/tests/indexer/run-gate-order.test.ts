/**
 * SMI-5879 (8.3.3.2): AST statement-order assertions — "the gate must precede
 * the first side effect," not merely "be the first statement." Guards
 * against a future refactor silently demoting the gate below a write.
 */

import { describe, it, expect } from 'vitest'
import * as ts from 'typescript'
import {
  parseIndexerSourceFile,
  findTopLevelFunctionDeclaration,
  firstCallPosition,
  topLevelStatementIndexOfCall,
} from './run-gate-ast-helpers.ts'

/** Side-effect callee names the gate must precede, in every gated main(). */
const SIDE_EFFECT_CALLEES = [
  'createSupabaseAdminClient',
  'fetch',
  'buildGitHubHeaders',
  'rpc',
  'insert',
  'update',
  'delete',
  // SMI-5879 round-7 (design 11.2.7): revalidate-stale-quarantines.ts's
  // --ids-file read (parseIdSelection, revalidate-stale-quarantines.cli.ts)
  // is also pinned to run after assertRunAllowed.
  'readFileSync',
  'readFile',
]

const GATED_ENTRY_FILES = [
  'run.ts',
  'dequarantine-false-positives.ts',
  'purge-dead-quarantines.ts',
  'revalidate-stale-quarantines.ts',
  // PR-review finding (NON-BLOCKING, SMI-5930): the structural
  // gate-precedes-side-effects proof below didn't cover this new writer —
  // run-gate.test.ts and run-gate-callsites.test.ts both confirm the gate
  // calls EXIST, but neither asserts they run BEFORE the script's own
  // side-effecting update() call the way this suite does for its siblings.
  'repair-latched-name-rows.ts',
]

describe('run-gate-order — the gate precedes every side effect, in each of the five main() bodies', () => {
  it.each(GATED_ENTRY_FILES)(
    '%s: assertRunAllowed precedes every side-effect call inside main()',
    (file) => {
      const sourceFile = parseIndexerSourceFile(file)
      const mainFn = findTopLevelFunctionDeclaration(sourceFile, 'main')
      expect(mainFn, `${file} must declare a top-level main()`).toBeDefined()

      const gatePos = firstCallPosition(mainFn as ts.FunctionDeclaration, 'assertRunAllowed')
      expect(gatePos, `${file}'s main() must call assertRunAllowed`).toBeDefined()

      for (const callee of SIDE_EFFECT_CALLEES) {
        const sideEffectPos = firstCallPosition(mainFn as ts.FunctionDeclaration, callee)
        if (sideEffectPos === undefined) continue // not every file calls every callee
        expect(
          (gatePos as number) < sideEffectPos,
          `${file}: assertRunAllowed (pos ${gatePos}) must precede ${callee}( (pos ${sideEffectPos})`
        ).toBe(true)
      }
    }
  )
})

describe('run-gate-order — run.ts: exact adjacency to parseEnv()', () => {
  it('assertRunAllowed is the IMMEDIATE successor of `const env = parseEnv()`, no intervening statement', () => {
    const sourceFile = parseIndexerSourceFile('run.ts')
    const mainFn = findTopLevelFunctionDeclaration(sourceFile, 'main')
    expect(mainFn).toBeDefined()
    const body = (mainFn as ts.FunctionDeclaration).body
    expect(body).toBeDefined()

    const statements = body!.statements
    const envDeclIndex = statements.findIndex(
      (stmt) =>
        ts.isVariableStatement(stmt) &&
        stmt.declarationList.declarations.some(
          (d) =>
            ts.isIdentifier(d.name) &&
            d.name.text === 'env' &&
            d.initializer !== undefined &&
            ts.isCallExpression(d.initializer) &&
            ts.isIdentifier(d.initializer.expression) &&
            d.initializer.expression.text === 'parseEnv'
        )
    )
    expect(
      envDeclIndex,
      'could not find `const env = parseEnv()` in run.ts main()'
    ).toBeGreaterThanOrEqual(0)

    const gateStmtIndex = topLevelStatementIndexOfCall(
      mainFn as ts.FunctionDeclaration,
      'assertRunAllowed'
    )
    expect(
      gateStmtIndex,
      "could not find an assertRunAllowed call at main()'s top level"
    ).toBeDefined()

    expect(gateStmtIndex).toBe(envDeclIndex + 1)
  })
})
