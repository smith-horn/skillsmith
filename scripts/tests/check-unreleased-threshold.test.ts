import { describe, expect, it, afterEach, vi } from 'vitest'
import { countUnreleasedEntries, resolveThreshold } from '../check-unreleased-threshold.mjs'

describe('countUnreleasedEntries', () => {
  it('returns null when no [Unreleased] header exists', () => {
    const content = '# Changelog\n\n## v0.1.0\n\n- Released item\n'
    expect(countUnreleasedEntries(content)).toBeNull()
  })

  it('returns 0 for empty [Unreleased] section', () => {
    const content = '# Changelog\n\n## [Unreleased]\n\n## v0.1.0\n\n- old\n'
    expect(countUnreleasedEntries(content)).toBe(0)
  })

  it('counts top-level bullets', () => {
    const content = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '- First entry',
      '- Second entry',
      '- Third entry',
      '',
      '## v0.1.0',
      '',
      '- Released — should not count',
    ].join('\n')
    expect(countUnreleasedEntries(content)).toBe(3)
  })

  it('counts across ### subsections', () => {
    const content = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '### Added',
      '',
      '- A1',
      '- A2',
      '',
      '### Fixed',
      '',
      '- F1',
      '',
      '### Security',
      '',
      '- S1',
      '- S2',
    ].join('\n')
    expect(countUnreleasedEntries(content)).toBe(5)
  })

  it('does not count nested (indented) list items', () => {
    const content = [
      '## [Unreleased]',
      '',
      '- Top level one',
      '  - nested — should not count',
      '  - nested 2',
      '- Top level two',
    ].join('\n')
    expect(countUnreleasedEntries(content)).toBe(2)
  })

  it('accepts * bullets as well as -', () => {
    const content = '## [Unreleased]\n\n* first\n* second\n- third\n'
    expect(countUnreleasedEntries(content)).toBe(3)
  })

  it('stops at the next ## version header', () => {
    const content = [
      '## [Unreleased]',
      '- pending one',
      '## v0.5.0',
      '- released one',
      '- released two',
    ].join('\n')
    expect(countUnreleasedEntries(content)).toBe(1)
  })

  it('does not stop at ### subsections (only ##)', () => {
    const content = ['## [Unreleased]', '### Added', '- a', '### Fixed', '- f'].join('\n')
    expect(countUnreleasedEntries(content)).toBe(2)
  })

  it('accepts both [Unreleased] and Unreleased headers', () => {
    expect(countUnreleasedEntries('## [Unreleased]\n- x\n')).toBe(1)
    expect(countUnreleasedEntries('## Unreleased\n- x\n')).toBe(1)
  })
})

describe('resolveThreshold', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('defaults to 15 when env unset', () => {
    vi.stubEnv('UNRELEASED_THRESHOLD', '')
    expect(resolveThreshold()).toBe(15)
  })

  it('reads integer from env', () => {
    vi.stubEnv('UNRELEASED_THRESHOLD', '25')
    expect(resolveThreshold()).toBe(25)
  })

  it('falls back to default on non-numeric env', () => {
    vi.stubEnv('UNRELEASED_THRESHOLD', 'abc')
    expect(resolveThreshold()).toBe(15)
  })

  it('falls back to default on non-positive env', () => {
    vi.stubEnv('UNRELEASED_THRESHOLD', '0')
    expect(resolveThreshold()).toBe(15)
    vi.stubEnv('UNRELEASED_THRESHOLD', '-5')
    expect(resolveThreshold()).toBe(15)
  })
})
