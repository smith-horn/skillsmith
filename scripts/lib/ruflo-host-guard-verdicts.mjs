/**
 * Verdict-shape constructors for `scripts/ruflo-host-guard.mjs` (SMI-6744
 * Wave 4). Split out of `ruflo-host-guard-predicates.mjs` (governance-round
 * split) purely to stay under the 500-line-per-file convention this repo
 * keeps by hand for .mjs files under scripts/ (M3 correction: not enforced
 * by tooling here — `scripts/check-file-length.mjs` only runs via
 * `lint-staged` for `*.ts`/`*.sh`; SMI-5994) once that file grew H-D/L-D's
 * extra path-normalization views and H1's `--require` clause — every
 * export here is a pure function or constant, no I/O, no state, and both
 * `ruflo-host-guard-predicates.mjs` and `ruflo-host-guard-h1to7.mjs` import
 * from this file (never the reverse), so there is no import cycle between
 * the three.
 *
 * Design: docs/internal/implementation/smi-6744-ruflo-host-guard.md
 * § Predicate Specification "Denial shape".
 */

/**
 * The literal alternative every denial reason names (design § 1(b)). Not
 * exported: nothing outside this file reads it.
 */
const SANCTIONED_ALTERNATIVE =
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
    // The predicate as DATA, beside the prose. A consumer deciding on the
    // predicate must not read the reason: that string interpolates `token`,
    // and three H8-script sites pass the whole inline script as the token, so
    // a script padded with another predicate's label used to impersonate it
    // (SMI-6920 round 5, C2 -- measured defeating the trap reading).
    predicate,
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
 * Deny for a command the guard could not READ in full (SMI-6903 round 22
 * F2): a zsh glob alternation wider than `shell-command-segments.mjs`'s
 * expansion caps. Not an internal error (nothing threw) and not a matched
 * predicate (nothing matched); the guard refuses because it cannot say what
 * the shell would run, the posture ADR-172 sec 4 states for both guards.
 * @param {string} detail what could not be read, named for the reader
 */
export function denyUnreadableGlob(detail) {
  return {
    action: 'deny',
    json: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `[ruflo-host-guard] glob-cap: this command's zsh glob alternation is too wide to read ` +
          `(${detail}). Denying by design (fail-closed on what the guard cannot read) — spell ` +
          `the path out, or use \`${SANCTIONED_ALTERNATIVE}\` for ruflo access.`,
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
function denyStartDaemon(value) {
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

/**
 * L-4 fix (SMI-6744 Wave 4 governance round): H1/H2/H7 fire on a PATH
 * SUBSTRING match, which a legitimate reader/searcher can trip just as
 * easily as an actual invocation attempt — grep-ing for a `ruflo`/
 * `@claude-flow/cli` path reference in this guard's own test fixtures,
 * docs, or source tree contains the exact substrings those three
 * predicates test for. Appends a second sentence naming a READ-ONLY
 * alternative on top of `denyWith`'s own reason, so a developer who only
 * wanted to SEARCH or READ the matched text — not execute anything — has
 * an immediate way out instead of having to reverse-engineer one from the
 * guard's own denial.
 * @param {string} predicate 'H1', 'H2', or 'H7'
 * @param {string} token the offending argv element/token, named literally
 */
export function denyWithReadOnlyHint(predicate, token) {
  const base = denyWith(predicate, token)
  return {
    ...base,
    json: {
      hookSpecificOutput: {
        ...base.json.hookSpecificOutput,
        permissionDecisionReason:
          base.json.hookSpecificOutput.permissionDecisionReason +
          ' If you only meant to search or read this reference (not execute it), use ' +
          '`docker exec skillsmith-ruflo-1 grep …` or `git grep` instead.',
      },
    },
  }
}

export const ALLOW = { action: 'allow', json: null, stderr: null }

/**
 * `mcp__ruflo__hooks_session-start`'s `startDaemon` gate (SMI-6854, design
 * § "SMI-6854"). Allow only when `tool_input` is a plain object and
 * `startDaemon` is absent or strictly `false`; deny every other present
 * value. A missing/malformed `tool_input` follows the runtime fail-closed
 * rule (round 1 finding 5).
 *
 * Round-3 governance follow-up: moved here from the guard's own
 * orchestration file purely to stay under the 500-line-per-file convention
 * this repo keeps by hand for .mjs files under scripts/ (M3 correction:
 * not enforced by tooling here — `scripts/check-file-length.mjs` only runs
 * via `lint-staged` for `*.ts`/`*.sh`; SMI-5994) once the patch's own
 * docblock additions pushed that file to 501 lines —
 * every dependency this predicate needs (`ALLOW`, `denyMalformedInput`,
 * `denyStartDaemon`) is already defined in this same file, so the move
 * needed no new import anywhere.
 * @param {unknown} toolInput
 */
export function decideHooksSessionStart(toolInput) {
  if (toolInput === null || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
    return denyMalformedInput('mcp__ruflo__hooks_session-start requires an object tool_input')
  }
  if (!('startDaemon' in toolInput) || toolInput.startDaemon === false) return ALLOW
  return denyStartDaemon(toolInput.startDaemon)
}
