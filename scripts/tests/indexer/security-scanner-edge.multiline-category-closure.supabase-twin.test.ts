/**
 * SMI-5879 Wave 3 item 2 — Finding 2 closure (SMI-5879 Wave 3 item 2
 * code-review, NO-GO — fixed). Split out from
 * `security-scanner-edge.multiline-category-closure.test.ts` to keep both
 * files under the 500-line standard; read that file's module doc first for
 * the full "FINDING 2 REMEDIATION" rationale and the TRIPWIRE-TRIGGERED note
 * explaining why this file's assertions flipped from "the port hasn't
 * landed" to "the port landed correctly" (SMI-5879 Wave 2, PR #2192).
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
  MULTILINE_SRC,
  PER_LINE_SCOPED_IDENTIFIERS,
  extractSafeRegexTestSecondArgs,
  extractMultilineCallSites,
  SUPABASE_SCANNER_PATH,
  SUPABASE_EXEC_PATH,
  SUPABASE_MULTILINE_PATH,
  supabaseScannerEncrypted,
  supabaseExecEncrypted,
  supabaseContextEncrypted,
  supabasePatternsEncrypted,
  supabaseMultilineEncrypted,
} from './security-scanner-edge.multiline-category-closure.fixtures.ts'

describe('Finding 2 closure — the deployed Supabase twin is directly inspected, not merely cited', () => {
  it.skipIf(
    supabaseScannerEncrypted ||
      supabaseExecEncrypted ||
      supabaseContextEncrypted ||
      supabasePatternsEncrypted ||
      supabaseMultilineEncrypted
  )(
    "the DEPLOYED Supabase security-scanner-edge.ts call-site census for scanPatternsWithMultilineSupport matches the Node mirror's exactly",
    () => {
      const supabaseSites = extractMultilineCallSites(
        SUPABASE_SCANNER_PATH,
        readFileSync(SUPABASE_SCANNER_PATH, 'utf-8')
      )
      const nodeSites = extractMultilineCallSites('security-scanner-edge.ts', SCANNER_SRC)
      const strip = (sites: typeof supabaseSites) =>
        sites
          .map((s) => ({ type: s.type, patternsIdent: s.patternsIdent }))
          .sort((a, b) => a.type.localeCompare(b.type))
      expect(
        strip(supabaseSites),
        'Supabase security-scanner-edge.ts scanPatternsWithMultilineSupport call-site census diverges from the Node mirror — the deployed source and its Node introspection twin have drifted'
      ).toEqual(strip(nodeSites))
      expect(supabaseSites).toHaveLength(2)
    }
  )

  it.skipIf(supabaseMultilineEncrypted)(
    'the identifier "scanPatternsWithMultilineSupport" is defined in the DEPLOYED Supabase security-scanner-edge.multiline.ts twin too',
    () => {
      // Full byte-identity (module-header line excepted, per that module's
      // own doc comment) is parity.test.ts's job, not re-litigated here —
      // this just confirms the function this whole closure proof is about
      // is genuinely present on the deployed side, not only the Node mirror.
      const src = readFileSync(SUPABASE_MULTILINE_PATH, 'utf-8')
      expect(src).toContain('export function scanPatternsWithMultilineSupport')
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

  it.skipIf(supabaseMultilineEncrypted)(
    "safeRegexTest() census over the DEPLOYED Supabase security-scanner-edge.multiline.ts matches the Node mirror's exactly (and every arg is per-line-scoped)",
    () => {
      const supabaseArgs = extractSafeRegexTestSecondArgs(
        readFileSync(SUPABASE_MULTILINE_PATH, 'utf-8')
      )
      const nodeArgs = extractSafeRegexTestSecondArgs(MULTILINE_SRC)
      expect(
        supabaseArgs,
        'Supabase security-scanner-edge.multiline.ts safeRegexTest() census diverges from the Node mirror — the deployed source and its Node introspection twin have drifted'
      ).toEqual(nodeArgs)
      for (const arg of supabaseArgs) {
        expect(
          PER_LINE_SCOPED_IDENTIFIERS.has(arg),
          `Supabase security-scanner-edge.multiline.ts: safeRegexTest() called with non-per-line second argument "${arg}"`
        ).toBe(true)
      }
    }
  )
})
