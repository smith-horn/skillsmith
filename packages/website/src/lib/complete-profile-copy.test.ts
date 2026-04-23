/**
 * complete-profile-copy.test.ts
 *
 * SMI-4401 Wave 2 — unit coverage for the pure-TS helpers in complete-profile-copy.ts.
 * Governance retro finding: validateName and resolveSubhead had no unit tests.
 */

import { describe, expect, it } from 'vitest'
import { validateName, resolveSubhead, humanizePath } from './complete-profile-copy'

describe('validateName — passing cases', () => {
  it('accepts a minimum-length name (2 chars)', () => {
    expect(validateName('Jo')).toBeNull()
  })

  it('accepts a typical name', () => {
    expect(validateName('Ryan')).toBeNull()
  })

  it('accepts a name at the max length (64 chars)', () => {
    expect(validateName('a'.repeat(63) + 'b')).toBeNull()
  })

  it('accepts a hyphenated name', () => {
    expect(validateName('Smith-Jones')).toBeNull()
  })

  it('accepts a name with accented characters containing a letter', () => {
    expect(validateName('José')).toBeNull()
  })

  it('accepts a name with leading/trailing whitespace (trimmed internally)', () => {
    // The validator trims before checking — "  Jo  " becomes "Jo" which is ≥2 chars.
    expect(validateName('  Jo  ')).toBeNull()
  })
})

describe('validateName — rejection cases', () => {
  it('rejects an empty string', () => {
    expect(validateName('')).not.toBeNull()
  })

  it('rejects a whitespace-only string', () => {
    expect(validateName('   ')).not.toBeNull()
  })

  it('rejects a single character', () => {
    expect(validateName('A')).not.toBeNull()
  })

  it('rejects a name exceeding 64 chars', () => {
    expect(validateName('a'.repeat(65))).not.toBeNull()
  })

  it('rejects a string with no letters (digits only)', () => {
    expect(validateName('12')).not.toBeNull()
  })

  it('rejects a string with no letters (special chars only)', () => {
    expect(validateName('--')).not.toBeNull()
  })
})

describe('humanizePath — known paths', () => {
  it('maps /account/cli-token → "your CLI token"', () => {
    expect(humanizePath('/account/cli-token')).toBe('your CLI token')
  })

  it('maps /account → "your dashboard"', () => {
    expect(humanizePath('/account')).toBe('your dashboard')
  })

  it('maps /skills → "the skills catalog"', () => {
    expect(humanizePath('/skills')).toBe('the skills catalog')
  })

  it('maps /return-to-cli → "your terminal"', () => {
    expect(humanizePath('/return-to-cli')).toBe('your terminal')
  })

  it('strips query string before mapping', () => {
    expect(humanizePath('/account/cli-token?foo=bar')).toBe('your CLI token')
  })

  it('strips hash fragment before mapping', () => {
    expect(humanizePath('/skills#anchor')).toBe('the skills catalog')
  })

  it('returns a clean label for unknown paths (strips leading slash)', () => {
    expect(humanizePath('/some/other/path')).toBe('some/other/path')
  })

  it('returns "the next step" for bare "/" path', () => {
    // bare "/" after stripping the slash yields empty string → fallback
    expect(humanizePath('/')).toBe('the next step')
  })
})

describe('resolveSubhead — precedence matrix (spec §5.1 H6)', () => {
  const cli = { source: 'cli', next: '' }
  const withNext = { source: '', next: '/skills' }
  const noParams = { source: '', next: '' }

  it('branch 1: source=cli → plain text terminal copy', () => {
    const result = resolveSubhead(cli, '/return-to-cli')
    expect(result.text).toBe('Almost there — re-run your terminal command after this.')
    expect(result.html).toBeUndefined()
  })

  it('branch 2: bare next → html with humanized path', () => {
    const result = resolveSubhead(withNext, '/skills')
    expect(result.html).toContain('the skills catalog')
    expect(result.text).toBeUndefined()
  })

  it('branch 3: no params → html with privacy link', () => {
    const result = resolveSubhead(noParams, '/account/cli-token')
    expect(result.html).toContain('/privacy')
    expect(result.text).toBeUndefined()
  })

  it('source=cli overrides a present next= value', () => {
    const both = { source: 'cli', next: '/skills' }
    const result = resolveSubhead(both, '/skills')
    // CLI wins — must be the plain-text terminal copy, not the skills-catalog html
    expect(result.text).toBe('Almost there — re-run your terminal command after this.')
  })
})
