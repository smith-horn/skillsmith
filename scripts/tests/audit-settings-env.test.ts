/**
 * SMI-6744 Wave 4 (A4.3): executable twin of `audit:standards` Check 73 --
 * asserts `.claude/settings.json`'s `env` block is EXACTLY the pinned set
 * (EXPECTED_SETTINGS_ENV, empty today), not merely free of three named keys.
 *
 * Checkpoint 4 row 4 (docs/internal/uat/smi-6744/a44-structural-design-2026-09-27.md
 * § 6): A4.1 measured that no censused Ruflo build's `init` writes
 * CLAUDE_FLOW_AUTO_COMMIT / CLAUDE_FLOW_AUTO_PUSH / CLAUDE_FLOW_REMOTE_EXECUTION
 * -- the live re-add writers write a DIFFERENT set of keys entirely
 * (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, CLAUDE_FLOW_V3_ENABLED,
 * CLAUDE_FLOW_HOOKS_ENABLED, fourteen RUVECTOR_* keys), so a three-named-
 * absence check would be vacuously green on the very re-add it exists to
 * catch. An exact pin also closes the smuggled-hook-disable-variable route:
 * SKILLSMITH_RUFLO_HOST_GUARD_DISABLE placed in `env` would surface as an
 * unexpected key.
 *
 * Fixtures below are harness-owned literal JSON text, never derived from
 * EXPECTED_SETTINGS_ENV or from evaluateSettingsEnv() -- a bug in the
 * helper's own idea of "the pinned set" must not also construct the fixture
 * meant to catch it.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error - .mjs helper has no typings
import {
  EXPECTED_SETTINGS_ENV,
  evaluateSettingsEnv,
  settingsEnvReportLines,
} from '../audit-settings-env-helpers.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')

// Harness-owned literal, never derived from EXPECTED_SETTINGS_ENV. Updated
// 2026-10-03 alongside the pin's one authorised entry: an empty env block was
// "exactly the pinned set" while the pin was empty, and is now a MISSING-key
// case, which RED_MISSING_PINNED_KEY below covers deliberately.
const GREEN_SETTINGS = `{
  "env": { "SKILLSMITH_RUFLO_VERDICT_SHADOW": "0" },
  "permissions": { "allow": [], "deny": [] }
}`

// The former GREEN fixture, kept as a RED one: with a non-empty pin, an empty
// env block is a real failure mode and worth an arm of its own. Without this,
// updating the pin would have silently deleted the only coverage of "the
// pinned key is absent".
const RED_MISSING_PINNED_KEY = `{
  "env": {},
  "permissions": { "allow": [], "deny": [] }
}`

const RED_HOOKS_ENABLED = `{
  "env": { "CLAUDE_FLOW_HOOKS_ENABLED": "true" },
  "permissions": { "allow": [], "deny": [] }
}`

const RED_HOST_GUARD_DISABLE = `{
  "env": { "SKILLSMITH_RUFLO_HOST_GUARD_DISABLE": "1" },
  "permissions": { "allow": [], "deny": [] }
}`

const RED_REMOVED_KEY = `{
  "env": { "CLAUDE_FLOW_AUTO_COMMIT": "false" },
  "permissions": { "allow": [], "deny": [] }
}`

const RED_NO_ENV_KEY = `{
  "permissions": { "allow": [], "deny": [] }
}`

// SMI-6744 Wave 4 M-7 governance finding: `env` present but not a plain
// object -- reproduced by the queen against the unfixed helper (all four
// silently coerced to `{}` and reported "exactly the pinned set").
const RED_ENV_NULL = `{
  "env": null,
  "permissions": { "allow": [], "deny": [] }
}`
const RED_ENV_STRING = `{
  "env": "X=1",
  "permissions": { "allow": [], "deny": [] }
}`
const RED_ENV_NUMBER = `{
  "env": 42,
  "permissions": { "allow": [], "deny": [] }
}`
const RED_ENV_BOOLEAN = `{
  "env": true,
  "permissions": { "allow": [], "deny": [] }
}`

describe('EXPECTED_SETTINGS_ENV (SMI-6744 Checkpoint 4 row 4)', () => {
  // Still a LITERAL, deliberately: this assertion exists so a bug in the
  // helper's own idea of the pinned set cannot also construct the expectation
  // meant to catch it. Updated 2026-10-03 from {} to one authorised entry by
  // explicit owner decision — the A5.5.2 bridge-verdict banner ships live, and
  // SKILLSMITH_RUFLO_VERDICT_SHADOW='0' in settings.json's env is what makes it
  // live. Pinning the VALUE too means flipping it to '1' to silence the banner
  // now fails here, so the guard covers the decision rather than yielding to it.
  it('is pinned to exactly the one authorised entry', () => {
    expect(EXPECTED_SETTINGS_ENV).toEqual({ SKILLSMITH_RUFLO_VERDICT_SHADOW: '0' })
  })
})

describe('evaluateSettingsEnv', () => {
  it('reports the pinned key as missing when the env block is empty', () => {
    const verdict = evaluateSettingsEnv({
      settingsPath: '.claude/settings.json',
      readFile: () => RED_MISSING_PINNED_KEY,
    })
    expect(verdict.status).toBe('evaluated')
    expect(verdict.envPresent).toBe(true)
    expect(verdict.missingKeys).toEqual(['SKILLSMITH_RUFLO_VERDICT_SHADOW'])
    expect(verdict.unexpectedKeys).toEqual([])
    const lines = settingsEnvReportLines(verdict)
    expect(lines[0].severity).not.toBe('pass')
  })

  it('passes a settings file whose env block is exactly the pinned set', () => {
    const verdict = evaluateSettingsEnv({
      settingsPath: '.claude/settings.json',
      readFile: () => GREEN_SETTINGS,
    })
    expect(verdict.status).toBe('evaluated')
    expect(verdict.envPresent).toBe(true)
    expect(verdict.missingKeys).toEqual([])
    expect(verdict.unexpectedKeys).toEqual([])
    const lines = settingsEnvReportLines(verdict)
    expect(lines).toHaveLength(1)
    expect(lines[0].severity).toBe('pass')
  })

  it('fails naming CLAUDE_FLOW_HOOKS_ENABLED when it is smuggled into env', () => {
    const verdict = evaluateSettingsEnv({
      settingsPath: '.claude/settings.json',
      readFile: () => RED_HOOKS_ENABLED,
    })
    expect(verdict.unexpectedKeys).toEqual(['CLAUDE_FLOW_HOOKS_ENABLED'])
    const lines = settingsEnvReportLines(verdict)
    expect(
      lines.some(
        (l: { severity: string; message: string }) =>
          l.severity === 'fail' && l.message.includes('CLAUDE_FLOW_HOOKS_ENABLED')
      )
    ).toBe(true)
  })

  it('fails naming SKILLSMITH_RUFLO_HOST_GUARD_DISABLE when it is smuggled into env', () => {
    const verdict = evaluateSettingsEnv({
      settingsPath: '.claude/settings.json',
      readFile: () => RED_HOST_GUARD_DISABLE,
    })
    expect(verdict.unexpectedKeys).toEqual(['SKILLSMITH_RUFLO_HOST_GUARD_DISABLE'])
    const lines = settingsEnvReportLines(verdict)
    expect(
      lines.some(
        (l: { severity: string; message: string }) =>
          l.severity === 'fail' && l.message.includes('SKILLSMITH_RUFLO_HOST_GUARD_DISABLE')
      )
    ).toBe(true)
  })

  it('fails naming a removed CLAUDE_FLOW_* key if it reappears', () => {
    const verdict = evaluateSettingsEnv({
      settingsPath: '.claude/settings.json',
      readFile: () => RED_REMOVED_KEY,
    })
    expect(verdict.unexpectedKeys).toEqual(['CLAUDE_FLOW_AUTO_COMMIT'])
    const lines = settingsEnvReportLines(verdict)
    expect(
      lines.some(
        (l: { severity: string; message: string }) =>
          l.severity === 'fail' && l.message.includes('CLAUDE_FLOW_AUTO_COMMIT')
      )
    ).toBe(true)
  })

  it('fails when the env key is absent entirely -- absence is not pinned', () => {
    const verdict = evaluateSettingsEnv({
      settingsPath: '.claude/settings.json',
      readFile: () => RED_NO_ENV_KEY,
    })
    expect(verdict.envPresent).toBe(false)
    const lines = settingsEnvReportLines(verdict)
    expect(lines).toHaveLength(1)
    expect(lines[0].severity).toBe('fail')
    expect(lines[0].message).toContain('no top-level `env` key')
  })

  it('returns a not_evaluated verdict instead of throwing on unreadable input', () => {
    const THROWS = () => {
      throw new Error("ENOENT: no such file or directory, open '.claude/settings.json'")
    }
    expect(() =>
      evaluateSettingsEnv({ settingsPath: '.claude/settings.json', readFile: THROWS })
    ).not.toThrow()
    const verdict = evaluateSettingsEnv({ settingsPath: '.claude/settings.json', readFile: THROWS })
    expect(verdict.status).toBe('not_evaluated')
    const lines = settingsEnvReportLines(verdict)
    expect(lines[0].severity).toBe('fail')
    expect(lines[0].message).toContain('NOT-EVALUATED')
  })

  it('emits a severity the audit has a reporter for, on every branch', () => {
    for (const src of [
      GREEN_SETTINGS,
      RED_HOOKS_ENABLED,
      RED_HOST_GUARD_DISABLE,
      RED_REMOVED_KEY,
      RED_NO_ENV_KEY,
      RED_ENV_NULL,
      RED_ENV_STRING,
      RED_ENV_NUMBER,
      RED_ENV_BOOLEAN,
    ]) {
      const lines = settingsEnvReportLines(
        evaluateSettingsEnv({ settingsPath: '.claude/settings.json', readFile: () => src })
      )
      expect(lines.length).toBeGreaterThan(0)
      for (const l of lines) {
        expect(['pass', 'warn', 'fail']).toContain(l.severity)
        expect(typeof l.message).toBe('string')
      }
    }
  })
})

// SMI-6744 Wave 4 M-7 governance finding: `env` present, key exists, but the
// VALUE is not a plain object at all. Watched failing against the unfixed
// helper before this fix landed: all four fixtures below produced
// `envPresent: true, missingKeys: [], unexpectedKeys: []` and a PASS line
// reading "exactly the pinned set {}" -- the non-object value was silently
// coerced to `{}` by `parsed.env && typeof parsed.env === 'object' ? ... : {}`
// (a bare object typeof check that a primitive/null fails, but which is
// never even reached for null since `null && ...` short-circuits false).
describe('Check 73 M-7: malformed env (not a plain object)', () => {
  const cases: Array<[string, string, string]> = [
    ['null', RED_ENV_NULL, 'null'],
    ['a string', RED_ENV_STRING, 'string'],
    ['a number', RED_ENV_NUMBER, 'number'],
    ['a boolean', RED_ENV_BOOLEAN, 'boolean'],
  ]

  it.each(cases)(
    'env: %s -> distinct envMalformed outcome naming the observed type',
    (_label, src, observedType) => {
      const verdict = evaluateSettingsEnv({
        settingsPath: '.claude/settings.json',
        readFile: () => src,
      })
      expect(verdict.status).toBe('evaluated')
      expect(verdict.envMalformed).toBe(true)
      expect(verdict.observedType).toBe(observedType)
      const lines = settingsEnvReportLines(verdict)
      expect(lines).toHaveLength(1)
      expect(lines[0].severity).toBe('fail')
      expect(lines[0].message).toContain(observedType)
      // The old behaviour this fix replaces: a pass line claiming compliance.
      expect(lines[0].message).not.toContain('is exactly the pinned set')
    }
  )
})

// SMI-6744 Wave 4 M-8 governance finding: a key present with the WRONG value
// passed this check before -- only key presence was ever compared. Watched
// failing against the unfixed helper: `missingKeys`/`unexpectedKeys` were
// both empty for a key present with a wrong value, so the check reported a
// pass despite the pinned value being smuggled to something else.
describe('Check 73 M-8: value mismatches', () => {
  it('fails naming the key, its wrong value, and the pinned value it should have', () => {
    const CUSTOM_EXPECTED = { CLAUDE_FLOW_HOOKS_ENABLED: 'false' }
    const src = `{
      "env": { "CLAUDE_FLOW_HOOKS_ENABLED": "true" },
      "permissions": { "allow": [], "deny": [] }
    }`
    const verdict = evaluateSettingsEnv({
      settingsPath: '.claude/settings.json',
      readFile: () => src,
      expected: CUSTOM_EXPECTED,
    })
    expect(verdict.missingKeys).toEqual([])
    expect(verdict.unexpectedKeys).toEqual([])
    expect(verdict.mismatchedValues).toEqual([
      { key: 'CLAUDE_FLOW_HOOKS_ENABLED', expected: 'false', actual: 'true' },
    ])
    const lines = settingsEnvReportLines(verdict)
    const failLine = lines.find((l: { severity: string; message: string }) => l.severity === 'fail')
    expect(failLine).toBeTruthy()
    expect(failLine?.message).toContain('CLAUDE_FLOW_HOOKS_ENABLED')
    expect(failLine?.message).toContain('"true"')
    expect(failLine?.message).toContain('"false"')
  })

  it('passes when the key is present with the exact pinned value', () => {
    const CUSTOM_EXPECTED = { CLAUDE_FLOW_HOOKS_ENABLED: 'false' }
    const src = `{
      "env": { "CLAUDE_FLOW_HOOKS_ENABLED": "false" },
      "permissions": { "allow": [], "deny": [] }
    }`
    const verdict = evaluateSettingsEnv({
      settingsPath: '.claude/settings.json',
      readFile: () => src,
      expected: CUSTOM_EXPECTED,
    })
    expect(verdict.mismatchedValues).toEqual([])
    const lines = settingsEnvReportLines(verdict)
    expect(lines).toHaveLength(1)
    expect(lines[0].severity).toBe('pass')
  })
})

describe('SMI-6744: the real .claude/settings.json in this repo', () => {
  it('has an env block matching the pinned set', () => {
    const verdict = evaluateSettingsEnv({
      settingsPath: join(REPO_ROOT, '.claude', 'settings.json'),
    })
    expect(verdict.status).toBe('evaluated')
    expect(verdict.missingKeys).toEqual([])
    expect(verdict.unexpectedKeys).toEqual([])
  })
})
