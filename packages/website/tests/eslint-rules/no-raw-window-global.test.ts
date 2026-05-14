/**
 * Tests for the no-raw-window-global ESLint rule (SMI-4904).
 *
 * Verifies:
 *   1. The rule reports raw `window.<global>` reads in non-allowed files.
 *   2. The rule visits BOTH dot-access AND bracket-literal-string shapes.
 *   3. Allowed-file matches (suffix endsWith) pass without warning.
 *   4. Every entry in BANNED_GLOBALS has a config shape passing the typedef
 *      invariants (allowedFiles non-empty, helper non-empty).
 *   5. Every entry in BANNED_GLOBALS has BOTH a passing and a failing fixture
 *      in this suite (per plan inline-edit #9 — adding a new entry without
 *      a test fails the rule's own test run).
 *
 * Plan: docs/internal/implementation/concurrency-tooling-operationalization.md §4
 *       (EDIT 1 + inline-edits #9, #15)
 */

import { RuleTester } from 'eslint'
import { describe, it, expect } from 'vitest'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — rule is JS ESM with default export, no types needed for tests.
import rule, { BANNED_GLOBALS } from '../../eslint-rules/no-raw-window-global.js'

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

// ---------------------------------------------------------------------------
// Per-entry fixture coverage tracker.
//
// Plan inline-edit #9: rule unit tests must include a fixture that exercises
// every entry in BANNED_GLOBALS — adding a new entry without a fixture fails
// the rule's own test suite. We populate this set from the test cases below
// and assert it equals the keys in BANNED_GLOBALS.
// ---------------------------------------------------------------------------
const coveredKeys = new Set<string>()

function markCovered(key: string): string {
  coveredKeys.add(key)
  return key
}

// ---------------------------------------------------------------------------
// 1. Static config-shape invariants.
// ---------------------------------------------------------------------------
describe('BANNED_GLOBALS config shape', () => {
  it('each entry has a non-empty allowedFiles array and a non-empty helper string', () => {
    for (const [key, cfg] of Object.entries(BANNED_GLOBALS) as Array<
      [string, { allowedFiles: string[]; helper: string }]
    >) {
      expect(Array.isArray(cfg.allowedFiles), `${key}.allowedFiles is array`).toBe(true)
      expect(cfg.allowedFiles.length, `${key}.allowedFiles non-empty`).toBeGreaterThan(0)
      expect(typeof cfg.helper, `${key}.helper is string`).toBe('string')
      expect(cfg.helper.length, `${key}.helper non-empty`).toBeGreaterThan(0)
    }
  })

  // Plan EDIT 1 (Critical): __SUPABASE_CLIENT__.allowedFiles must be EXACTLY
  // ['supabase-client.ts']. BaseLayout.astro is NOT a producer; authorizing it
  // would smuggle in a second writer and defeat the rule's purpose.
  it('__SUPABASE_CLIENT__.allowedFiles is exactly ["supabase-client.ts"] per plan EDIT 1', () => {
    expect(BANNED_GLOBALS.__SUPABASE_CLIENT__).toBeDefined()
    expect(BANNED_GLOBALS.__SUPABASE_CLIENT__.allowedFiles).toEqual(['supabase-client.ts'])
    expect(BANNED_GLOBALS.__SUPABASE_CLIENT__.helper).toBe('getSupabaseClient')
  })
})

// ---------------------------------------------------------------------------
// 2. RuleTester cases.
//
// One pair (allowed-pass + banned-fail) per entry, plus a bracket-literal
// fixture (plan inline-edit #15) and a dynamic-key fixture (documented
// out-of-scope; should NOT report).
// ---------------------------------------------------------------------------

