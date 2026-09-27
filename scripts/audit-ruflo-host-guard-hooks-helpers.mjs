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
 * Does one hooks.PreToolUse entry match the given matcher and carry a
 * command-type hook whose `command` string contains both substrings? Type
 * + exact invocation-shape check, not a bare whole-file substring match --
 * same structural pattern as `env-read-guard.test.ts`'s own registration
 * pin -- so a hook silently replaced by a functionally inert command that
 * merely retains the text (e.g. in a comment) still fails this.
 */
function hasHookEntry(preToolUse, matcher, mustIncludeAll) {
  return preToolUse.some(
    (entry) =>
      entry?.matcher === matcher &&
      Array.isArray(entry.hooks) &&
      entry.hooks.some(
        (hook) =>
          hook?.type === 'command' &&
          typeof hook.command === 'string' &&
          mustIncludeAll.every((s) => hook.command.includes(s))
      )
  )
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
  const mustInclude = ['node', 'scripts/ruflo-host-guard.mjs']

  return {
    status: 'evaluated',
    settingsPath,
    hasBashEntry: hasHookEntry(preToolUse, 'Bash', mustInclude),
    hasSessionStartEntry: hasHookEntry(
      preToolUse,
      '^mcp__ruflo__hooks_session-start$',
      mustInclude
    ),
  }
}

const FIX_MISSING_HOOK_ENTRY = (matcher) =>
  `Add a { "type": "command", "timeout": 5, "command": "node \\"$CLAUDE_PROJECT_DIR/scripts/ruflo-host-guard.mjs\\"" } ` +
  `hook to the "${matcher}" entry in .claude/settings.json's hooks.PreToolUse array (SMI-6744 Wave 4, ` +
  'design doc § "What Changes" item 3).'

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
  if (!verdict.hasBashEntry) {
    lines.push({
      severity: 'fail',
      message:
        `Check 74 FINDING: ${verdict.settingsPath} hooks.PreToolUse is missing the "Bash" ` +
        `matcher entry invoking scripts/ruflo-host-guard.mjs. ${HOOK_DETECTION_NOT_PREVENTION_NOTE}`,
      fix: FIX_MISSING_HOOK_ENTRY('Bash'),
    })
  }
  if (!verdict.hasSessionStartEntry) {
    lines.push({
      severity: 'fail',
      message:
        `Check 74 FINDING: ${verdict.settingsPath} hooks.PreToolUse is missing the ` +
        '"^mcp__ruflo__hooks_session-start$" matcher entry invoking scripts/ruflo-host-guard.mjs. ' +
        HOOK_DETECTION_NOT_PREVENTION_NOTE,
      fix: FIX_MISSING_HOOK_ENTRY('^mcp__ruflo__hooks_session-start$'),
    })
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
