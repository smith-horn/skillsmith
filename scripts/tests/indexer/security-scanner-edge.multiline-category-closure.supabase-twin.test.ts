/**
 * SMI-5879 Wave 3 item 2 — Finding 2 closure (SMI-5879 Wave 3 item 2
 * code-review, NO-GO — fixed). Split out from
 * `security-scanner-edge.multiline-category-closure.test.ts` to keep both
 * files under the 500-line standard; read that file's module doc first for
 * the full "FINDING 2 REMEDIATION" rationale.
 *
 * Directly inspects the DEPLOYED `supabase/functions/_shared/` twin, not
 * merely the Node mirror. An earlier version of the sibling file claimed
 * `quarantine-twin-parity.test.ts` covered this gap; it does not (it guards
 * an unrelated file, `quarantine.ts`). Every assertion below reruns the
 * exact same AST census used in the sibling file against the live Supabase
 * copy and cross-checks it against the Node mirror — this file does not
 * depend on citing another test's guarantee to justify inspecting only one
 * twin.
 * @module scripts/tests/indexer/security-scanner-edge.multiline-category-closure.supabase-twin
 */

import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  SCANNER_SRC,
  EXEC_SRC,
  PER_LINE_SCOPED_IDENTIFIERS,
  extractSafeRegexTestSecondArgs,
  SUPABASE_SCANNER_PATH,
  SUPABASE_EXEC_PATH,
  SUPABASE_CONTEXT_PATH,
  SUPABASE_PATTERNS_PATH,
  supabaseScannerEncrypted,
  supabaseExecEncrypted,
  supabaseContextEncrypted,
  supabasePatternsEncrypted,
} from './security-scanner-edge.multiline-category-closure.fixtures.ts'

describe('Finding 2 closure — the deployed Supabase twin is directly inspected, not merely cited', () => {
  it.skipIf(
    supabaseScannerEncrypted ||
      supabaseExecEncrypted ||
      supabaseContextEncrypted ||
      supabasePatternsEncrypted
  )(
    'the identifier "scanPatternsWithMultilineSupport" appears nowhere in the DEPLOYED Supabase copies either',
    () => {
      const supabaseSources: ReadonlyArray<{ name: string; src: string }> = [
        {
          name: 'security-scanner-edge.ts (supabase)',
          src: readFileSync(SUPABASE_SCANNER_PATH, 'utf-8'),
        },
        {
          name: 'security-scanner-edge.exec.ts (supabase)',
          src: readFileSync(SUPABASE_EXEC_PATH, 'utf-8'),
        },
        {
          name: 'security-scanner-edge.context.ts (supabase)',
          src: readFileSync(SUPABASE_CONTEXT_PATH, 'utf-8'),
        },
        {
          name: 'security-scanner-edge.patterns.ts (supabase)',
          src: readFileSync(SUPABASE_PATTERNS_PATH, 'utf-8'),
        },
      ]
      for (const { name, src } of supabaseSources) {
        expect(
          src,
          `${name} unexpectedly references scanPatternsWithMultilineSupport`
        ).not.toContain('scanPatternsWithMultilineSupport')
      }
    }
  )

  it.skipIf(supabaseScannerEncrypted)(
    "safeRegexTest() census over the DEPLOYED Supabase security-scanner-edge.ts matches the Node mirror's exactly (and every arg is per-line-scoped)",
    () => {
      const supabaseArgs = extractSafeRegexTestSecondArgs(
        readFileSync(SUPABASE_SCANNER_PATH, 'utf-8')
      )
      const nodeArgs = extractSafeRegexTestSecondArgs(SCANNER_SRC)
      expect(
        supabaseArgs,
        'Supabase security-scanner-edge.ts safeRegexTest() census diverges from the Node mirror — the deployed source and its Node introspection twin have drifted'
      ).toEqual(nodeArgs)
      for (const arg of supabaseArgs) {
        expect(
          PER_LINE_SCOPED_IDENTIFIERS.has(arg),
          `Supabase security-scanner-edge.ts: safeRegexTest() called with non-per-line second argument "${arg}"`
        ).toBe(true)
      }
    }
  )

  it.skipIf(supabaseExecEncrypted)(
    "safeRegexTest() census over the DEPLOYED Supabase security-scanner-edge.exec.ts matches the Node mirror's exactly (and every arg is per-line-scoped)",
    () => {
      const supabaseArgs = extractSafeRegexTestSecondArgs(readFileSync(SUPABASE_EXEC_PATH, 'utf-8'))
      const nodeArgs = extractSafeRegexTestSecondArgs(EXEC_SRC)
      expect(
        supabaseArgs,
        'Supabase security-scanner-edge.exec.ts safeRegexTest() census diverges from the Node mirror — the deployed source and its Node introspection twin have drifted'
      ).toEqual(nodeArgs)
      for (const arg of supabaseArgs) {
        expect(
          PER_LINE_SCOPED_IDENTIFIERS.has(arg),
          `Supabase security-scanner-edge.exec.ts: safeRegexTest() called with non-per-line second argument "${arg}"`
        ).toBe(true)
      }
    }
  )
})