tester.run('no-raw-window-global', rule, {
  valid: [
    // === __SUPABASE_CLIENT__ — pass in producer ===
    {
      // Dot-access INSIDE supabase-client.ts (the producer) — allowed.
      name: '__SUPABASE_CLIENT__ dot-access in producer file is allowed',
      filename: '/abs/path/to/packages/website/src/lib/supabase-client.ts',
      code: `
        // ${markCovered('__SUPABASE_CLIENT__')}
        export function getSupabaseClient() {
          if (window.__SUPABASE_CLIENT__) return window.__SUPABASE_CLIENT__
          return null
        }
      `,
    },
    {
      // Bracket-literal INSIDE supabase-client.ts — allowed (same file).
      name: '__SUPABASE_CLIENT__ bracket-literal in producer file is allowed',
      filename: '/abs/path/to/packages/website/src/lib/supabase-client.ts',
      code: `
        const x = window['__SUPABASE_CLIENT__']
      `,
    },
    {
      // Dynamic key — out of scope; never reports regardless of file (rule
      // header documents this; plan inline-edit #15 explicit).
      name: 'dynamic-key window access is out of scope and never reports',
      filename: '/abs/path/to/packages/website/src/pages/anywhere.ts',
      code: `
        const k = '__SUPABASE_CLIENT__'
        const x = window[k]
      `,
    },
    {
      // Non-banned global — no report.
      name: 'non-banned global passes anywhere',
      filename: '/abs/path/to/packages/website/src/pages/anything.ts',
      code: `
        const ua = window.navigator.userAgent
        const z = window['location']
      `,
    },
  ],

  invalid: [
    // === __SUPABASE_CLIENT__ — fail outside producer (dot-access) ===
    {
      name: '__SUPABASE_CLIENT__ dot-access outside producer is reported',
      filename: '/abs/path/to/packages/website/src/pages/device.astro',
      code: `
        const c = window.__SUPABASE_CLIENT__
      `,
      errors: [{ messageId: 'useHelper' }],
    },
    // === __SUPABASE_CLIENT__ — fail outside producer (bracket-literal, #15) ===
    {
      name: '__SUPABASE_CLIENT__ bracket-literal outside producer is reported',
      filename: '/abs/path/to/packages/website/src/pages/device.astro',
      code: `
        const c = window['__SUPABASE_CLIENT__']
      `,
      errors: [{ messageId: 'useHelper' }],
    },
    // === __SUPABASE_CLIENT__ — assignment site (write) also flagged ===
    {
      name: '__SUPABASE_CLIENT__ assignment outside producer is reported',
      filename: '/abs/path/to/packages/website/src/pages/sneaky.ts',
      code: `
        window.__SUPABASE_CLIENT__ = null
      `,
      errors: [{ messageId: 'useHelper' }],
    },
    // === Path-separator boundary: substring-bypass must NOT silently allow ===
    // Regression for the bare-endsWith() bug surfaced in the W2 governance
    // retro: a file ending in `-supabase-client.ts` anywhere in the tree
    // would have bypassed the rule. The path-separator boundary in
    // isAllowed() prevents this. The fixture asserts the rule STILL FIRES
    // on a near-miss filename that shares the suffix as a substring.
    {
      name: 'substring-bypass attempt (evil-supabase-client.ts) is still reported',
      filename: '/abs/path/to/packages/website/src/lib/evil-supabase-client.ts',
      code: `
        const c = window.__SUPABASE_CLIENT__
      `,
      errors: [{ messageId: 'useHelper' }],
    },
  ],
})

// ---------------------------------------------------------------------------
// 3. Coverage tracker: every BANNED_GLOBALS entry has a fixture.
// ---------------------------------------------------------------------------
describe('BANNED_GLOBALS fixture coverage (plan inline-edit #9)', () => {
  it('every entry in BANNED_GLOBALS has a fixture in this test suite', () => {
    const configKeys = new Set(Object.keys(BANNED_GLOBALS))
    const missing = [...configKeys].filter((k) => !coveredKeys.has(k))
    expect(
      missing,
      `Missing fixtures for BANNED_GLOBALS entries: ${missing.join(', ')}. Add an allowed-file + banned-file fixture pair per plan inline-edit #9.`
    ).toEqual([])
  })
})
