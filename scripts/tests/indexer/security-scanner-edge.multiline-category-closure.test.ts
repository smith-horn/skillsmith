/**
 * SMI-5879 Wave 3 item 2 — structural closure test for cohort E's exclusion
 * proof, EDGE TWIN (design doc `smi-5879-edge-twin-parity-design.md`
 * §8.3.1.2.2). Sibling of `packages/core/src/security/scanner/
 * multiline-category-closure.test.ts` — read that file's module doc first,
 * it carries the full rationale for the +32 bound this test protects.
 * @module scripts/tests/indexer/security-scanner-edge.multiline-category-closure
 *
 * ============================================================================
 * JUDGMENT CALL — flagged explicitly, not silently resolved (per task spec)
 * ============================================================================
 *
 * Design doc §8.3.1.2.2 specifies THREE assertions and says to write "its
 * edge twin" implementing them "exactly as specified". Read literally, that
 * means: assert `scanPatternsWithMultilineSupport`-equivalent has exactly two
 * call sites on the edge side too, both AI-category.
 *
 * That is not what the CURRENT edge-twin source is. SMI-5879's own Problem
 * statement (design doc §1) is "port the evidence-tier severity model
 * [including the multiline pass] TO the edge scanner" — i.e. the port this
 * whole initiative exists to do has NOT landed yet. Verified directly against
 * source as of this test's authoring:
 *   - `scanPatternsWithMultilineSupport` (or any identifier resembling it)
 *     does not appear anywhere in `security-scanner-edge.ts` / `.exec.ts` /
 *     `.patterns.ts` / `.context.ts`.
 *   - EVERY `safeRegexTest(` call site in both scanner files (jailbreak,
 *     suspicious, data-exfiltration, privilege-escalation, chmod-compound,
 *     prompt-injection, code-execution, obfuscated-directive — 10 call sites
 *     total) passes a PER-LINE string (`line` / `raw` / `transformed`) as its
 *     second argument. None passes the full document. This machine-confirms
 *     design doc §8.3.1.2.1's own P3 characterization of the edge twin
 *     today: "every [edge] detector is a per-line loop" — which, on the edge
 *     side, is true of ALL detectors right now, not just the non-AI ones,
 *     because there is no multiline pass to be "untouched by" yet.
 *
 * Given that, this file does NOT assert "exactly two AI-category call
 * sites" (there are zero, not two — a materially different fact). Instead it
 * asserts the TRUE-TODAY structural fact that plays the identical role in the
 * closure proof: **no pattern array — AI-category or otherwise — is routed
 * through any full-content scan on the edge twin today**, so for the edge
 * twin as it stands, S' = S trivially (delta 0, a STRICTLY tighter bound
 * than core's +32) with respect to a multiline pass, because that pass does
 * not exist yet. This is the honest, currently-checkable analogue of the
 * three required assertions, re-expressed against what the edge source
 * actually is rather than what the design doc's prose (written against
 * core's already-ported implementation) assumed.
 *
 * This test is a deliberate TRIPWIRE: the day someone ports a
 * `scanPatternsWithMultilineSupport`-shaped full-content pass to the edge
 * twin (the actual point of SMI-5879 sections 2-7), the "no full-content
 * scan exists" assertions below will start failing — which is correct and
 * intentional. At that point this file must be rewritten to assert the
 * design doc's LITERAL three assertions (exactly two call sites, both
 * AI-category = {jailbreak, prompt_injection} on the edge side — see the
 * `CATEGORY_COEFFICIENTS` grounding below for why `prompt_injection` is
 * edge's `ai_defence`), mirroring the core twin file. Do not "fix" a failure
 * here by loosening the assertion — a failure here means the port landed and
 * this file is now stale, not that the check is wrong.
 *
 * The "AI category, edge-side" identity is grounded directly in currently
 * importable source rather than asserted from prose: `CATEGORY_COEFFICIENTS`
 * (`security-scanner-edge.context.ts`) already stages `jailbreak: 0.2` and
 * `prompt_injection: 0.12 // mapped to core ai_defence` — i.e. edge's own
 * coefficient table already agrees with core's {jailbreak: 0.20, ai_defence:
 * 0.12} AI-category coefficients (SMI-4960), even though the pattern-routing
 * port that would let a multiline pass exploit them has not landed. This is
 * checked below as a grounding fact, additional to (not a substitute for) the
 * three routing assertions.
 *
 * Introspects the unencrypted Node mirror (`scripts/indexer/_shared/
 * security-scanner-edge*.ts`), matching the established precedent in this
 * directory (`security-scanner-edge.test.ts`, `security-scanner-edge.
 * tier-independence.test.ts`) — PLUS, as of the Finding 2 remediation, the
 * live `supabase/functions/_shared/` twin directly, in the sibling
 * `security-scanner-edge.multiline-category-closure.supabase-twin.test.ts`
 * file (split out to keep this file under the 500-line standard).
 *
 * FINDING 2 REMEDIATION (SMI-5879 Wave 3 item 2 code-review, NO-GO — fixed)
 *
 * An earlier version of this file introspected ONLY the Node mirror and
 * claimed `quarantine-twin-parity.test.ts` covered the gap to the actual
 * DEPLOYED `supabase/functions/_shared/` twin. That citation was simply
 * wrong: `quarantine-twin-parity.test.ts` guards `quarantine.ts`, an
 * unrelated file — it says nothing about the scanner. (The real byte-identity
 * gate for these four files is `scripts/tests/indexer/parity.test.ts`'s
 * "Deno <-> Node security-scanner-edge parity (SMI-4960)" describe block, via
 * `parity-utils.ts`'s `extractScannerBody` — that file was never checked
 * before writing the original claim.) Rather than relying on citing ANOTHER
 * file's guarantee at all, the sibling `supabase-twin.test.ts` file now
 * inspects BOTH copies directly: every AST census this file runs against the
 * Node mirror is re-run there against the live `supabase/functions/_shared/`
 * copy (`it.skipIf` when git-crypt isn't unlocked, matching this directory's
 * established per-file skip-guard convention), and the two censuses are
 * asserted equal. This is deliberately independent of — not a replacement
 * for — `parity.test.ts`'s own byte-identity guarantee: even if that test
 * were ever weakened or removed, that file's own routing-relevant census
 * still directly gates the deployed source it exists to protect.
 *
 * FINDING 3 REMEDIATION (SMI-5879 Wave 3 item 2 code-review, NO-GO — fixed)
 *
 * An earlier version of this file enumerated `safeRegexTest(` call sites with
 * `/safeRegexTest\(\s*IDENT\s*,\s*IDENT\s*\)/g` — BOTH arguments had to be
 * bare identifiers for a call to match at all. The review flagged this as a
 * broader silent-omission hazard than Finding 1's: extra whitespace before
 * `(`, a property/alias call, OR a non-identifier ("expression") argument in
 * EITHER position made the whole call invisible — not merely
 * misclassified, entirely absent from the census with zero signal.
 * `extractSafeRegexTestSecondArgs` now walks the real TypeScript AST
 * (`ts.createSourceFile` + `CallExpression` traversal resolved through
 * `collectAliases`), which finds every call regardless of whitespace or
 * aliasing, and — critically — THROWS when a found call's second argument
 * isn't a bare identifier, rather than silently dropping it. Verified via
 * mutation testing: a temporarily-added `safeRegexTest(pattern, obj.line)`
 * call (a property-access second argument, invisible to the old regex) was
 * correctly caught (extraction threw) before being reverted.
 */

