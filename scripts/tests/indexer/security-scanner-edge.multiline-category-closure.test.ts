/**
 * SMI-5879 Wave 3 item 2 — structural closure test for cohort E's exclusion
 * proof, EDGE TWIN (design doc `smi-5879-edge-twin-parity-design.md`
 * §8.3.1.2.2). Sibling of `packages/core/src/security/scanner/
 * multiline-category-closure.test.ts` — read that file's module doc first,
 * it carries the full rationale for the +32 bound this test protects.
 * @module scripts/tests/indexer/security-scanner-edge.multiline-category-closure
 *
 * ============================================================================
 * TRIPWIRE TRIGGERED (SMI-5879 Wave 2, PR #2192) — rewritten to the literal
 * design-doc assertions
 * ============================================================================
 *
 * An earlier version of this file (see git history) asserted the port had
 * NOT yet landed — "no full-content scan exists on the edge twin today" —
 * and its own module doc named this exact moment as a deliberate TRIPWIRE:
 * "the day someone ports a scanPatternsWithMultilineSupport-shaped
 * full-content pass to the edge twin..., this file must be rewritten to
 * assert the design doc's LITERAL three assertions..., mirroring the core
 * twin file." Wave 2 (this PR) is that port landing
 * (`security-scanner-edge.multiline.ts`). This version now mirrors
 * `packages/core/src/security/scanner/multiline-category-closure.test.ts`'s
 * structure directly:
 *
 *   assertion 1 — `scanPatternsWithMultilineSupport` has exactly two call
 *   sites in `security-scanner-edge.ts` (`scanJailbreakPatterns`,
 *   `scanPromptInjection`), with `type:` values `{jailbreak,
 *   prompt_injection}`. Edge has no separate `ai_defence` finding type —
 *   core's `AI_DEFENCE_PATTERNS` subset maps onto edge's single
 *   `PROMPT_INJECTION_PATTERNS` array (SMI-4960) — so edge's AI-category
 *   type multiset is `{jailbreak, prompt_injection}`, not core's
 *   `{jailbreak, ai_defence}`.
 *
 *   assertion 2 — every pattern the multiline pass's first pass actually
 *   reads (`resolvePatternScope(p) !== 'line'`, the SMI-5881-adapted
 *   equivalent of core's now-deleted `isMultilinePattern()` — see core's own
 *   module doc for why) is non-empty. Unlike core, this file does NOT
 *   separately re-assert "every pass-1 pattern has an explicit evidence-tier
 *   entry": `security-scanner-edge.evidence.ts`'s own `assertEvidenceCoverage()`
 *   already throws at MODULE LOAD if any `JAILBREAK_PATTERNS`/
 *   `PROMPT_INJECTION_PATTERNS` entry lacks one — strictly stronger coverage
 *   (100% of both arrays, not just the pass-1 subset) than a test-time check
 *   would add.
 *
 *   assertion 3 — no non-AI pattern array (`SUSPICIOUS_PATTERNS`,
 *   `DATA_EXFILTRATION_PATTERNS`, `PRIVILEGE_ESCALATION_PATTERNS`,
 *   `CODE_EXECUTION_PATTERNS`) is routed through the multiline pass, checked
 *   two ways: (a) directly from the call-site census — no `NON_AI_ARRAY_NAMES`
 *   entry ever appears as a `patterns:` identifier at any call site, and (b)
 *   per-function, as before — each non-AI array's own dedicated scan function
 *   still only calls `safeRegexTest` with a per-line-scoped argument.
 *
 * The per-file introspection approach (Node mirror via AST here, live
 * Supabase twin via the sibling `supabase-twin.test.ts` file) and the
 * code-review remediations below are unchanged — only the assertions
 * themselves flipped from "the port hasn't landed" to "the port landed
 * correctly".
 *
 * The "AI category, edge-side" identity is grounded directly in currently
 * importable source rather than asserted from prose: `CATEGORY_COEFFICIENTS`
 * (`security-scanner-edge.context.ts`) stages `jailbreak: 0.2` and
 * `prompt_injection: 0.12 // mapped to core ai_defence` — i.e. edge's own
 * coefficient table agrees with core's {jailbreak: 0.20, ai_defence: 0.12}
 * AI-category coefficients (SMI-4960). Checked below as a grounding fact,
 * additional to (not a substitute for) the three routing assertions.
 *
 * Introspects the unencrypted Node mirror (`scripts/indexer/_shared/
 * security-scanner-edge*.ts`), matching the established precedent in this
 * directory (`security-scanner-edge.test.ts`, `security-scanner-edge.
 * tier-independence.test.ts`) — PLUS the live `supabase/functions/_shared/`
 * twin directly, in the sibling
 * `security-scanner-edge.multiline-category-closure.supabase-twin.test.ts`
 * file (split out to keep this file under the 500-line standard).
 *
 * CODE-REVIEW REMEDIATIONS CARRIED FORWARD FROM THE PRE-PORT VERSION
 * (SMI-5879 Wave 3 item 2 code-review, NO-GO — fixed; still load-bearing)
 *
 * `extractMultilineCallSites` and `extractSafeRegexTestSecondArgs` (both in
 * the shared fixtures file) walk the real TypeScript AST
 * (`ts.createSourceFile` + `CallExpression` traversal resolved through
 * `collectAliases`, which resolves both import renames and local variable
 * aliases) rather than a bounded text/regex scan — exhaustive by
 * construction against extra whitespace before `(`, a locally-aliased or
 * renamed-import identifier, or a non-identifier argument, which a regex
 * scan could silently miss (the original Finding 1/Finding 3 defects, fixed
 * before the pre-port version of this file was ever merged).
 *
 * Finding 2's remediation (the sibling `supabase-twin.test.ts` file
 * inspecting the DEPLOYED twin directly rather than citing another test's
 * coverage) is also unchanged — see that file for its own doc comment.
 */

