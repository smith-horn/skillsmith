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

/**
 * Checkpoint 4 row 4: the pinned expected `.claude/settings.json` `env` block.
 *
 * Was empty. One authorised entry since 2026-10-03, by the explicit owner
 * decision this check's own FIX_UNEXPECTED_ENV_KEY text names as the sanctioned
 * route ("update EXPECTED_SETTINGS_ENV if the pinned set itself changed by
 * explicit decision").
 *
 * `SKILLSMITH_RUFLO_VERDICT_SHADOW: '0'` ships the A5.5.2 bridge-verdict banner
 * live rather than shadow-default. Wave 4's pin and A5.5.2's requirement are
 * two parts of SMI-6744 that genuinely conflicted: the pin exists to keep keys
 * OUT of this block, and the banner needs one IN it. The pin wins the argument
 * about process and the banner wins on the merits, so the key is listed here
 * where the decision is reviewable, rather than the check being relaxed.
 *
 * Listing it does not weaken this guard, it extends it. Because the check pins
 * VALUES as well as keys (see FIX_MISMATCHED_ENV_VALUE), the shadow variable is
 * now held at exactly '0' — so flipping it to '1' to silence the banner
 * surfaces here as a mismatched value, which is the same class of smuggling
 * the empty pin was built to catch.
 */
export const EXPECTED_SETTINGS_ENV = Object.freeze({
  SKILLSMITH_RUFLO_VERDICT_SHADOW: '0',
})

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

const FIX_MALFORMED_ENV =
  '`env` must be a plain JSON object (not null, an array, or a primitive). Replace it with ' +
  '`{}` (or the pinned set) -- SMI-6744 Wave 4 M-7 governance finding: a non-object `env` was ' +
  'silently coerced to `{}` and reported as compliant, which is the exact smuggled-value shape ' +
  'this check exists to catch.'

const FIX_MISMATCHED_ENV_VALUE =
  "settings.json's `env` block must match the pinned VALUE for each key, not just carry the " +
  'right key name (SMI-6744 Wave 4 M-8 governance finding). Set the key to its pinned value, ' +
  'or update EXPECTED_SETTINGS_ENV if the pinned value itself changed by explicit decision.'

const fixNotEvaluated = (path) =>
  `Could not read or parse ${path} as JSON, so its \`env\` block could not be checked. ` +
  'Confirm the file exists and is valid JSON.'

/** A plain JSON object -- not null, not an array, not a primitive. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Human-readable name for a JSON value's shape, for the malformed-env fail message. */
function describeObservedType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

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
 *   envMalformed: boolean,
 *   observedType?: string,
 *   missingKeys: string[],
 *   unexpectedKeys: string[],
 *   mismatchedValues: Array<{key: string, expected: unknown, actual: unknown}>,
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
      envMalformed: false,
      missingKeys: expectedKeys.slice(),
      unexpectedKeys: [],
      mismatchedValues: [],
      expectedKeys,
    }
  }

  // SMI-6744 Wave 4 M-7 governance finding: the key can exist while its
  // VALUE is not a plain object at all (null, an array, or a primitive) --
  // that must be its own distinct fail outcome, never silently coerced to
  // `{}` and reported as "exactly the pinned set".
  if (!isPlainObject(parsed.env)) {
    return {
      status: 'evaluated',
      settingsPath,
      envPresent: true,
      envMalformed: true,
      observedType: describeObservedType(parsed.env),
      missingKeys: [],
      unexpectedKeys: [],
      mismatchedValues: [],
      expectedKeys,
    }
  }

  const env = parsed.env
  const actualKeys = Object.keys(env)
  const missingKeys = expectedKeys.filter((k) => !(k in env))
  const unexpectedKeys = actualKeys.filter((k) => !(k in expected))
  // SMI-6744 Wave 4 M-8 governance finding: a key present with the WRONG
  // value passed this check before -- only key presence was ever compared,
  // never the pinned value itself, which the JSDoc and FIX_MISMATCHED_ENV_VALUE
  // text already promised.
  const mismatchedValues = expectedKeys
    .filter((k) => k in env && env[k] !== expected[k])
    .map((k) => ({ key: k, expected: expected[k], actual: env[k] }))

  return {
    status: 'evaluated',
    settingsPath,
    envPresent: true,
    envMalformed: false,
    missingKeys,
    unexpectedKeys,
    mismatchedValues,
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

  if (verdict.envMalformed) {
    return [
      {
        severity: 'fail',
        message:
          `Check 73: ${verdict.settingsPath} \`env\` is malformed — expected a plain JSON ` +
          `object, found ${verdict.observedType}; expected exactly ${pinnedDescr}`,
        fix: FIX_MALFORMED_ENV,
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
  for (const { key, expected, actual } of verdict.mismatchedValues || []) {
    lines.push({
      severity: 'fail',
      message:
        `Check 73: ${verdict.settingsPath} \`env\` key "${key}" has value ` +
        `${JSON.stringify(actual)}, expected pinned value ${JSON.stringify(expected)}`,
      fix: FIX_MISMATCHED_ENV_VALUE,
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
