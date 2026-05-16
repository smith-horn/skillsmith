import { describe, expect, it } from 'vitest'

import { insertVersionSection } from '../lib/release-changelog.js'

/**
 * Replicates `audit:standards` check 43 (SMI-4776): `## [Unreleased]` MUST
 * appear before the first versioned `## v...` heading. Returns true when the
 * CHANGELOG body is conforming.
 */
function isCheck43Conforming(body: string): boolean {
  const headingRegex = /^## (.+)$/gm
  const headings: { isUnreleased: boolean; isVersion: boolean }[] = []
  let match: RegExpExecArray | null
  while ((match = headingRegex.exec(body)) !== null) {
    const text = match[1].trim()
    const isUnreleased = /^\[?Unreleased\]?$/i.test(text)
    const isVersion = /^\[?v?\d+\.\d+\.\d+\]?(\s|$)/.test(text)
    if (isUnreleased || isVersion) headings.push({ isUnreleased, isVersion })
  }
  const firstUnreleased = headings.findIndex((h) => h.isUnreleased)
  const firstVersion = headings.findIndex((h) => h.isVersion)
  if (firstUnreleased === -1 || firstVersion === -1) return true
  return firstUnreleased < firstVersion
}

const NEW_SECTION = '## v0.6.2\n\n- **Fix**: SMI-4920 release tooling'

describe('insertVersionSection', () => {
  it('leading [Unreleased] with entries: keeps Unreleased on top, carries entries into the new section', () => {
    const body = [
      '# Changelog',
      '',
      'All notable changes are documented here.',
      '',
      '## [Unreleased]',
      '',
      '- pending fix A',
      '- pending fix B',
      '',
      '## v0.6.1',
      '',
      '- old release',
      '',
    ].join('\n')

    const result = insertVersionSection(body, NEW_SECTION)

    expect(isCheck43Conforming(result)).toBe(true)
    // Unreleased is the first h2 heading.
    expect(result.indexOf('## [Unreleased]')).toBeLessThan(result.indexOf('## v0.6.2'))
    // New version section sits before the prior release.
    expect(result.indexOf('## v0.6.2')).toBeLessThan(result.indexOf('## v0.6.1'))
    // The carried entries moved into the new version section.
    const v062 = result.indexOf('## v0.6.2')
    const v061 = result.indexOf('## v0.6.1')
    const versionBlock = result.slice(v062, v061)
    expect(versionBlock).toContain('- pending fix A')
    expect(versionBlock).toContain('- pending fix B')
    // [Unreleased] is now empty (no entry lines between it and v0.6.2).
    const unreleasedBlock = result.slice(
      result.indexOf('## [Unreleased]'),
      result.indexOf('## v0.6.2')
    )
    expect(unreleasedBlock).not.toContain('- pending')
    // Prior release content is preserved.
    expect(result).toContain('- old release')
  })

  it('leading [Unreleased] empty: keeps it empty, inserts new section after it', () => {
    const body = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '## v0.6.1',
      '',
      '- old release',
      '',
    ].join('\n')

    const result = insertVersionSection(body, NEW_SECTION)

    expect(isCheck43Conforming(result)).toBe(true)
    expect(result.indexOf('## [Unreleased]')).toBeLessThan(result.indexOf('## v0.6.2'))
    expect(result.indexOf('## v0.6.2')).toBeLessThan(result.indexOf('## v0.6.1'))
    expect(result).toContain('- old release')
  })

  it('no [Unreleased] heading: synthesizes an empty one before the new section', () => {
    const body = [
      '# Changelog',
      '',
      'All notable changes are documented here.',
      '',
      '## v0.6.1',
      '',
      '- old release',
      '',
    ].join('\n')

    const result = insertVersionSection(body, NEW_SECTION)

    expect(isCheck43Conforming(result)).toBe(true)
    expect(result).toContain('## [Unreleased]')
    expect(result.indexOf('## [Unreleased]')).toBeLessThan(result.indexOf('## v0.6.2'))
    expect(result.indexOf('## v0.6.2')).toBeLessThan(result.indexOf('## v0.6.1'))
    expect(result).toContain('- old release')
  })

  it('empty / header-only file: synthesizes [Unreleased] then the new section', () => {
    const body = '# Changelog\n\nAll notable changes to this package are documented here.\n'

    const result = insertVersionSection(body, NEW_SECTION)

    expect(isCheck43Conforming(result)).toBe(true)
    expect(result).toContain('## [Unreleased]')
    expect(result).toContain('## v0.6.2')
    expect(result.indexOf('## [Unreleased]')).toBeLessThan(result.indexOf('## v0.6.2'))
    expect(result).toContain('# Changelog')
  })
})
