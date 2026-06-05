/**
 * SMI-5079: Tests for `parseNpmLsJson` helper.
 *
 * The helper backs `getResolvedVersions` in audit-standards.mjs Check 11. It
 * must robustly extract the npm-ls dependency tree from outputs that may
 * include non-JSON prelude (npm warnings) or arrive on stderr instead of
 * stdout depending on npm build/version.
 *
 * Pre-SMI-5079 the helper only tried plain `JSON.parse(stdout)` and dropped
 * to "could not inspect tree" warnings for 6 working scoped overrides under
 * the post-SMI-3984 peer-warning soup. These tests pin the new parse
 * strategy so regressions surface in CI.
 */
import { describe, expect, it } from 'vitest'

const helpers = (await import('../audit-standards-helpers.mjs')) as {
  parseNpmLsJson: (stdout: string | null | undefined, stderr?: string | null) => unknown
}
const { parseNpmLsJson } = helpers

describe('parseNpmLsJson (SMI-5079)', () => {
  const sampleTree = {
    version: '1.0.0',
    name: 'skillsmith',
    dependencies: {
      'smol-toml': { version: '1.6.1' },
    },
  }

  it('parses well-formed JSON on stdout', () => {
    const out = JSON.stringify(sampleTree)
    expect(parseNpmLsJson(out, '')).toEqual(sampleTree)
  })

  it('parses JSON when stdout has a non-JSON prelude (skips to first brace)', () => {
    const out = `npm warn invalid: yaml-language-server@1.18.0\n${JSON.stringify(sampleTree)}`
    expect(parseNpmLsJson(out, '')).toEqual(sampleTree)
  })

  it('parses JSON when only stderr contains the tree', () => {
    expect(parseNpmLsJson('', JSON.stringify(sampleTree))).toEqual(sampleTree)
  })

  it('prefers stdout over stderr when both parse', () => {
    const stdoutTree = { dependencies: { a: { version: '1.0.0' } } }
    const stderrTree = { dependencies: { b: { version: '2.0.0' } } }
    expect(parseNpmLsJson(JSON.stringify(stdoutTree), JSON.stringify(stderrTree))).toEqual(
      stdoutTree
    )
  })

  it('returns null when neither stream contains JSON', () => {
    expect(parseNpmLsJson('npm warn deprecated foo@1.0.0\n', 'npm error code 1\n')).toBeNull()
  })

  it('returns null on empty/missing inputs', () => {
    expect(parseNpmLsJson('', '')).toBeNull()
    expect(parseNpmLsJson(null, undefined)).toBeNull()
    expect(parseNpmLsJson(undefined as unknown as string, null)).toBeNull()
  })

  it('handles stderr-only path with prelude (npm warnings before JSON)', () => {
    const stderr = `npm warn config production Use \`--omit=dev\` instead.\n${JSON.stringify(sampleTree)}`
    expect(parseNpmLsJson('', stderr)).toEqual(sampleTree)
  })

  it('does not throw on partial JSON (returns null)', () => {
    expect(parseNpmLsJson('{"dependencies": {', '')).toBeNull()
  })
})
