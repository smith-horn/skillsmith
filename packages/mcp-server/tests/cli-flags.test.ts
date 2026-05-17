/**
 * SMI-4805: startup CLI-flag handling for `@skillsmith/mcp-server`.
 *
 * `resolveStartupFlag` is unit-tested directly (rather than via `execFileSync`
 * against the built binary) because importing `index.ts` executes its `main()`
 * on load — a pure-function test is both faster and free of a `dist` build
 * dependency, while covering the same logic.
 */
import { describe, it, expect } from 'vitest'
import { resolveStartupFlag } from '../src/cli-flags.js'

describe('SMI-4805: resolveStartupFlag', () => {
  it('returns the given version for --version and -v', () => {
    expect(resolveStartupFlag(['--version'], '1.2.3')).toBe('1.2.3')
    expect(resolveStartupFlag(['-v'], '1.2.3')).toBe('1.2.3')
  })

  it('returns help text mentioning the server and its flags for --help and -h', () => {
    for (const flag of ['--help', '-h']) {
      const out = resolveStartupFlag([flag], '1.2.3')
      expect(out).toContain('Skillsmith MCP server')
      expect(out).toContain('--version')
      expect(out).toContain('--help')
    }
  })

  it('returns null when no recognized startup flag is present', () => {
    expect(resolveStartupFlag([], '1.2.3')).toBeNull()
    expect(resolveStartupFlag(['--docs'], '1.2.3')).toBeNull()
    expect(resolveStartupFlag(['search', 'foo'], '1.2.3')).toBeNull()
  })

  it('prefers --version when both --version and --help are passed', () => {
    expect(resolveStartupFlag(['--help', '--version'], '9.9.9')).toBe('9.9.9')
  })
})