import { describe, it, expect } from 'vitest'
import {
  JAILBREAK_PATTERNS,
  PROMPT_INJECTION_PATTERNS,
  SUSPICIOUS_PATTERNS,
  DATA_EXFILTRATION_PATTERNS,
  PRIVILEGE_ESCALATION_PATTERNS,
} from '../../indexer/_shared/security-scanner-edge.patterns.ts'
import { CODE_EXECUTION_PATTERNS } from '../../indexer/_shared/security-scanner-edge.exec.ts'
import { CATEGORY_COEFFICIENTS } from '../../indexer/_shared/security-scanner-edge.context.ts'
import { resolvePatternScope } from '../../indexer/_shared/security-scanner-edge.evidence.ts'
import {
  SCANNER_SRC,
  EXEC_SRC,
  CONTEXT_SRC,
  PATTERNS_SRC,
  MULTILINE_SRC,
  PER_LINE_SCOPED_IDENTIFIERS,
  extractSafeRegexTestSecondArgs,
  extractFunctionBody,
  extractMultilineCallSites,
  TARGET_MULTILINE_FUNCTION_NAME,
  AI_CATEGORY_ARRAY_NAMES,
  NON_AI_ARRAY_NAMES,
} from './security-scanner-edge.multiline-category-closure.fixtures.ts'

