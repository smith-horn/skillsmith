/**
 * Tests for the SMI-5680 CHANGELOG entry gate helpers.
 *
 * Covers `countUnreleasedEntries` and `isReleasePrepDiff` in
 * audit-standards-helpers.mjs. Background: PR #1878 (SMI-5671) merged real
 * source changes to packages/mcp-server/src/** and packages/core/src/** with
 * zero CHANGELOG.md entries in either package — nothing caught it. These two
 * pure helpers are the logic layer; Check 54 in audit-standards.mjs provides
 * the git I/O layer (mergeBase/HEAD reads via `git show`).
 *
 * See docs/internal/implementation/smi-5680-changelog-entry-gate.md for the
 * full VP-reviewed design, including the Step 0 release-prep exemption this
 * file's `isReleasePrepDiff` suite verifies against the actual shape of
 * commit 2e31a616 ("chore(release): bump core 0.11.2...").
 */
import { describe, expect, it } from 'vitest'

const helpers = (await import('../audit-standards-helpers.mjs')) as {
  countUnreleasedEntries: (changelogContent: string) => number | null
  isReleasePrepDiff: (
    pkgJsonAtBase: string,
    pkgJsonAtHead: string,
    changelogAtBase: string,
    changelogAtHead: string
  ) => boolean
}

const { countUnreleasedEntries, isReleasePrepDiff } = helpers

// ---------------------------------------------------------------------------
// countUnreleasedEntries
// ---------------------------------------------------------------------------