import { describe, it, expect } from 'vitest'
import {
  JAILBREAK_PATTERNS,
  PROMPT_INJECTION_PATTERNS,
  SUSPICIOUS_PATTERNS,
  DATA_EXFILTRATION_PATTERNS,
  PRIVILEGE_ESCALATION_PATTERNS,
  // SMI-6033 Wave 1: CODE_EXECUTION_PATTERNS moved out of security-scanner-edge.exec.ts
  // (which previously re-declared it inline) into this patterns sibling, its single
  // source of truth — same as every other array imported here.
  CODE_EXECUTION_PATTERNS,
} from '../../indexer/_shared/security-scanner-edge.patterns.ts'
import { CATEGORY_COEFFICIENTS } from '../../indexer/_shared/security-scanner-edge.context.ts'
import {
  SCANNER_SRC,
  EXEC_SRC,
  CONTEXT_SRC,
  ALL_SOURCES,
  PER_LINE_SCOPED_IDENTIFIERS,
  extractSafeRegexTestSecondArgs,
  extractFunctionBody,
} from './security-scanner-edge.multiline-category-closure.fixtures.ts'

describe('SMI-5879 Wave 3 item 2 — multiline-pass category closure, EDGE TWIN (design doc §8.3.1.2.2, adapted — see module doc)', () => {
  // --------------------------------------------------------------------
  // Assertion 1 (edge-adapted) — the port has not landed, and NO pattern
  // array is routed through any full-content scan today.
  // --------------------------------------------------------------------
  describe('assertion 1 (edge-adapted) — zero call sites of a full-content (multiline) pattern scan', () => {
    it('the identifier "scanPatternsWithMultilineSupport" appears nowhere in the edge twin (Node mirror)', () => {
      for (const { name, src } of ALL_SOURCES) {
        expect(
          src,
          `${name} unexpectedly references scanPatternsWithMultilineSupport`
        ).not.toContain('scanPatternsWithMultilineSupport')
      }
    })

    it('every safeRegexTest() call site in security-scanner-edge.ts passes a per-line-scoped second argument', () => {
      const args = extractSafeRegexTestSecondArgs(SCANNER_SRC)
      expect(
        args.length,
        'expected at least one safeRegexTest call site — extraction is not matching'
      ).toBeGreaterThan(0)
      for (const arg of args) {
        expect(
          PER_LINE_SCOPED_IDENTIFIERS.has(arg),
          `safeRegexTest() called with second argument "${arg}", which is not in the known ` +
            `per-line-scoped identifier set ${JSON.stringify([...PER_LINE_SCOPED_IDENTIFIERS])} — ` +
            `either a new per-line variable name was introduced (add it to the allowlist) or a ` +
            `full-content scan was introduced (this is the multiline-pass port landing — see the ` +
            `module doc's TRIPWIRE note)`
        ).toBe(true)
      }
    })

    it('every safeRegexTest() call site in security-scanner-edge.exec.ts passes a per-line-scoped second argument', () => {
      const args = extractSafeRegexTestSecondArgs(EXEC_SRC)
      expect(args.length).toBeGreaterThan(0)
      for (const arg of args) {
        expect(
          PER_LINE_SCOPED_IDENTIFIERS.has(arg),
          `safeRegexTest() called with second argument "${arg}" in security-scanner-edge.exec.ts`
        ).toBe(true)
      }
    })

    it('"content" (the full-document identifier) is never a safeRegexTest() second argument anywhere', () => {
      const args = [
        ...extractSafeRegexTestSecondArgs(SCANNER_SRC),
        ...extractSafeRegexTestSecondArgs(EXEC_SRC),
      ]
      expect(args).not.toContain('content')
    })
  })

  // --------------------------------------------------------------------
  // Assertion 2 (edge-adapted) — the AI-category arrays' own dedicated
  // scan functions are, specifically, also per-line-only.
  // --------------------------------------------------------------------
  describe('assertion 2 (edge-adapted) — the AI-category arrays (jailbreak, prompt_injection) are scanned exclusively per-line', () => {
    it('JAILBREAK_PATTERNS and PROMPT_INJECTION_PATTERNS are non-empty (the arrays genuinely exist and are not vacuous)', () => {
      expect(JAILBREAK_PATTERNS.length).toBeGreaterThan(0)
      expect(PROMPT_INJECTION_PATTERNS.length).toBeGreaterThan(0)
    })

    it('scanJailbreakPatterns iterates JAILBREAK_PATTERNS and every safeRegexTest call inside it is per-line-scoped', () => {
      const body = extractFunctionBody(
        SCANNER_SRC,
        'security-scanner-edge.ts',
        'scanJailbreakPatterns'
      )
      expect(body).toContain('JAILBREAK_PATTERNS')
      const args = extractSafeRegexTestSecondArgs(body)
      expect(args.length).toBeGreaterThan(0)
      for (const arg of args) expect(PER_LINE_SCOPED_IDENTIFIERS.has(arg)).toBe(true)
    })

    it('scanPromptInjection iterates PROMPT_INJECTION_PATTERNS and every safeRegexTest call inside it is per-line-scoped', () => {
      const body = extractFunctionBody(
        SCANNER_SRC,
        'security-scanner-edge.ts',
        'scanPromptInjection'
      )
      expect(body).toContain('PROMPT_INJECTION_PATTERNS')
      const args = extractSafeRegexTestSecondArgs(body)
      expect(args.length).toBeGreaterThan(0)
      for (const arg of args) expect(PER_LINE_SCOPED_IDENTIFIERS.has(arg)).toBe(true)
    })

    it('CATEGORY_COEFFICIENTS grounds the AI-category identity: jailbreak=0.2, prompt_injection=0.12 (mapped to core ai_defence, SMI-4960)', () => {
      // Grounding fact, not a substitute for the routing assertions above:
      // ties this file's "AI category" definition to the exact coefficients
      // the design doc's +32 arithmetic depends on (100*0.20 + 100*0.12 =
      // 32), confirming edge's own coefficient table already agrees with
      // core's even though the routing port has not landed.
      expect(CATEGORY_COEFFICIENTS.jailbreak).toBe(0.2)
      expect(CATEGORY_COEFFICIENTS.prompt_injection).toBe(0.12)
      expect(CONTEXT_SRC).toMatch(/prompt_injection:\s*0\.12,?\s*\/\/\s*mapped to core ai_defence/)
    })
  })

  // --------------------------------------------------------------------
  // Assertion 3 (edge-adapted) — the non-AI arrays are, specifically,
  // ALSO per-line-only (not merely that the AI arrays happen to be).
  // --------------------------------------------------------------------
  describe('assertion 3 (edge-adapted) — no non-AI pattern array is routed through a full-content scan', () => {
    const NON_AI_FUNCTION_MAP: ReadonlyArray<{
      arrayName: string
      array: readonly RegExp[]
      functionName: string
      src: string
      fileLabel: string
    }> = [
      {
        arrayName: 'SUSPICIOUS_PATTERNS',
        array: SUSPICIOUS_PATTERNS,
        functionName: 'scanSuspiciousPatterns',
        src: SCANNER_SRC,
        fileLabel: 'security-scanner-edge.ts',
      },
      {
        arrayName: 'DATA_EXFILTRATION_PATTERNS',
        array: DATA_EXFILTRATION_PATTERNS,
        functionName: 'scanDataExfiltration',
        src: SCANNER_SRC,
        fileLabel: 'security-scanner-edge.ts',
      },
      {
        arrayName: 'PRIVILEGE_ESCALATION_PATTERNS',
        array: PRIVILEGE_ESCALATION_PATTERNS,
        functionName: 'scanPrivilegeEscalation',
        src: SCANNER_SRC,
        fileLabel: 'security-scanner-edge.ts',
      },
      {
        arrayName: 'CODE_EXECUTION_PATTERNS',
        array: CODE_EXECUTION_PATTERNS,
        functionName: 'scanCodeExecution',
        src: EXEC_SRC,
        fileLabel: 'security-scanner-edge.exec.ts',
      },
    ]

    it.each(NON_AI_FUNCTION_MAP)(
      '$arrayName is non-empty and its dedicated scan function ($functionName) is per-line-only',
      ({ arrayName, array, functionName, src, fileLabel }) => {
        expect(array.length, `${arrayName} is empty`).toBeGreaterThan(0)
        const body = extractFunctionBody(src, fileLabel, functionName)
        expect(body, `${functionName} does not reference ${arrayName}`).toContain(arrayName)
        const args = extractSafeRegexTestSecondArgs(body)
        expect(args.length, `${functionName} has no safeRegexTest call sites`).toBeGreaterThan(0)
        for (const arg of args) {
          expect(
            PER_LINE_SCOPED_IDENTIFIERS.has(arg),
            `${functionName} calls safeRegexTest with non-per-line second argument "${arg}"`
          ).toBe(true)
        }
      }
    )
  })
})
