import { describe, expect, it } from 'vitest'

import { extractChangeTokens, insertVersionSection } from '../lib/release-changelog.js'

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

/**
 * Count occurrences of an `SMI-NNNN` token within the freshly generated
 * `## vX.Y.Z` version section (between its heading and the next `## ` heading).
 */
function countTokenInVersionSection(body: string, versionHeading: string, token: string): number {
  const start = body.indexOf(versionHeading)
  if (start === -1) return 0
  const afterHeading = body.slice(start + versionHeading.length)
  const nextHeading = afterHeading.indexOf('\n## ')
  const section = nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading)
  return section.split(token).length - 1
}

describe('insertVersionSection — SMI-4928 carried-forward dedupe', () => {
  it('suppresses the auto-generated terse entry when a carried [Unreleased] entry covers the same SMI', () => {
    const body = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '- **Fix**: SMI-4919 — long detailed description of the preserved behaviour (#1140)',
      '',
      '## v0.6.1',
      '',
      '- old release',
      '',
    ].join('\n')
    const autoSection = '## v0.6.2\n\n- **Fix**: SMI-4919 preserve attribution (#1140)'

    const result = insertVersionSection(body, autoSection)

    // SMI-4919 appears exactly once in the new version section.
    expect(countTokenInVersionSection(result, '## v0.6.2', 'SMI-4919')).toBe(1)
    // The detailed/carried line is the one kept; the terse line is dropped.
    expect(result).toContain('- **Fix**: SMI-4919 — long detailed description')
    expect(result).not.toContain('- **Fix**: SMI-4919 preserve attribution')
  })

  it('does not over-suppress: an unrelated auto entry survives alongside the carried one', () => {
    const body = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '- **Fix**: SMI-4919 — long detailed description (#1140)',
      '',
      '## v0.6.1',
      '',
      '- old release',
      '',
    ].join('\n')
    const autoSection = [
      '## v0.6.2',
      '',
      '- **Fix**: SMI-4919 preserve attribution (#1140)',
      '- **Feature**: SMI-4923 new unrelated capability (#1145)',
    ].join('\n')

    const result = insertVersionSection(body, autoSection)

    expect(countTokenInVersionSection(result, '## v0.6.2', 'SMI-4919')).toBe(1)
    expect(countTokenInVersionSection(result, '## v0.6.2', 'SMI-4923')).toBe(1)
    expect(result).toContain('- **Feature**: SMI-4923 new unrelated capability')
    expect(result).not.toContain('- **Fix**: SMI-4919 preserve attribution')
  })

  it('empty [Unreleased]: the auto-generated section is byte-identical to pre-fix output', () => {
    const bodyEmptyUnreleased = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '## v0.6.1',
      '',
      '- old release',
      '',
    ].join('\n')
    const autoSection = [
      '## v0.6.2',
      '',
      '- **Fix**: SMI-4919 preserve attribution (#1140)',
      '- **Feature**: SMI-4923 new capability (#1145)',
    ].join('\n')

    const result = insertVersionSection(bodyEmptyUnreleased, autoSection)

    // No carried entries → no token logic; the auto section is appended verbatim.
    expect(result).toContain(autoSection.trim())
  })

  it('keeps an auto-generated entry that carries no SMI/PR token even when [Unreleased] is non-empty', () => {
    const body = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '- **Fix**: SMI-4919 — long detailed description (#1140)',
      '',
      '## v0.6.1',
      '',
      '- old release',
      '',
    ].join('\n')
    const autoSection = [
      '## v0.6.2',
      '',
      '- **Fix**: SMI-4919 preserve attribution (#1140)',
      '- **Chore**: tidy up internal helper naming',
    ].join('\n')

    const result = insertVersionSection(body, autoSection)

    // Tokenless auto entry cannot be proven a duplicate → kept.
    expect(result).toContain('- **Chore**: tidy up internal helper naming')
    expect(countTokenInVersionSection(result, '## v0.6.2', 'SMI-4919')).toBe(1)
  })

  it('invariant: no SMI token appears twice in a freshly generated version section', () => {
    const body = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '- **Fix**: SMI-4919 — detailed (#1140)',
      '- **Feature**: SMI-4923 — detailed (#1145)',
      '',
      '## v0.6.1',
      '',
      '- old release',
      '',
    ].join('\n')
    const autoSection = [
      '## v0.6.2',
      '',
      '- **Fix**: SMI-4919 terse (#1140)',
      '- **Feature**: SMI-4923 terse (#1145)',
      '- **Perf**: SMI-4930 terse (#1150)',
    ].join('\n')

    const result = insertVersionSection(body, autoSection)

    const start = result.indexOf('## v0.6.2')
    const section = result.slice(start, result.indexOf('## v0.6.1'))
    for (const token of new Set(section.match(/SMI-\d+/g) ?? [])) {
      expect(section.split(token).length - 1).toBe(1)
    }
  })

  it('all auto entries suppressed: header still emitted, body is the carried block', () => {
    const body = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '- **Fix**: SMI-4919 — detailed (#1140)',
      '',
      '## v0.6.1',
      '',
      '- old release',
      '',
    ].join('\n')
    const autoSection = '## v0.6.2\n\n- **Fix**: SMI-4919 terse (#1140)'

    const result = insertVersionSection(body, autoSection)

    expect(result).toContain('## v0.6.2')
    expect(countTokenInVersionSection(result, '## v0.6.2', 'SMI-4919')).toBe(1)
    expect(result).toContain('- **Fix**: SMI-4919 — detailed (#1140)')
    expect(result).not.toContain('- **Fix**: SMI-4919 terse')
  })
})

describe('extractChangeTokens', () => {
  it('extracts an SMI ref and a PR ref from one entry line', () => {
    expect(extractChangeTokens('- **Fix**: SMI-4919 preserve attribution (#1140)')).toEqual([
      'SMI-4919',
      '#1140',
    ])
  })

  it('extracts multiple SMI refs in a single line', () => {
    expect(extractChangeTokens('- **Fix**: SMI-4919 and SMI-4923 combined (#1140)')).toEqual([
      'SMI-4919',
      'SMI-4923',
      '#1140',
    ])
  })

  it('uppercases lowercase SMI refs', () => {
    expect(extractChangeTokens('- fix smi-4919 thing')).toEqual(['SMI-4919'])
  })

  it('returns an empty array for a line with no recognizable token', () => {
    expect(extractChangeTokens('- **Chore**: tidy up internal helper naming')).toEqual([])
  })

  it('does not treat a bare #NN (without parentheses) as a PR token', () => {
    expect(extractChangeTokens('- note about issue #1140 inline')).toEqual([])
  })
})
