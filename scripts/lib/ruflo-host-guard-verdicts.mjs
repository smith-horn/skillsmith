/**
 * Verdict-shape constructors for `scripts/ruflo-host-guard.mjs` (SMI-6744
 * Wave 4). Split out of `ruflo-host-guard-predicates.mjs` (governance-round
 * split) purely to stay under the 500-line file-length gate
 * (`scripts/check-file-length.mjs`) once that file grew H-D/L-D's extra
 * path-normalization views and H1's `--require` clause — every export here
 * is a pure function or constant, no I/O, no state, and both
 * `ruflo-host-guard-predicates.mjs` and `ruflo-host-guard-h1to7.mjs` import
 * from this file (never the reverse), so there is no import cycle between
 * the three.
 *
 * Design: docs/internal/implementation/smi-6744-ruflo-host-guard.md
 * § Predicate Specification "Denial shape".
 */

/** The literal alternative every denial reason names (design § 1(b)). */
export const SANCTIONED_ALTERNATIVE =
  'docker exec skillsmith-ruflo-1 node /opt/ruflo-seed/node_modules/@claude-flow/cli/bin/cli.js …'

/**
 * Build a deny verdict for a matched H-predicate (or the brace-syntax
 * check). Shape copied from `env-read-guard.mjs`'s `decide()` byte-for-byte
 * (plan § Predicate Specification "Denial shape").
 * @param {string} predicate e.g. 'H5', 'brace-syntax'
 * @param {string} token the offending argv element/token, named literally
 */
export function denyWith(predicate, token) {
  return {
    action: 'deny',
    json: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `[ruflo-host-guard] ${predicate}: this command invokes ruflo/@claude-flow/cli outside ` +
          `the sanctioned container (matched on \`${token}\`). Host-side ruflo/claude-flow ` +
          `execution is not permitted here — use \`${SANCTIONED_ALTERNATIVE}\` instead.`,
      },
    },
    stderr: null,
  }
}

/**
 * Deny for a runtime/evaluator failure — this guard's failure posture is
 * fail-CLOSED (deliberately the opposite of env-read-guard.mjs's fail-open;
 * plan § "Failure posture — where this guard must differ from its
 * precedent, and why").
 * @param {string} message
 */
export function denyInternalError(message) {
  return {
    action: 'deny',
    json: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `[ruflo-host-guard] internal error: ${message}. Denying by design (fail-closed, no ` +
          `disable variable) — use \`${SANCTIONED_ALTERNATIVE}\` for ruflo access.`,
      },
    },
    stderr: null,
  }
}

/**
 * Deny for a malformed/unparseable PreToolUse payload (round 1 finding 4 —
 * this guard denies on input failure instead of copying the precedent's
 * fail-open wrapper).
 * @param {string} reason
 */
export function denyMalformedInput(reason) {
  return {
    action: 'deny',
    json: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `[ruflo-host-guard] malformed PreToolUse input: ${reason}. Denying by design ` +
          `(fail-closed on unparseable/malformed hook input, round 1 finding 4).`,
      },
    },
    stderr: null,
  }
}

/**
 * Deny for the `mcp__ruflo__hooks_session-start` `startDaemon` gate
 * (design § "SMI-6854").
 * @param {unknown} value the offending startDaemon value
 */
export function denyStartDaemon(value) {
  return {
    action: 'deny',
    json: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `[ruflo-host-guard] mcp__ruflo__hooks_session-start: startDaemon=${JSON.stringify(value)} ` +
          'is not permitted — only an absent field or startDaemon===false is allowed (SMI-6854).',
      },
    },
    stderr: null,
  }
}

export const ALLOW = { action: 'allow', json: null, stderr: null }
