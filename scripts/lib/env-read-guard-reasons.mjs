/**
 * Denial-reason text for `scripts/env-read-guard.mjs`, split out of it
 * (retro of PR #2970) so that file has room for behaviour again: it stood at
 * exactly the 500-line convention with zero margin, and a Critical fix could
 * not be written into it. A cohesive unit with no dependency on the guard's
 * rules -- it maps a violation shape to the sentence a developer reads.
 *
 * ADR-172's own Consequences already named this constraint ("env-read-guard
 * sits under the 500-line convention only because its shared helpers live in
 * shell-command-normalize.mjs; further behaviour goes there first").
 *
 * Each reason names the remedy that fits ITS OWN cause (ADR-172
 * Consequences): the varlock advice belongs to a file read, not to a nesting
 * limit that `varlock load` would not change.
 */

const ALTERNATIVE =
  'Use `varlock load` (default pretty format, masked) or `varlock load --quiet` for validation only; ' +
  'for a genuine false positive, re-run with SKILLSMITH_ENV_READ_GUARD_DISABLE=1.'

/** `varlock load` fixes nothing about nesting -- depth-cap gets its own tail. */
const DEPTH_CAP_ALTERNATIVE =
  'Simplify the nesting, or for a genuine false positive re-run with SKILLSMITH_ENV_READ_GUARD_DISABLE=1.'

/**
 * @param {{ kind: string, file?: string, format?: string }} violation
 * @param {number} maxDepth the guard's own `MAX_DEPTH`, named in the
 *   depth-cap sentence so the number cannot drift from the constant.
 * @returns {string}
 */
export function reasonFor(violation, maxDepth) {
  if (violation.kind === 'varlock-format') {
    return (
      `[env-read-guard] \`varlock load --format ${violation.format}\` emits UNMASKED secret ` +
      `values and is prohibited. ${ALTERNATIVE}`
    )
  }
  if (violation.kind === 'depth-cap') {
    return (
      `[env-read-guard] This command nests substitutions past depth ${maxDepth}, which ` +
      `cannot be confirmed safe -- denied by default rather than allowed. ${DEPTH_CAP_ALTERNATIVE}`
    )
  }
  return (
    `[env-read-guard] This command reads \`${violation.file}\`, a secret-bearing env file — ` +
    `reading its contents is prohibited because they would land in the session transcript. ${ALTERNATIVE}`
  )
}
