/**
 * SMI-5178: unit tests for the pure search compatibility helpers.
 * No DB / context — fast, isolated from the seeded better-sqlite3 fixtures.
 */

import { describe, it, expect } from 'vitest'
import { type SkillSearchResult } from '@skillsmith/core'
import {
  filterByCompatibility,
  filterInstallable,
  resolveDefaultCompatibility,
  buildEmptySearchSuggestion,
} from './search.helpers.js'

function skill(id: string, compatibility?: string[], installable?: boolean): SkillSearchResult {
  return {
    id,
    name: id,
    description: '',
    author: 'test',
    category: 'development',
    trustTier: 'community',
    score: 50,
    ...(compatibility !== undefined ? { compatibility } : {}),
    ...(installable !== undefined ? { installable } : {}),
  }
}

describe('filterByCompatibility (SMI-5178)', () => {
  it('keeps rows tagged for a wanted tool', () => {
    const rows = [skill('a', ['windsurf']), skill('b', ['claude-code'])]
    const out = filterByCompatibility(rows, { ides: ['windsurf'] })
    expect(out.map((r) => r.id)).toEqual(['a'])
  })

  it('ALWAYS surfaces rows with [] / no compatibility (unknown ≠ incompatible)', () => {
    const rows = [skill('empty', []), skill('absent'), skill('other', ['claude-code'])]
    const out = filterByCompatibility(rows, { ides: ['windsurf'] })
    expect(out.map((r) => r.id)).toEqual(['empty', 'absent'])
  })

  it('unions ides + llms; empty filter is a no-op', () => {
    const rows = [skill('a', ['gpt-4o']), skill('b', ['cursor'])]
    expect(filterByCompatibility(rows, { ides: ['cursor'], llms: ['gpt-4o'] })).toHaveLength(2)
    expect(filterByCompatibility(rows, {})).toHaveLength(2)
  })
})

describe('filterInstallable (SMI-5178 regression guard)', () => {
  it('drops discovery-only rows only when installable_only is true', () => {
    const rows = [skill('a', undefined, true), skill('b', undefined, false)]
    expect(filterInstallable(rows, true).map((r) => r.id)).toEqual(['a'])
    expect(filterInstallable(rows, false)).toHaveLength(2)
    expect(filterInstallable(rows, undefined)).toHaveLength(2)
  })

  it('(C3) keeps a row with installable: null — null means unknown, not discovery-only', () => {
    // `installable` is a stored column frequently null for rows that DO have a repo_url.
    // Only explicit `false` marks a discovery-only entry.
    const rows = [skill('null-row'), skill('false-row', undefined, false)]
    // null-row has no installable key at all (undefined) — treated as installable.
    expect(filterInstallable(rows, true).map((r) => r.id)).toEqual(['null-row'])
  })

  it('(C3) drops a row with installable: false, keeps installable: true and absent', () => {
    const rows = [
      skill('true-row', undefined, true),
      skill('false-row', undefined, false),
      skill('absent-row'), // no installable key
    ]
    const out = filterInstallable(rows, true).map((r) => r.id)
    expect(out).toContain('true-row')
    expect(out).toContain('absent-row')
    expect(out).not.toContain('false-row')
  })
})

describe('resolveDefaultCompatibility (SMI-5178)', () => {
  it('returns undefined for an unset / empty client (permissive)', () => {
    expect(resolveDefaultCompatibility(undefined)).toBeUndefined()
    expect(resolveDefaultCompatibility('')).toBeUndefined()
    expect(resolveDefaultCompatibility('   ')).toBeUndefined()
  })

  it('maps a known client to its compatibility slug', () => {
    expect(resolveDefaultCompatibility('windsurf')).toEqual({ ides: ['windsurf'] })
    expect(resolveDefaultCompatibility('claude-code')).toEqual({ ides: ['claude-code'] })
  })

  it('maps the agents (Codex) client to the codex slug', () => {
    expect(resolveDefaultCompatibility('agents')).toEqual({ ides: ['codex'] })
  })

  it('returns undefined for an unknown client (no silent mis-restriction)', () => {
    expect(resolveDefaultCompatibility('emacs')).toBeUndefined()
  })
})

describe('buildEmptySearchSuggestion (SMI-5556)', () => {
  it('explains lexical-only matching and single-topic guidance with no hidden counts', () => {
    const out = buildEmptySearchSuggestion({})
    expect(out).toContain('keyword-based (not semantic)')
    expect(out).toContain('single-topic query')
    expect(out).not.toContain('discovery-only')
    expect(out).not.toContain('compatibility filter')
  })

  it('mentions installable_only: false only when discoveryOnlyHidden > 0', () => {
    const out = buildEmptySearchSuggestion({ discoveryOnlyHidden: 3 })
    expect(out).toContain('3 discovery-only result(s)')
    expect(out).toContain('installable_only: false')
  })

  it('omits the discovery-only hint when discoveryOnlyHidden is 0', () => {
    const out = buildEmptySearchSuggestion({ discoveryOnlyHidden: 0 })
    expect(out).not.toContain('discovery-only')
  })

  it('mentions compatible_with only when compatibilityHidden > 0', () => {
    const out = buildEmptySearchSuggestion({ compatibilityHidden: 2 })
    expect(out).toContain('2 result(s) were hidden by a compatibility filter')
    expect(out).toContain('compatible_with')
  })

  it('includes both hints when both counts are set', () => {
    const out = buildEmptySearchSuggestion({ discoveryOnlyHidden: 1, compatibilityHidden: 1 })
    expect(out).toContain('discovery-only')
    expect(out).toContain('compatibility filter')
  })
})