describe('SMI-5879 Wave 3 item 2 — multiline-pass category closure, EDGE TWIN (design doc §8.3.1.2.2)', () => {
  const callSites = extractMultilineCallSites('security-scanner-edge.ts', SCANNER_SRC)

  // --------------------------------------------------------------------
  // Assertion 1 — the multiline pass has exactly two call sites, both AI-category
  // --------------------------------------------------------------------
  describe('assertion 1 — exactly two call sites, both AI-category (design doc P1/P2, edge-adapted)', () => {
    it(`${TARGET_MULTILINE_FUNCTION_NAME} is called exactly twice in security-scanner-edge.ts`, () => {
      expect(callSites).toHaveLength(2)
    })

    it('the extracted type: multiset equals exactly [jailbreak, prompt_injection] — no more, no fewer, no substitution', () => {
      const types = callSites.map((s) => s.type).sort()
      expect(types).toEqual(['jailbreak', 'prompt_injection'])
    })

    it(`${TARGET_MULTILINE_FUNCTION_NAME} appears nowhere outside its own definition and the two scanner call sites`, () => {
      const filesThatMustNotReferenceIt: ReadonlyArray<{ name: string; src: string }> = [
        { name: 'security-scanner-edge.exec.ts', src: EXEC_SRC },
        { name: 'security-scanner-edge.context.ts', src: CONTEXT_SRC },
        { name: 'security-scanner-edge.patterns.ts', src: PATTERNS_SRC },
      ]
      for (const { name, src } of filesThatMustNotReferenceIt) {
        expect(
          src,
          `${name} unexpectedly references ${TARGET_MULTILINE_FUNCTION_NAME}`
        ).not.toContain(TARGET_MULTILINE_FUNCTION_NAME)
      }
    })

    it('every safeRegexTest() call site in security-scanner-edge.ts (the non-AI scanners) passes a per-line-scoped second argument', () => {
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
            `either a new per-line variable name was introduced (add it to the allowlist) or a new ` +
            `full-content scan was introduced outside the multiline-pass engine`
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

    it("every safeRegexTest() call site in the multiline pass's own pass-2 loop passes a per-line-scoped second argument", () => {
      const args = extractSafeRegexTestSecondArgs(MULTILINE_SRC)
      expect(args.length).toBeGreaterThan(0)
      for (const arg of args) {
        expect(
          PER_LINE_SCOPED_IDENTIFIERS.has(arg),
          `safeRegexTest() called with second argument "${arg}" in security-scanner-edge.multiline.ts`
        ).toBe(true)
      }
    })

    it('"content" / "scannedContent" (the full-document identifiers) are never a safeRegexTest() second argument anywhere', () => {
      const args = [
        ...extractSafeRegexTestSecondArgs(SCANNER_SRC),
        ...extractSafeRegexTestSecondArgs(EXEC_SRC),
        ...extractSafeRegexTestSecondArgs(MULTILINE_SRC),
      ]
      expect(args).not.toContain('content')
      expect(args).not.toContain('scannedContent')
    })
  })

  // --------------------------------------------------------------------
  // Assertion 2 — every pattern the multiline pass's first pass actually reads
  // --------------------------------------------------------------------
  describe('assertion 2 — every pass-1 pattern is non-vacuous (SMI-5881-adapted)', () => {
    // "Pass 1" = every pattern scanPatternsWithMultilineSupport's first pass
    // actually reads: resolvePatternScope(pattern) !== 'line' — the
    // SMI-5881-adapted equivalent of core's deleted isMultilinePattern()
    // (see this file's module doc for why). Evidence-tier coverage for every
    // JAILBREAK_PATTERNS/PROMPT_INJECTION_PATTERNS entry (not just this
    // pass-1 subset) is already enforced at module load by
    // security-scanner-edge.evidence.ts's own assertEvidenceCoverage() —
    // not re-checked here, see module doc.
    const routed = [...JAILBREAK_PATTERNS, ...PROMPT_INJECTION_PATTERNS]
    const pass1 = routed.filter((p) => resolvePatternScope(p) !== 'line')

    it('JAILBREAK_PATTERNS and PROMPT_INJECTION_PATTERNS are non-empty (the arrays genuinely exist and are not vacuous)', () => {
      expect(JAILBREAK_PATTERNS.length).toBeGreaterThan(0)
      expect(PROMPT_INJECTION_PATTERNS.length).toBeGreaterThan(0)
    })

    it('the pass-1 subset is non-empty — the pass is not vacuous', () => {
      expect(pass1.length).toBeGreaterThan(0)
    })

    it('CATEGORY_COEFFICIENTS grounds the AI-category identity: jailbreak=0.2, prompt_injection=0.12 (mapped to core ai_defence, SMI-4960)', () => {
      expect(CATEGORY_COEFFICIENTS.jailbreak).toBe(0.2)
      expect(CATEGORY_COEFFICIENTS.prompt_injection).toBe(0.12)
      expect(CONTEXT_SRC).toMatch(/prompt_injection:\s*0\.12,?\s*\/\/\s*mapped to core ai_defence/)
    })
  })

  // --------------------------------------------------------------------
  // Assertion 3 — no non-AI pattern array is routed through the multiline pass
  // --------------------------------------------------------------------
  describe('assertion 3 — no non-AI pattern array is routed through the multiline pass (design doc P3)', () => {
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
