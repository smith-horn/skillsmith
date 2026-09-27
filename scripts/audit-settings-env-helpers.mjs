#!/usr/bin/env node
/**
 * Helper for audit-standards.mjs Check 73 (SMI-6744 Wave 4 / A4.3) and its
 * executable twin, scripts/tests/audit-settings-env.test.ts.
 *
 * Checkpoint 4 row 4 (docs/internal/uat/smi-6744/a44-structural-design-2026-09-27.md
 * § 6): A4.1 measured that no censused Ruflo build's `init` writes
 * CLAUDE_FLOW_AUTO_COMMIT / CLAUDE_FLOW_AUTO_PUSH / CLAUDE_FLOW_REMOTE_EXECUTION,
 * so a three-named-absence check (the plan's original spec) would be green on
 * the very re-add it exists to catch: the live re-add writers write a
 * DIFFERENT set of keys (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS,
 * CLAUDE_FLOW_V3_ENABLED, CLAUDE_FLOW_HOOKS_ENABLED, and `ruvector init`'s
 * fourteen RUVECTOR_* keys). Checkpoint 4 chose to pin the exact expected
 * `env` block instead (today: empty).
 *
 * A second, independent reason (design doc § 1(b) Layer H's disable-variable
 * analysis): pinning the exact set is also what stops a smuggled
 * `SKILLSMITH_RUFLO_HOST_GUARD_DISABLE` (or any other hook-disable variable)
 * from being added to the `env` block -- a leading shell assignment does not
 * reach the PreToolUse hook process, so the `env` block is the one route
 * that would actually work, and an exact pin closes it by construction
 * rather than by naming the variable.
 *
 * `readFile` is injected (Check 70's `dockerEnvCoherenceReportLines`
 * pattern, scripts/audit-docker-env-coherence-helpers.mjs) so the twin test
 * drives every branch from literal JSON text, never from a real file on
 * disk or from EXPECTED_SETTINGS_ENV itself.
 */

import { readFileSync } from 'node:fs'

/** Checkpoint 4 row 4: the pinned expected `.claude/settings.json` `env` block. Empty today. */
export const EXPECTED_SETTINGS_ENV = Object.freeze({})

const FIX_MISSING_ENV_KEY =
  "settings.json's `env` block must be exactly the pinned set (SMI-6744 Checkpoint 4 row 4). " +
  'Add the missing key(s) with their pinned value(s), or update EXPECTED_SETTINGS_ENV in ' +
  'scripts/audit-settings-env-helpers.mjs if the pinned set itself changed by explicit decision.'

const FIX_UNEXPECTED_ENV_KEY =
  "settings.json's `env` block must be EXACTLY the pinned set -- no more, no fewer keys " +
  '(SMI-6744 Checkpoint 4 row 4). Remove the unexpected key, or update EXPECTED_SETTINGS_ENV ' +
  'if the pinned set itself changed by explicit decision. This also closes the smuggled-hook-' +
  'disable-variable route: a variable such as SKILLSMITH_RUFLO_HOST_GUARD_DISABLE placed in ' +
  '`env` surfaces here as an unexpected key.'

const FIX_MISSING_ENV_BLOCK =
  'settings.json is missing its top-level `env` key entirely. Absence is not pinned -- add ' +
  '`"env": {}` (or the pinned set) explicitly.'

const fixNotEvaluated = (path) =>
  `Could not read or parse ${path} as JSON, so its \`env\` block could not be checked. ` +
  'Confirm the file exists and is valid JSON.'

/**
 * Evaluate settingsPath's `env` block against `expected` (default
 * EXPECTED_SETTINGS_ENV). Never throws -- an unreadable or unparseable file
 * is its own `not_evaluated` outcome, matching Check 70/72's three-way-verdict
 * convention (a check that self-skips to pass is the failure mode CLAUDE.md
 * names for Checks 69/70).
 *
 * @param {{
 *   settingsPath: string,
 *   readFile?: (path: string) => string,
 *   expected?: Record<string, string>,
 * }} options
 * @returns {{
 *   status: 'evaluated',
 *   settingsPath: string,
 *   envPresent: boolean,
 *   missingKeys: string[],
 *   unexpectedKeys: string[],
 *   expectedKeys: string[],
 *   actualKeys?: string[],
 * } | {
 *   status: 'not_evaluated',
 *   settingsPath: string,
 *   reason: string,
 * }}
 */
export function evaluateSettingsEnv(options) {
  const {
    settingsPath,
    readFile = (p) => readFileSync(p, 'utf8'),
    expected = EXPECTED_SETTINGS_ENV,
  } = options

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

  const expectedKeys = Object.keys(expected)

  // Absence is not pinned: a file with no `env` key at all is a distinct
  // failure from an `env` block that merely disagrees on contents, and the
  // design doc is explicit that both must fail rather than one being read
  // as vacuously compliant.
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !Object.prototype.hasOwnProperty.call(parsed, 'env')
  ) {
    return {
      status: 'evaluated',
      settingsPath,
      envPresent: false,
      missingKeys: expectedKeys.slice(),
      unexpectedKeys: [],
      expectedKeys,
    }
  }

  const env = parsed.env && typeof parsed.env === 'object' ? parsed.env : {}
  const actualKeys = Object.keys(env)
  const missingKeys = expectedKeys.filter((k) => !(k in env))
  const unexpectedKeys = actualKeys.filter((k) => !(k in expected))

  return {
    status: 'evaluated',
    settingsPath,
    envPresent: true,
    missingKeys,
    unexpectedKeys,
    expectedKeys,
    actualKeys,
  }
}

/**
 * Turn an evaluateSettingsEnv() verdict into report lines (Check 72's
 * report-lines shape: {severity, message, fix?}).
 *
 * @param {ReturnType<typeof evaluateSettingsEnv>} verdict
 * @returns {Array<{severity: 'pass' | 'warn' | 'fail', message: string, fix?: string}>}
 */
export function settingsEnvReportLines(verdict) {
  if (verdict.status === 'not_evaluated') {
    return [
      {
        severity: 'fail',
        message:
          `Check 73 NOT-EVALUATED — could not read/parse ${verdict.settingsPath} as JSON, ` +
          `so its \`env\` block was not compared: ${verdict.reason}`,
        fix: fixNotEvaluated(verdict.settingsPath),
      },
    ]
  }

  const pinnedDescr = `{${verdict.expectedKeys.join(', ') || '(empty)'}}`

  if (!verdict.envPresent) {
    return [
      {
        severity: 'fail',
        message:
          `Check 73: ${verdict.settingsPath} has no top-level \`env\` key — absence is not ` +
          `pinned; expected exactly ${pinnedDescr}`,
        fix: FIX_MISSING_ENV_BLOCK,
      },
    ]
  }

  const lines = []
  for (const key of verdict.missingKeys) {
    lines.push({
      severity: 'fail',
      message: `Check 73: ${verdict.settingsPath} \`env\` is missing pinned key "${key}"`,
      fix: FIX_MISSING_ENV_KEY,
    })
  }
  for (const key of verdict.unexpectedKeys) {
    lines.push({
      severity: 'fail',
      message:
        `Check 73: ${verdict.settingsPath} \`env\` has unexpected key "${key}" ` +
        `(not in the pinned set ${pinnedDescr})`,
      fix: FIX_UNEXPECTED_ENV_KEY,
    })
  }

  if (lines.length === 0) {
    lines.push({
      severity: 'pass',
      message:
        `Check 73: ${verdict.settingsPath} \`env\` is exactly the pinned set ${pinnedDescr} ` +
        `(${verdict.expectedKeys.length} key(s))`,
    })
  }

  return lines
}
