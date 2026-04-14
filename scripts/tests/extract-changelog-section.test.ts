import { describe, expect, it } from 'vitest'
import { parseHeader, listSections, extractSection } from '../extract-changelog-section.mjs'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

describe('parseHeader', () => {
  it('accepts ## [X.Y.Z] - YYYY-MM-DD', () => {
    expect(parseHeader('## [0.4.12] - 2026-02-23')).toBe('0.4.12')
  })

  it('accepts ## [X.Y.Z]', () => {
    expect(parseHeader('## [0.5.0]')).toBe('0.5.0')
  })

  it('accepts ## X.Y.Z', () => {
    expect(parseHeader('## 0.5.1')).toBe('0.5.1')
  })

  it('accepts ## vX.Y.Z', () => {
    expect(parseHeader('## v0.4.9')).toBe('0.4.9')
  })

  it('accepts ## vX.Y.Z (YYYY-MM-DD)', () => {
    expect(parseHeader('## v0.5.2 (2026-03-24)')).toBe('0.5.2')
  })

  it('accepts ## [Unreleased]', () => {
    expect(parseHeader('## [Unreleased]')).toBe('Unreleased')
  })

  it('accepts pre-release suffixes', () => {
    expect(parseHeader('## [1.0.0-rc.1]')).toBe('1.0.0-rc.1')
    expect(parseHeader('## 1.0.0-beta.2')).toBe('1.0.0-beta.2')
  })

  it('rejects non-version headers', () => {
    expect(parseHeader('## Added')).toBeNull()
    expect(parseHeader('## Fixed')).toBeNull()
    expect(parseHeader('### v0.5.0')).toBeNull()
    expect(parseHeader('# v0.5.0')).toBeNull()
    expect(parseHeader('random text')).toBeNull()
    expect(parseHeader('')).toBeNull()
  })
})

describe('listSections', () => {
  it('returns empty array for changelog with no version sections', () => {
    const content = '# Changelog\n\nJust a description.\n'
    expect(listSections(content)).toEqual([])
  })

  it('finds all version sections in order', () => {
    const content = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '- Pending',
      '',
      '## v0.5.1',
      '- Fix',
      '',
      '## [0.5.0] - 2026-03-01',
      '- Feature',
    ].join('\n')
    const sections = listSections(content)
    expect(sections.map((s) => s.version)).toEqual(['Unreleased', '0.5.1', '0.5.0'])
  })
})

describe('extractSection', () => {
  const sampleContent = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '- SMI-4124: new feature',
    '',
    '## v0.5.1',
    '',
    '- **Fix**: something',
    '- **Feature**: something else (PR #500)',
    '',
    '## [0.5.0] - 2026-03-01',
    '',
    '### Added',
    '',
    '- Thing one',
    '- Thing two',
    '',
    '### Fixed',
    '',
    '- Bug (#400)',
  ].join('\n')

  it('extracts body between two version headers', () => {
    const result = extractSection(sampleContent, '0.5.1')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.body).toBe('- **Fix**: something\n- **Feature**: something else (PR #500)')
    }
  })

  it('extracts final section to end-of-file', () => {
    const result = extractSection(sampleContent, '0.5.0')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.body).toContain('### Added')
      expect(result.body).toContain('- Thing one')
      expect(result.body).toContain('### Fixed')
      expect(result.body).toContain('- Bug (#400)')
      expect(result.body.endsWith('- Bug (#400)')).toBe(true)
    }
  })

  it('extracts [Unreleased] section', () => {
    const result = extractSection(sampleContent, 'Unreleased')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.body).toBe('- SMI-4124: new feature')
  })

  it('returns not-found for missing version', () => {
    const result = extractSection(sampleContent, '9.9.9')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('not-found')
  })

  it('returns no-baseline for changelog with no version sections', () => {
    const result = extractSection('# Changelog\n\nNothing yet.\n', '0.1.0')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('no-baseline')
  })

  it('returns no-baseline when only [Unreleased] exists and a released version is requested', () => {
    const content = '# Changelog\n\n## [Unreleased]\n\n- pending\n'
    const result = extractSection(content, '0.1.0')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('no-baseline')
  })

  it('allows extracting [Unreleased] even when no released versions exist', () => {
    const content = '# Changelog\n\n## [Unreleased]\n\n- pending\n'
    const result = extractSection(content, 'Unreleased')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.body).toBe('- pending')
  })
})

// Fixture tests against real CHANGELOGs in the repo. These protect against
// header-form drift — if a CHANGELOG introduces a new header shape, these fail.
describe('fixture: round-trip against all in-repo CHANGELOGs', () => {
  const root = join(__dirname, '..', '..')
  const changelogs = [
    'CHANGELOG.md',
    'packages/core/CHANGELOG.md',
    'packages/mcp-server/CHANGELOG.md',
    'packages/cli/CHANGELOG.md',
    'packages/vscode-extension/CHANGELOG.md',
  ]

  for (const rel of changelogs) {
    const abs = join(root, rel)
    const exists = existsSync(abs)
    it(`${rel} — ${exists ? 'parses without error' : 'absent (skipped)'}`, () => {
      if (!exists) return // file absent is fine; drift detector skips absent files
      const content = readFileSync(abs, 'utf-8')
      const sections = listSections(content)
      // Every parsed section's version must be non-empty and either "Unreleased" or semver-shaped
      for (const s of sections) {
        expect(s.version.length).toBeGreaterThan(0)
        if (s.version !== 'Unreleased') {
          expect(s.version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
        }
      }
      // Every released section must extract successfully
      for (const s of sections) {
        const r = extractSection(content, s.version)
        expect(r.ok).toBe(true)
      }
    })
  }
})
