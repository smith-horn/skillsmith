/**
 * @fileoverview Unit tests for the shared skill-identity classification module
 * @see SMI-6343 Wave 3 — tamper-check classification (AC#3)
 */

import { describe, it, expect } from 'vitest'
import {
  parseOwnerFromSource,
  parseOwnerFromId,
  detectOwnerMismatch,
  detectPathUnresolved,
  hasRecordedLocalEdit,
  classifyManifestEntryIdentity,
  classifyDivergentEntry,
  classifyOutdatedState,
  type ManifestEntryForIdentity,
  type RegistryLookupOutcome,
} from './skill-identity-classification.js'

function entry(overrides: Partial<ManifestEntryForIdentity> = {}): ManifestEntryForIdentity {
  return {
    id: 'wrsmith108/linear',
    source: 'github:wrsmith108/linear',
    installPath: '/home/user/.claude/skills/linear',
    ...overrides,
  }
}

const notAttempted: RegistryLookupOutcome = { attempted: false, record: null, failureReason: null }

describe('parseOwnerFromSource', () => {
  it('parses the owner out of a github: prefixed source', () => {
    expect(parseOwnerFromSource('github:lobehub/lobehub')).toBe('lobehub')
  })
  it('parses a bare owner/repo without the prefix', () => {
    expect(parseOwnerFromSource('acme/widget')).toBe('acme')
  })
  it('returns null for the "unknown" distrust sentinel', () => {
    expect(parseOwnerFromSource('unknown')).toBeNull()
  })
  it('returns null for a source with no parseable owner segment', () => {
    expect(parseOwnerFromSource('registry')).toBeNull()
    expect(parseOwnerFromSource('')).toBeNull()
    expect(parseOwnerFromSource(null)).toBeNull()
    expect(parseOwnerFromSource(undefined)).toBeNull()
  })
  it('returns null for a raw URL source with no github: prefix', () => {
    expect(parseOwnerFromSource('https://github.com/owner/repo')).toBeNull()
  })
})

describe('parseOwnerFromId', () => {
  it('parses the owner out of an owner/name id', () => {
    expect(parseOwnerFromId('wrsmith108/linear')).toBe('wrsmith108')
  })
  it('returns null for a bare name with no slash', () => {
    expect(parseOwnerFromId('linear')).toBeNull()
  })
  it('returns null for null/undefined', () => {
    expect(parseOwnerFromId(null)).toBeNull()
    expect(parseOwnerFromId(undefined)).toBeNull()
  })
  it('returns null for a raw GitHub URL id (direct-URL install) — regression: must not parse "https:" as the owner', () => {
    expect(parseOwnerFromId('https://github.com/owner-b/test-repo')).toBeNull()
  })
  it('returns null for a 3+-segment owner/repo/path shape', () => {
    expect(parseOwnerFromId('owner/repo/path')).toBeNull()
  })
})

describe('detectOwnerMismatch (signal 1)', () => {
  it('fires when id and source name different owners — the real `linear` incident shape', () => {
    expect(detectOwnerMismatch({ id: 'wrsmith108/linear', source: 'github:lobehub/lobehub' })).toBe(
      true
    )
  })
  it('does not fire when owners agree', () => {
    expect(
      detectOwnerMismatch({ id: 'wrsmith108/linear', source: 'github:wrsmith108/linear' })
    ).toBe(false)
  })
  it('does not fire (case-insensitive) when owners agree only up to case', () => {
    expect(
      detectOwnerMismatch({ id: 'WrSmith108/linear', source: 'github:wrsmith108/linear' })
    ).toBe(false)
  })
  it('does not fire when source is the "unknown" sentinel', () => {
    expect(detectOwnerMismatch({ id: 'wrsmith108/linear', source: 'unknown' })).toBe(false)
  })
  it('does not fire when id has no owner segment', () => {
    expect(detectOwnerMismatch({ id: 'linear', source: 'github:lobehub/lobehub' })).toBe(false)
  })
  it('does not fire for a direct-URL install (id is the raw URL itself) — regression found against a real CLI multi-client fixture', () => {
    expect(
      detectOwnerMismatch({
        id: 'https://github.com/owner-b/test-repo',
        source: 'github:owner-b/test-repo',
      })
    ).toBe(false)
  })
})

describe('detectPathUnresolved (signal 3)', () => {
  const root = '/home/user/.claude/skills'
  it('does not fire for a path inside the expected root', () => {
    expect(detectPathUnresolved(`${root}/astro`, root)).toBe(false)
  })
  it('fires for a path outside the expected root — the fixture-leak shape', () => {
    expect(detectPathUnresolved('/tmp/skillsmith-test-abc123/fixture', root)).toBe(true)
  })
  it('fires for a missing installPath', () => {
    expect(detectPathUnresolved(undefined, root)).toBe(true)
    expect(detectPathUnresolved('', root)).toBe(true)
  })
  it('does not fire when installPath equals the root itself', () => {
    expect(detectPathUnresolved(root, root)).toBe(false)
  })
})