describe('countUnreleasedEntries (SMI-5680)', () => {
  it('empty section: heading present, no content below it → 0', () => {
    const changelog = [
      '# Changelog',
      '',
      'All notable changes to `@skillsmith/core` are documented here.',
      '',
      '## [Unreleased]',
      '',
      '## v0.11.1',
      '',
      '- **Fix**: something already released',
      '',
    ].join('\n')
    expect(countUnreleasedEntries(changelog)).toBe(0)
  })

  it('single qualifying entry: >= 4 whitespace-separated tokens → 1', () => {
    const changelog = [
      '## [Unreleased]',
      '',
      '- **Fix**: Widen `JournalAction` to include revert',
      '',
      '## v0.11.1',
    ].join('\n')
    expect(countUnreleasedEntries(changelog)).toBe(1)
  })

  it('single junk (<4-token) entry does NOT count (SMI-5680 L1) → 0', () => {
    const changelog = ['## [Unreleased]', '', '- fix', '', '## v0.11.1'].join('\n')
    expect(countUnreleasedEntries(changelog)).toBe(0)
  })

  it('a lone dash bullet does NOT count → 0', () => {
    const changelog = ['## [Unreleased]', '', '-', '', '## v0.11.1'].join('\n')
    expect(countUnreleasedEntries(changelog)).toBe(0)
  })

  it('multiple entries: qualifying + junk mixed → counts only qualifying lines', () => {
    const changelog = [
      '## [Unreleased]',
      '',
      '- **Fix**: Widen JournalAction to include revert',
      '- fix',
      '- **Feature**: Add another cool thing entirely',
      '',
      '## v0.11.1',
    ].join('\n')
    expect(countUnreleasedEntries(changelog)).toBe(2)
  })

  it('entries after the next ## heading are NOT counted (section boundary)', () => {
    const changelog = [
      '## [Unreleased]',
      '',
      '- **Fix**: Widen JournalAction to include revert',
      '',
      '## v0.11.1',
      '',
      '- **Fix**: A previously released four token entry',
    ].join('\n')
    expect(countUnreleasedEntries(changelog)).toBe(1)
  })

  it('missing heading returns the sentinel (null), not 0', () => {
    const changelog = ['# Changelog', '', '## v0.11.1', '', '- **Fix**: something'].join('\n')
    expect(countUnreleasedEntries(changelog)).toBeNull()
  })

  it('malformed heading text (typo) returns the sentinel (null)', () => {
    const changelog = ['# Changelog', '', '## Unrelesed', '', '- **Fix**: something'].join('\n')
    expect(countUnreleasedEntries(changelog)).toBeNull()
  })

  it('non-string input returns the sentinel (null)', () => {
    // @ts-expect-error — deliberately exercising the defensive typeof guard
    expect(countUnreleasedEntries(undefined)).toBeNull()
  })

  it('accepts the bracket-less "## Unreleased" heading form too', () => {
    const changelog = ['## Unreleased', '', '- **Fix**: Widen JournalAction to revert'].join('\n')
    expect(countUnreleasedEntries(changelog)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// isReleasePrepDiff
// ---------------------------------------------------------------------------

// Real package.json / CHANGELOG.md shapes lifted from this repo's actual
// release commit 2e31a616 ("chore(release): bump core 0.11.2, mcp-server
// 0.7.4, cli 0.8.2, vscode 0.7.2, enterprise 0.3.2"). Confirmed via
// `git show 2e31a616 -- packages/core/CHANGELOG.md packages/core/package.json`.
const CORE_PKG_JSON_BASE = JSON.stringify({ name: '@skillsmith/core', version: '0.11.1' })
const CORE_PKG_JSON_HEAD = JSON.stringify({ name: '@skillsmith/core', version: '0.11.2' })

const CORE_CHANGELOG_BASE = [
  '# Changelog',
  '',
  'All notable changes to `@skillsmith/core` are documented here.',
  '',
  '## [Unreleased]',
  '',
  "- **Fix**: Widen `JournalAction` to include `'revert'` and bump `JOURNAL_SCHEMA_VERSION` 1→2 — an older reader's closed-set validation would otherwise flag a legitimate revert journal record as corrupt (SMI-5671) (#1878)",
  '',
  '## v0.11.1',
  '',
  '- **Fix**: unified shutdown coordinator + awaitable sync stop (SMI-5649/SMI-5640) (#1826)',
].join('\n')

// insertVersionSection's actual output shape (scripts/lib/release-changelog.ts):
// `## [Unreleased]` stays on top (now empty), the carried-forward entry is
// re-parented under the newly-inserted `## v0.11.2` heading directly below it.
const CORE_CHANGELOG_HEAD = [
  '# Changelog',
  '',
  'All notable changes to `@skillsmith/core` are documented here.',
  '',
  '## [Unreleased]',
  '',
  '## v0.11.2',
  '',
  "- **Fix**: Expose apply_namespace_rename action:'revert'",
  "- **Fix**: Widen `JournalAction` to include `'revert'` and bump `JOURNAL_SCHEMA_VERSION` 1→2 — an older reader's closed-set validation would otherwise flag a legitimate revert journal record as corrupt (SMI-5671) (#1878)",
  '',
  '## v0.11.1',
  '',
  '- **Fix**: unified shutdown coordinator + awaitable sync stop (SMI-5649/SMI-5640) (#1826)',
].join('\n')

describe('isReleasePrepDiff (SMI-5680 C1 / Step 0)', () => {
  it('true: actual 2e31a616 release-commit shape (version bump + heading inserted below Unreleased)', () => {
    expect(
      isReleasePrepDiff(
        CORE_PKG_JSON_BASE,
        CORE_PKG_JSON_HEAD,
        CORE_CHANGELOG_BASE,
        CORE_CHANGELOG_HEAD
      )
    ).toBe(true)
  })

  it('false: no version bump (package.json version unchanged) even if changelog structure matches', () => {
    expect(
      isReleasePrepDiff(
        CORE_PKG_JSON_BASE,
        CORE_PKG_JSON_BASE,
        CORE_CHANGELOG_BASE,
        CORE_CHANGELOG_HEAD
      )
    ).toBe(false)
  })

  it('false: version bumped but CHANGELOG unchanged (no version heading inserted) — the plain omission case', () => {
    expect(
      isReleasePrepDiff(
        CORE_PKG_JSON_BASE,
        CORE_PKG_JSON_HEAD,
        CORE_CHANGELOG_BASE,
        CORE_CHANGELOG_BASE
      )
    ).toBe(false)
  })

  it('false: the new version heading already existed at base (pre-existing, not new in this diff)', () => {
    const changelogBaseAlreadyHasHeading = [
      '## [Unreleased]',
      '',
      '## v0.11.2',
      '',
      '- pre-existing entry, not part of this diff',
    ].join('\n')
    expect(
      isReleasePrepDiff(
        CORE_PKG_JSON_BASE,
        CORE_PKG_JSON_HEAD,
        changelogBaseAlreadyHasHeading,
        CORE_CHANGELOG_HEAD
      )
    ).toBe(false)
  })

  it('false: version bumped but the inserted heading does not match the new version', () => {
    const wrongVersionChangelogHead = [
      '## [Unreleased]',
      '',
      '## v9.9.9',
      '',
      '- unrelated version heading',
    ].join('\n')
    expect(
      isReleasePrepDiff(
        CORE_PKG_JSON_BASE,
        CORE_PKG_JSON_HEAD,
        CORE_CHANGELOG_BASE,
        wrongVersionChangelogHead
      )
    ).toBe(false)
  })

  it('false: malformed package.json JSON at HEAD fails safe (no throw, no exemption)', () => {
    expect(
      isReleasePrepDiff(
        CORE_PKG_JSON_BASE,
        '{ not valid json',
        CORE_CHANGELOG_BASE,
        CORE_CHANGELOG_HEAD
      )
    ).toBe(false)
  })

  it('false: package.json missing a "version" field fails safe', () => {
    const pkgJsonNoVersion = JSON.stringify({ name: '@skillsmith/core' })
    expect(
      isReleasePrepDiff(
        CORE_PKG_JSON_BASE,
        pkgJsonNoVersion,
        CORE_CHANGELOG_BASE,
        CORE_CHANGELOG_HEAD
      )
    ).toBe(false)
  })

  it('false: heading directly below Unreleased at HEAD is itself missing (entry, not a heading)', () => {
    // Simulates a hand-edited Unreleased section where an entry line sits
    // where the version heading should be — must not be misread as release-prep.
    const changelogHeadNoHeading = [
      '## [Unreleased]',
      '',
      '- **Fix**: some manually-added entry, not a version heading',
      '',
      '## v0.11.1',
    ].join('\n')
    expect(
      isReleasePrepDiff(
        CORE_PKG_JSON_BASE,
        CORE_PKG_JSON_HEAD,
        CORE_CHANGELOG_BASE,
        changelogHeadNoHeading
      )
    ).toBe(false)
  })
})
