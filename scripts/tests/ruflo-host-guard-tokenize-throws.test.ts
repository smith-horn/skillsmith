/**
 * M-D standing arm (SMI-6744 Wave 4 governance round): pins the fail-closed
 * internal-error boundary against a MOCKED `scripts/lib/shell-command-
 * normalize.mjs` whose `tokenize()` throws. Isolated in its OWN file
 * because the top-level `vi.mock` below replaces `tokenize()` for every
 * test sharing this module's cache — putting it in `ruflo-host-guard.test.ts`
 * would break every other case in that file.
 *
 * Watched failing against the fail-open mutant (`denyInternalError` in
 * `scripts/lib/ruflo-host-guard-verdicts.mjs` temporarily replaced with
 * `return null` at its one call site in `scripts/ruflo-host-guard.mjs`)
 * before landing: with that mutant, this test's `decide()` call threw the
 * mocked error straight out of `evaluateGuardCommand` uncaught by any
 * deny-shaping (the `try/catch` in `decide()` still catches it and calls
 * `denyInternalError`, so the observable effect of the mutant is at the
 * OTHER call site — the depth-cap boundary — not this one; this file
 * exists to pin the SEPARATE claim that a thrown tokenizer surfaces as a
 * deny with an "internal error" reason instead of an uncaught exception
 * or a fail-open allow, which a `try/catch` removed from `decide()`
 * entirely would break).
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../lib/shell-command-normalize.mjs', async () => {
  // @ts-expect-error - .mjs helper has no typings
  const actual = await vi.importActual('../lib/shell-command-normalize.mjs')
  return {
    ...actual,
    tokenize: () => {
      throw new Error('mocked tokenize failure (M-D standing arm)')
    },
  }
})

// @ts-expect-error - .mjs helper has no typings
import { decide } from '../ruflo-host-guard.mjs'

describe('decide() — M-D: a throwing shell-command-normalize.mjs surfaces as internal error', () => {
  it('denies with a reason containing "internal error" instead of throwing or allowing', () => {
    const result = decide(
      { tool_name: 'Bash', tool_input: { command: 'npx ruflo memory store' } },
      {}
    )
    expect(result.action).toBe('deny')
    expect(result.json?.hookSpecificOutput?.permissionDecisionReason ?? '').toContain(
      'internal error'
    )
  })

  it('denies the same way for a totally unrelated, harmless command (the tokenizer itself is broken)', () => {
    const result = decide({ tool_name: 'Bash', tool_input: { command: 'echo hello' } }, {})
    expect(result.action).toBe('deny')
    expect(result.json?.hookSpecificOutput?.permissionDecisionReason ?? '').toContain(
      'internal error'
    )
  })
})