describe('hasRecordedLocalEdit', () => {
  it('returns true when the on-disk hash differs from the recorded hash', () => {
    expect(hasRecordedLocalEdit({ contentHash: 'aaa' }, 'bbb')).toBe(true)
  })
  it('returns false when the on-disk hash matches the recorded hash', () => {
    expect(hasRecordedLocalEdit({ contentHash: 'aaa' }, 'aaa')).toBe(false)
  })
  it('falls back to originalContentHash when contentHash is absent', () => {
    expect(hasRecordedLocalEdit({ originalContentHash: 'aaa' }, 'bbb')).toBe(true)
  })
  it('defaults to false (no evidence of edit) when neither hash was ever recorded', () => {
    expect(hasRecordedLocalEdit({}, 'bbb')).toBe(false)
  })
  it('defaults to false when the local hash itself is unavailable', () => {
    expect(hasRecordedLocalEdit({ contentHash: 'aaa' }, null)).toBe(false)
  })
})

describe('classifyManifestEntryIdentity — signal 2 (frontmatter contradiction)', () => {
  const frontmatterContent = [
    '---',
    'name: commit',
    'author: some-unrelated-author',
    '---',
    '# Commit skill',
    'Sentry commit-message conventions.',
  ].join('\n')

  it('fires when on-disk author contradicts the registry record for the claimed id', () => {
    const result = classifyManifestEntryIdentity({
      entry: entry({ id: 'acme/commit', source: 'github:acme/commit' }),
      localContent: frontmatterContent,
      expectedRootDir: '/home/user/.claude/skills',
      registryLookup: { attempted: true, record: { author: 'acme', name: 'commit' } },
    })
    expect(result.signal).toBe('frontmatter-contradiction')
    expect(result.inconclusive).toBe(false)
  })

  it('does not fire when on-disk author agrees with the registry record', () => {
    const result = classifyManifestEntryIdentity({
      entry: entry({
        id: 'some-unrelated-author/commit',
        source: 'github:some-unrelated-author/commit',
      }),
      localContent: frontmatterContent,
      expectedRootDir: '/home/user/.claude/skills',
      registryLookup: {
        attempted: true,
        record: { author: 'some-unrelated-author', name: 'commit' },
      },
    })
    expect(result.signal).toBeNull()
    expect(result.inconclusive).toBe(false)
  })

  it('is inconclusive (never "no contradiction") when the lookup was not attempted — offline', () => {
    const result = classifyManifestEntryIdentity({
      entry: entry(),
      localContent: frontmatterContent,
      expectedRootDir: '/home/user/.claude/skills',
      registryLookup: { attempted: false, record: null, failureReason: 'offline' },
    })
    expect(result.signal).toBeNull()
    expect(result.inconclusive).toBe(true)
    expect(result.inconclusiveReason).toBe('offline')
  })

  it('is inconclusive when quota-exhausted', () => {
    const result = classifyManifestEntryIdentity({
      entry: entry(),
      localContent: frontmatterContent,
      expectedRootDir: '/home/user/.claude/skills',
      registryLookup: { attempted: false, record: null, failureReason: 'quota-exhausted' },
    })
    expect(result.inconclusive).toBe(true)
    expect(result.inconclusiveReason).toBe('quota-exhausted')
  })

  it('is inconclusive when the lookup was attempted but failed (network error)', () => {
    const result = classifyManifestEntryIdentity({
      entry: entry(),
      localContent: frontmatterContent,
      expectedRootDir: '/home/user/.claude/skills',
      registryLookup: { attempted: true, record: null, failureReason: 'network-error' },
    })
    expect(result.inconclusive).toBe(true)
    expect(result.inconclusiveReason).toBe('network-error')
  })

  it('is inconclusive when the lookup completed but found no registry record', () => {
    const result = classifyManifestEntryIdentity({
      entry: entry(),
      localContent: frontmatterContent,
      expectedRootDir: '/home/user/.claude/skills',
      registryLookup: { attempted: true, record: null },
    })
    expect(result.inconclusive).toBe(true)
    expect(result.inconclusiveReason).toBe('no-registry-record')
  })

  it('does not fire (and is not inconclusive) when local content has no parseable frontmatter', () => {
    const result = classifyManifestEntryIdentity({
      entry: entry(),
      localContent: 'plain content with no frontmatter',
      expectedRootDir: '/home/user/.claude/skills',
      registryLookup: { attempted: true, record: { author: 'wrsmith108', name: 'linear' } },
    })
    expect(result.signal).toBeNull()
    expect(result.inconclusive).toBe(false)
  })

  it('is a clean non-fire (not inconclusive) when id does not parse as owner/name — a raw-URL direct install has no registry key to check', () => {
    const result = classifyManifestEntryIdentity({
      entry: entry({
        id: 'https://github.com/owner-b/test-repo',
        source: 'github:owner-b/test-repo',
      }),
      localContent: frontmatterContent,
      expectedRootDir: '/home/user/.claude/skills',
      registryLookup: notAttempted,
    })
    expect(result.signal).toBeNull()
    expect(result.inconclusive).toBe(false)
  })

  it('signal 1 takes precedence over an inconclusive signal 2', () => {
    const result = classifyManifestEntryIdentity({
      entry: entry({ id: 'wrsmith108/linear', source: 'github:lobehub/lobehub' }),
      localContent: frontmatterContent,
      expectedRootDir: '/home/user/.claude/skills',
      registryLookup: notAttempted,
    })
    expect(result.signal).toBe('owner-mismatch')
    expect(result.inconclusive).toBe(false)
  })
})

