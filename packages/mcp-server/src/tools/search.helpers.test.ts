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
