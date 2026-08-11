import { describe, it, expect } from 'vitest'
import {
  extractWhatsNewVersion,
  hasWhatsNewHeading,
  githubHeadingSlug,
  updateWhatsNewVersion,
} from '../audit-readme-whats-new-helpers.mjs'

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

describe('hasWhatsNewHeading (SMI-5663 Wave 1)', () => {
  it('returns true when a versioned heading exists', () => {
    expect(hasWhatsNewHeading("## What's New in v1.2.3\n\n- Bullet")).toBe(true)
  })

  it('returns true for a heading with no parseable version (loose match)', () => {
    expect(hasWhatsNewHeading("## What's New\n\n- Bullet with no version")).toBe(true)
  })

  it('returns false when no "What\'s New" heading exists at all', () => {
    expect(hasWhatsNewHeading('# Package\n\n## Installation\n\nnpm install foo')).toBe(false)
  })

  it('returns false for a deeper sub-heading', () => {
    expect(hasWhatsNewHeading("### What's New in v1.2.3\n\n- Bullet")).toBe(false)
  })
})

describe('githubHeadingSlug (SMI-5663 Wave 1)', () => {
  it('matches the real anchor packages/core/README.md uses for "What\'s New in v0.11.4"', () => {
    expect(githubHeadingSlug("What's New in v0.11.4")).toBe('whats-new-in-v0114')
  })

  it('matches the real anchor packages/cli/README.md uses for "What\'s New in v0.8.4"', () => {
    expect(githubHeadingSlug("What's New in v0.8.4")).toBe('whats-new-in-v084')
  })
})

describe('updateWhatsNewVersion (SMI-5663 Wave 1)', () => {
  it('rewrites a versioned heading to the new version', () => {
    const content = "# Package\n\n## What's New in v0.11.4\n\n- Bullet\n"
    expect(updateWhatsNewVersion(content, '0.11.5')).toBe(
      "# Package\n\n## What's New in v0.11.5\n\n- Bullet\n"
    )
  })

  it('preserves everything else in the file untouched', () => {
    const content =
      "# @skillsmith/core\n\n## Contents\n\n- [Installation](#installation)\n\n## What's New in v0.11.4\n\n- Security fix\n\n## Installation\n\nnpm install\n"
    const updated = updateWhatsNewVersion(content, '0.11.5')
    expect(updated).toContain('## Installation\n\nnpm install')
    expect(updated).toContain('- Security fix')
    expect(updated).toContain("## What's New in v0.11.5")
  })

  it('also rewrites a matching TOC anchor link', () => {
    const content =
      "# @skillsmith/core\n\n## Contents\n\n- [What's New](#whats-new-in-v0114)\n- [Installation](#installation)\n\n## What's New in v0.11.4\n\n- Bullet\n"
    const updated = updateWhatsNewVersion(content, '0.11.5')
    expect(updated).toContain("- [What's New](#whats-new-in-v0115)")
    expect(updated).not.toContain('#whats-new-in-v0114')
  })

  it('does not touch an unrelated TOC anchor', () => {
    const content =
      "## Contents\n\n- [What's New](#whats-new-in-v084)\n- [Installation](#installation)\n\n## What's New in v0.8.4\n\n- Bullet\n"
    const updated = updateWhatsNewVersion(content, '0.8.5')
    expect(updated).toContain('#installation')
  })

  it('rewrites the TOC anchor correctly when the heading has no leading "v" (code-review regression, SMI-5663)', () => {
    // The heading regex tolerates a missing "v" ("## What's New in 1.2.3"),
    // but the old slug used to be reconstructed with a hardcoded "v" prefix
    // regardless of what the real heading said — computing "whats-new-in-v123"
    // instead of the real old anchor "whats-new-in-123", so the TOC link
    // rewrite never matched and silently left a stale anchor behind.
    const content =
      "## Contents\n\n- [What's New](#whats-new-in-123)\n\n## What's New in 1.2.3\n\n- Bullet\n"
    const updated = updateWhatsNewVersion(content, '1.2.4')
    expect(updated).toContain("- [What's New](#whats-new-in-v124)")
    expect(updated).not.toContain('#whats-new-in-123')
  })

  it('leaves the file unchanged when there is no TOC anchor to update (mcp-server shape)', () => {
    const content = "# @skillsmith/mcp-server\n\n## What's New in v0.7.6\n\n- Bullet\n"
    const updated = updateWhatsNewVersion(content, '0.7.7')
    expect(updated).toBe("# @skillsmith/mcp-server\n\n## What's New in v0.7.7\n\n- Bullet\n")
  })

  it('throws when no "What\'s New" heading exists', () => {
    expect(() => updateWhatsNewVersion('# Package\n\n## Installation\n', '1.0.0')).toThrow(
      /no "## What's New in vX.Y.Z" heading found/
    )
  })

  it('throws when the heading exists but has no parseable version', () => {
    expect(() =>
      updateWhatsNewVersion("## What's New\n\n- Bullet with no version", '1.0.0')
    ).toThrow(/no "## What's New in vX.Y.Z" heading found/)
  })

  it('throws (fails closed) when more than one matching heading exists — ambiguous', () => {
    const content =
      "## What's New in v1.0.0\n\n- Bullet\n\n## Archive\n\n## What's New in v0.9.0\n\n- Old bullet\n"
    expect(() => updateWhatsNewVersion(content, '1.1.0')).toThrow(/ambiguous/)
  })
})