describe('classifyDivergentEntry', () => {
  it('classifies as identity-mismatch when a signal fires', () => {
    const result = classifyDivergentEntry({
      entry: entry({ id: 'wrsmith108/linear', source: 'github:lobehub/lobehub' }),
      localHash: 'abc',
      localContent: 'content',
      expectedRootDir: '/home/user/.claude/skills',
      registryLookup: notAttempted,
    })
    expect(result.state).toBe('identity-mismatch')
    expect(result.signal).toBe('owner-mismatch')
  })

  it('classifies as unknown when signal 2 is inconclusive', () => {
    const result = classifyDivergentEntry({
      entry: entry(),
      localHash: 'abc',
      localContent: 'content',
      expectedRootDir: '/home/user/.claude/skills',
      registryLookup: { attempted: false, record: null, failureReason: 'offline' },
    })
    expect(result.state).toBe('unknown')
    expect(result.inconclusiveReason).toBe('offline')
  })

  it('classifies as local-drift when no signal fires but on-disk content diverges from the recorded hash', () => {
    const result = classifyDivergentEntry({
      entry: entry({ contentHash: 'recorded-hash' }),
      localHash: 'edited-hash',
      localContent: 'content',
      expectedRootDir: '/home/user/.claude/skills',
      registryLookup: { attempted: true, record: { author: 'wrsmith108', name: 'linear' } },
    })
    expect(result.state).toBe('local-drift')
    expect(result.signal).toBeNull()
  })

  it('classifies as outdated when no signal fires and no local edit is evidenced', () => {
    const result = classifyDivergentEntry({
      entry: entry(),
      localHash: 'installed-hash',
      localContent: 'content',
      expectedRootDir: '/home/user/.claude/skills',
      registryLookup: { attempted: true, record: { author: 'wrsmith108', name: 'linear' } },
    })
    expect(result.state).toBe('outdated')
  })
})

describe('classifyOutdatedState', () => {
  it('returns current without evaluating signals', () => {
    const result = classifyOutdatedState({
      comparisonOutcome: 'current',
      unknownReasonWhenComparisonUnknown: 'no-history',
      entry: entry({ id: 'wrsmith108/linear', source: 'github:lobehub/lobehub' }), // would fire if evaluated
      localHash: 'x',
      localContent: 'content',
      expectedRootDir: '/home/user/.claude/skills',
      registryLookup: notAttempted,
    })
    expect(result.state).toBe('current')
    expect(result.signal).toBeNull()
  })

  it('returns unknown with the caller-supplied reason when the comparison itself is unknown', () => {
    const result = classifyOutdatedState({
      comparisonOutcome: 'unknown',
      unknownReasonWhenComparisonUnknown: 'no-history',
      entry: entry(),
      localHash: null,
      localContent: null,
      expectedRootDir: '/home/user/.claude/skills',
      registryLookup: notAttempted,
    })
    expect(result.state).toBe('unknown')
    expect(result.inconclusiveReason).toBe('no-history')
  })

  it('delegates to classifyDivergentEntry for an outdated comparison outcome', () => {
    const result = classifyOutdatedState({
      comparisonOutcome: 'outdated',
      unknownReasonWhenComparisonUnknown: 'no-history',
      entry: entry(),
      localHash: 'installed-hash',
      localContent: 'content',
      expectedRootDir: '/home/user/.claude/skills',
      registryLookup: { attempted: true, record: { author: 'wrsmith108', name: 'linear' } },
    })
    expect(result.state).toBe('outdated')
  })
})
