/**
 * M-D standing arm (SMI-6744 Wave 4 governance round): pins the fail-closed
 * internal-error boundary against a MOCKED `scripts/lib/shell-command-
 * normalize.mjs` whose `tokenize()` throws. Isolated in its OWN file
 * because the top-level `vi.mock` below replaces `tokenize()` for every
 * test sharing this module's cache — putting it in `ruflo-host-guard.test.ts`
 * would break every other case in that file.
 *
 * M-5 correction (SMI-6744 Wave 4 delta governance round): the previous
 * version of this comment said "its one call site", but
 * `scripts/ruflo-host-guard.mjs` has TWO `denyInternalError` call sites,
 * and conflated which one this file's own arms actually exercise:
 *   1. `decide()`'s own outer `try { … } catch (err) { return
 *      denyInternalError(...) }` — catches ANY exception thrown while
 *      evaluating a command, tokenizer failures included.
 *   2. `evaluateGuardCommand`'s own `if (depth > MAX_DEPTH) return
 *      denyInternalError(...)` — a completely unrelated condition (too
 *      much nested-shell-text recursion), never reached by a thrown
 *      tokenizer at all.
 *
 * BOTH of this file's own `it(...)` arms below exercise call site 1 ONLY
 * (a mocked `tokenize()` that always throws is caught by `decide()`'s own
 * `catch`, regardless of which command string is passed in — that is why
 * the second arm below, a totally harmless `echo hello`, denies exactly
 * like the first). Watched failing against the fail-open mutant
 * (`denyInternalError` in `scripts/lib/ruflo-host-guard-verdicts.mjs`
 * temporarily replaced with `return null`), MEASURED, not assumed: with
 * that mutant, `decide()`'s own `catch (err) { return denyInternalError(...)
 * }` returns `null` directly (the function's return value IS `decide()`'s
 * own return value there), so both arms below throw `TypeError: Cannot
 * read properties of null (reading 'action')` at their own `result.action`
 * assertion, confirmed by actually running this file against that mutant.
 * Call site 2 (the depth-cap boundary) is pinned SEPARATELY by
 * `ruflo-host-guard.test.ts`'s own "M-D: standing arm for the fail-closed
 * depth-cap boundary" test (eight nested `$(...)` substitutions), which
 * this file's mocked tokenizer never reaches.
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
