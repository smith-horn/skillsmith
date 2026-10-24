/**
 * SMI-7168: the complete, reviewed list of validation VERDICTS that differ
 * between zod 3.25.76 (the baseline fixture) and zod 4.6.x and that this
 * migration accepts. Applied only when the parity test runs on zod 4.
 *
 * Error vocabulary is deliberately NOT here. Owner decision: clients keep
 * receiving zod 3's `code` and `message` strings, normalised in
 * `src/validation.legacy.ts`, so a failing input must match the baseline
 * exactly. Only inputs whose pass/fail verdict changed are listed, each with
 * the outcome zod 4 now produces (in the same zod 3 vocabulary).
 */
import type { Outcome } from './input-schema-parity.helpers.js'

const UNSAFE_INT_REJECTED: Outcome = {
  success: false,
  issues: [
    {
      path: 'count',
      code: 'too_big',
      message: 'Number must be less than or equal to 9007199254740991',
    },
  ],
}

const NOT_RFC_UUID = (path: string): Outcome => ({
  success: false,
  issues: [{ path, code: 'invalid_string', message: 'Invalid uuid' }],
})

/**
 * Why each verdict changed:
 *  - undo_apply `count`: zod 3's `.int()` accepted 2**60; zod 4's rejects an integer above
 *    Number.MAX_SAFE_INTEGER. No client can send one in good faith.
 *  - `.uuid()`: zod 3 accepted any 8-4-4-4-12 hex string; zod 4 requires an RFC 9562 version and
 *    variant. Real workspace ids are `gen_random_uuid()` (v4), so they pass; the two cases below
 *    are well-formed-looking strings that no id generator in this repo produces.
 */
export const V4_VERDICT_OVERRIDES: Record<string, Outcome> = {
  'undo_apply/bad:count:unsafe-int': UNSAFE_INT_REJECTED,
  'undo_apply/extra:count-unsafe-int': UNSAFE_INT_REJECTED,
  'team_workspace/extra:uuid-nil-one': NOT_RFC_UUID('workspaceId'),
  'team_workspace/extra:uuid-shaped-not-rfc': NOT_RFC_UUID('workspaceId'),
  'share_skill/extra:uuid-nil-one': NOT_RFC_UUID('workspaceId'),
  'share_skill/extra:uuid-shaped-not-rfc': NOT_RFC_UUID('workspaceId'),
}

/** The outcome zod 4 is expected to produce for `key`, given the zod 3 baseline `base`. */
export function expectedOnV4(key: string, base: Outcome): Outcome {
  return V4_VERDICT_OVERRIDES[key] ?? base
}
