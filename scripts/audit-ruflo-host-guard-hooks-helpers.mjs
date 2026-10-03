#!/usr/bin/env node
/**
 * Helper for audit-standards.mjs Check 74's hook-entry tripwire (SMI-6744
 * Wave 4 / A4.6) and its executable twin,
 * scripts/tests/audit-ruflo-host-paths.test.ts.
 *
 * Split out of audit-ruflo-host-paths-helpers.mjs (SMI-6744 Wave 4 M-6
 * governance round) to keep that file under the 500-line policy
 * (scripts/file-length-policy.mjs) once its own Bash-deny/tree arm grew a
 * second tree assertion and a `.bin` symlink judge -- this tripwire is a
 * fully independent hooks.PreToolUse-registration check that never touches
 * `permissions.deny` or a filesystem tree, so it splits cleanly.
 *
 * Design: docs/internal/implementation/smi-6744-ruflo-host-guard.md
 * § "What Changes" item 4.
 *
 * Asserts `scripts/ruflo-host-guard.mjs` is registered on BOTH its
 * `PreToolUse` matchers -- the `Bash` matcher (alongside `env-read-guard.mjs`)
 * and the `^mcp__ruflo__hooks_session-start$` matcher. This is detection of
 * a silent removal, never prevention of one: a session with Edit access can
 * still remove the hook entry.
 */

import { readFileSync } from 'node:fs'

/** Check 74's hook-entry tripwire out-of-reach note (SMI-6744 A4.6). */
const HOOK_DETECTION_NOT_PREVENTION_NOTE =
  'Detection, never prevention (design doc § 8 item 13): a session with Edit access can still ' +
  'remove this hook entry -- this check only means the removal is caught, not that it is blocked.'

const FIX_NOT_EVALUATED = (path) =>
  `Could not read/parse ${path} as JSON, so Check 74 could not evaluate. Confirm the file exists and is valid JSON.`

/**
 * The exact registered hook command string (M-E fix) -- the single source
 * of truth both `evaluateRufloHostGuardHooks` below and its test's own
 * `RUFLO_GUARD_COMMAND` literal must agree with, matching the real entries
 * in `.claude/settings.json`.
 */
export const EXPECTED_GUARD_COMMAND = 'node "$CLAUDE_PROJECT_DIR/scripts/ruflo-host-guard.mjs"'

/**
 * Inspects one hooks.PreToolUse `matcher` entry against `expectedCommand`,
 * distinguishing TWO different failure shapes (M-4 fix, SMI-6744 Wave 4
 * governance round) that the prior boolean-only `hasHookEntry` collapsed
 * into one: "no entry for this matcher at all" (`present: false`) versus
 * "an entry exists whose command-type hook(s) are not the expected
 * literal" (`present: true, matches: false, foundCommand` naming what WAS
 * there instead) -- a reader fixing this by hand needs to know which one
 * it is, since the first needs a NEW hook added and the second needs an
 * EXISTING one corrected.
 *
 * Command matching is EXACT equality on the trimmed `command` string, not
 * substring containment (M-E fix, SMI-6744 Wave 4 governance round) -- a
 * prior version checked `hook.command.includes(s)` for each of two
 * required substrings (`'node'` and `'scripts/ruflo-host-guard.mjs'`),
 * which a comment or an `echo`/`true ||` wrapper carrying that same text
 * still satisfies: `# node "$CLAUDE_PROJECT_DIR/scripts/ruflo-host-guard.mjs"`
 * contains both substrings while invoking nothing.
 * @param {unknown[]} preToolUse
 * @param {string} matcher
 * @param {string} expectedCommand
 * @returns {{present: boolean, matches: boolean, foundCommand: string | null}}
 */
function inspectHookEntry(preToolUse, matcher, expectedCommand) {
  const entry = preToolUse.find((e) => e?.matcher === matcher)
  if (!entry || !Array.isArray(entry.hooks)) {
    return { present: Boolean(entry), matches: false, foundCommand: null }
  }
  const commandHooks = entry.hooks.filter(
    (hook) => hook?.type === 'command' && typeof hook.command === 'string'
  )
  const matched = commandHooks.find((hook) => hook.command.trim() === expectedCommand)
  if (matched) return { present: true, matches: true, foundCommand: null }
  return { present: true, matches: false, foundCommand: commandHooks[0]?.command.trim() ?? null }
}

/**
 * Check 74's hook-entry tripwire (SMI-6744 A4.6, plan
 * docs/internal/implementation/smi-6744-ruflo-host-guard.md § "What
 * Changes" item 4): asserts `scripts/ruflo-host-guard.mjs` is registered
 * on BOTH its `PreToolUse` matchers -- the `Bash` matcher (alongside
 * `env-read-guard.mjs`) and the `^mcp__ruflo__hooks_session-start$`
 * matcher. Purely additive to Check 74's existing deny-array + host-tree
 * assertions; this is detection of a silent removal, never prevention of one.
 * @param {{settingsPath: string, readFile?: (path: string) => string}} options
 */
