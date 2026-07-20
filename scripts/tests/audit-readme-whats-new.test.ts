import { describe, it, expect } from 'vitest'
import { extractWhatsNewVersion } from '../audit-readme-whats-new-helpers.mjs'

describe('extractWhatsNewVersion', () => {
  it('extracts the version from a heading with a leading "v"', () => {
    expect(extractWhatsNewVersion("# Package\n\n## What's New in v0.11.2\n\n- Bullet")).toBe(
      '0.11.2'
    )
  })

  it('extracts the version from a heading with no leading "v"', () => {
    expect(extractWhatsNewVersion("## What's New in 0.8.2\n\n- Bullet")).toBe('0.8.2')
  })

  it('returns null when no "What\'s New" heading exists', () => {
    expect(extractWhatsNewVersion('# Package\n\n## Installation\n\nnpm install foo')).toBeNull()
  })

  it('returns null when the heading exists but has no parseable version', () => {
    expect(extractWhatsNewVersion("## What's New\n\n- Bullet with no version")).toBeNull()
  })

  it('only matches a "## " heading at line start, not a deeper sub-heading', () => {
    expect(extractWhatsNewVersion("### What's New in v1.2.3\n\n- Bullet")).toBeNull()
  })

  it('only matches at line start, not mid-sentence text with the same words', () => {
    const content = "See the section on What's New in v1.2.3 for details, below the fold."
    expect(extractWhatsNewVersion(content)).toBeNull()
  })
})
