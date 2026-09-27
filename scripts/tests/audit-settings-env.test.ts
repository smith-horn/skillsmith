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

const GREEN_SETTINGS = `{
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

describe('EXPECTED_SETTINGS_ENV (SMI-6744 Checkpoint 4 row 4)', () => {
  it('is pinned empty today', () => {
    expect(EXPECTED_SETTINGS_ENV).toEqual({})
  })
})

describe('evaluateSettingsEnv', () => {
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