export function evaluateRufloHostGuardHooks(options) {
  const { settingsPath, readFile = (p) => readFileSync(p, 'utf8') } = options

  let parsed
  try {
    parsed = JSON.parse(readFile(settingsPath))
  } catch (err) {
    return {
      status: 'not_evaluated',
      settingsPath,
      reason: err instanceof Error ? err.message : String(err),
    }
  }

  const preToolUse = Array.isArray(parsed?.hooks?.PreToolUse) ? parsed.hooks.PreToolUse : []
  const bash = inspectHookEntry(preToolUse, 'Bash', EXPECTED_GUARD_COMMAND)
  const sessionStart = inspectHookEntry(
    preToolUse,
    '^mcp__ruflo__hooks_session-start$',
    EXPECTED_GUARD_COMMAND
  )

  return {
    status: 'evaluated',
    settingsPath,
    // Kept as plain booleans for every existing caller/test (backward
    // compatible with the pre-M-4 shape); `bash`/`sessionStart` carry the
    // new found-vs-expected detail `rufloHostGuardHooksReportLines` needs.
    hasBashEntry: bash.matches,
    hasSessionStartEntry: sessionStart.matches,
    bash,
    sessionStart,
  }
}

/** M-4 fix: derived from `EXPECTED_GUARD_COMMAND` via `JSON.stringify` (a
 * hand-maintained escaped copy of the same literal is exactly the kind of
 * two-copies-that-can-drift shape this repo's own CLAUDE.md warns
 * against) rather than a separately hand-escaped string. */
const EXPECTED_GUARD_COMMAND_JSON = JSON.stringify(EXPECTED_GUARD_COMMAND)

const FIX_MISSING_HOOK_ENTRY = (matcher) =>
  `Add a { "type": "command", "timeout": 5, "command": ${EXPECTED_GUARD_COMMAND_JSON} } ` +
  `hook to the "${matcher}" entry in .claude/settings.json's hooks.PreToolUse array (SMI-6744 Wave 4, ` +
  'design doc § "What Changes" item 3).'

/** M-4 fix: the SECOND fix shape -- an entry exists but its command-type
 * hook(s) don't equal the expected literal -- distinct from
 * FIX_MISSING_HOOK_ENTRY above (which adds a new hook; this one corrects
 * an existing one), naming what was actually FOUND so a reader isn't
 * left guessing why their apparently-present hook still fails. */
const FIX_WRONG_HOOK_COMMAND = (matcher, foundCommand) =>
  `Update the "${matcher}" entry's command-type hook in .claude/settings.json's hooks.PreToolUse array ` +
  `to exactly ${EXPECTED_GUARD_COMMAND_JSON} (found: ${
    foundCommand === null ? 'no command-type hook present' : JSON.stringify(foundCommand)
  }).`

/**
 * @param {ReturnType<typeof evaluateRufloHostGuardHooks>} verdict
 * @returns {Array<{severity: 'pass' | 'warn' | 'fail', message: string, fix?: string}>}
 */
export function rufloHostGuardHooksReportLines(verdict) {
  if (verdict.status === 'not_evaluated') {
    return [
      {
        severity: 'fail',
        message: `Check 74 NOT-EVALUATED (hook-entry tripwire) — ${verdict.reason}`,
        fix: FIX_NOT_EVALUATED(verdict.settingsPath),
      },
    ]
  }

  const lines = []
  for (const [matcher, detail] of [
    ['Bash', verdict.bash],
    ['^mcp__ruflo__hooks_session-start$', verdict.sessionStart],
  ]) {
    if (detail.matches) continue
    if (!detail.present) {
      lines.push({
        severity: 'fail',
        message:
          `Check 74 FINDING: ${verdict.settingsPath} hooks.PreToolUse is missing the "${matcher}" ` +
          `matcher entry invoking scripts/ruflo-host-guard.mjs. ${HOOK_DETECTION_NOT_PREVENTION_NOTE}`,
        fix: FIX_MISSING_HOOK_ENTRY(matcher),
      })
    } else {
      const foundDescription =
        detail.foundCommand === null
          ? 'no command-type hook present'
          : JSON.stringify(detail.foundCommand)
      lines.push({
        severity: 'fail',
        message:
          `Check 74 FINDING: ${verdict.settingsPath} hooks.PreToolUse has a "${matcher}" matcher ` +
          `entry, but its command does not equal the expected literal ${EXPECTED_GUARD_COMMAND_JSON} ` +
          `(found: ${foundDescription}). ${HOOK_DETECTION_NOT_PREVENTION_NOTE}`,
        fix: FIX_WRONG_HOOK_COMMAND(matcher, detail.foundCommand),
      })
    }
  }
  if (lines.length === 0) {
    lines.push({
      severity: 'pass',
      message:
        `Check 74: both scripts/ruflo-host-guard.mjs PreToolUse hook entries (matchers "Bash" ` +
        `and "^mcp__ruflo__hooks_session-start$") are present in ${verdict.settingsPath}. ` +
        HOOK_DETECTION_NOT_PREVENTION_NOTE,
    })
  }
  return lines
}
