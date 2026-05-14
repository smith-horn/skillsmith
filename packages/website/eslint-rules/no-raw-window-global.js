/**
 * no-raw-window-global ESLint rule (SMI-4904)
 *
 * Bans raw reads/writes of specific `window.<name>` globals outside the
 * single producer file that owns the global. Forces consumers to use a
 * lazy-init helper instead, eliminating the race shape from SMI-4895
 * (device-login: device.astro read `window.__SUPABASE_CLIENT__` directly
 * and lost a tick to BaseLayout's eager init handler).
 *
 * The rule is config-driven via the BANNED_GLOBALS map below. Adding a new
 * banned global is a config-only edit; the rule visitor logic does not change.
 *
 * Visits BOTH access shapes:
 *   - Dot-access     `window.__SUPABASE_CLIENT__`
 *   - Bracket-literal `window['__SUPABASE_CLIENT__']`
 *
 * Out of scope (documented for future contributors):
 *   - Dynamic-key access: `const k = '__SUPABASE_CLIENT__'; window[k]` —
 *     requires data-flow analysis. If this shape proves to be a recurring
 *     bypass, escalate to a second rule that flags any `window[<var>]`
 *     where the variable's possible values overlap BANNED_GLOBALS.
 *   - `globalThis.<name>` / `self.<name>` — only `window.<name>` is banned
 *     because the recurring incident is browser-only and we want low false
 *     positives. Extend if a globalThis-shaped incident lands.
 *
 * Plan: docs/internal/implementation/concurrency-tooling-operationalization.md §4
 *       (EDIT 1 + inline-edits #9, #15)
 */

/**
 * @typedef {{
 *   allowedFiles: string[],
 *   helper: string
 * }} BannedGlobalConfig
 *
 * @typedef {Record<string, BannedGlobalConfig>} BannedGlobalsConfig
 */

/**
 * @type {BannedGlobalsConfig}
 *
 * Config invariants (enforced by the rule's own test suite — see
 * tests/eslint-rules/no-raw-window-global.test.ts):
 *
 * 1. Every entry must have both `allowedFiles` (non-empty array) and `helper`
 *    (non-empty string). The rule test fails if either is missing.
 * 2. Every entry must have a matching fixture pair (allowed-file passes,
 *    banned-file fails) in the test suite. Adding a new entry without the
 *    test fails the rule's own test run.
 * 3. `allowedFiles[]` entries are matched via `endsWith()` against the
 *    linted file's path — typically a basename (`'supabase-client.ts'`) or
 *    a sub-path (`'src/lib/supabase-client.ts'`). Use the shortest unambiguous
 *    suffix; an ambiguous match is a config bug.
 *
 * Per plan EDIT 1 (Critical): `__SUPABASE_CLIENT__.allowedFiles` is exactly
 * `['supabase-client.ts']` — BaseLayout.astro does NOT read the raw global
 * (it calls `getSupabaseClient()`), so authorizing it would smuggle in a
 * second producer, defeating the rule's single-writer guarantee.
 */
const BANNED_GLOBALS = {
  __SUPABASE_CLIENT__: {
    // Single producer per SMI-3595. BaseLayout.astro calls getSupabaseClient(),
    // it does not read window.__SUPABASE_CLIENT__ directly. Per plan EDIT 1,
    // authorizing BaseLayout would defeat the single-producer guarantee.
    allowedFiles: ['supabase-client.ts'],
    helper: 'getSupabaseClient',
  },
}

/**
 * Returns the banned-global key matched by a property node, or null.
 * Handles both dot-access (`window.X`) and bracket-literal (`window['X']`).
 */
function matchBannedKey(node) {
  if (node.object.type !== 'Identifier' || node.object.name !== 'window') {
    return null
  }
  // Dot-access:   window.__SUPABASE_CLIENT__
  if (!node.computed && node.property.type === 'Identifier') {
    return BANNED_GLOBALS[node.property.name] ? node.property.name : null
  }
  // Bracket-literal-string: window['__SUPABASE_CLIENT__']
  if (
    node.computed &&
    node.property.type === 'Literal' &&
    typeof node.property.value === 'string'
  ) {
    return BANNED_GLOBALS[node.property.value] ? node.property.value : null
  }
  // Dynamic key (`window[k]`) — out of scope per rule header.
  return null
}

function isAllowed(filename, key) {
  return BANNED_GLOBALS[key].allowedFiles.some((suffix) => filename.endsWith(suffix))
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ban raw `window.<global>` reads/writes outside the single producer file; force use of a lazy-init helper.',
      recommended: false,
    },
    messages: {
      useHelper:
        'Use {{ helper }}() instead of raw window.{{ name }} ({{ filename }} is not in allowedFiles for this banned global). See .claude/development/concurrency-patterns.md.',
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename || context.getFilename?.() || '<unknown>'
    return {
      MemberExpression(node) {
        const key = matchBannedKey(node)
        if (!key) return
        if (isAllowed(filename, key)) return
        context.report({
          node,
          messageId: 'useHelper',
          data: {
            helper: BANNED_GLOBALS[key].helper,
            name: key,
            filename,
          },
        })
      },
    }
  },
}

export default rule
export { BANNED_GLOBALS }
