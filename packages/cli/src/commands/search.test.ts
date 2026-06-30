/**
 * @fileoverview Unit tests for `skillsmith search` helpers.
 *
 * SMI-5427: autoSyncIfEmpty is removed (remote-default). Tests updated:
 *   - formatEmptyIndexHint now reflects offline-unavailable message (no
 *     sync hint, no SyncHistoryRepository dependency).
 *   - isLocalIndexEmpty behavior unchanged.
 *   - empty-index hinting now means remote is also offline.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SearchService, SkillRepository } from '@skillsmith/core'
import { createTestDatabase, closeDatabase } from '@skillsmith/core/testkit'
import type { Database as DatabaseType } from '@skillsmith/core'
import { displayResults } from './search-formatters.js'
import { isLocalIndexEmpty, formatEmptyIndexHint } from './search.helpers.js'

// ============================================================================
// Helpers
// ============================================================================

const NO_MATCH_SUBSTRING = 'matching your criteria'
const HINT_MARKER = 'ℹ'
const OFFLINE_HINT_SUBSTRING = 'offline'

/** Strip ANSI color codes so assertions are color-agnostic. */
const ANSI_RE = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g')
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

/** Seed one skill so the local index is non-empty. */
function seedSkill(db: DatabaseType): void {
  new SkillRepository(db).create({
    id: 'community/auth-helper',
    name: 'auth-helper',
    description: 'Authentication helper skill',
    author: 'community',
    trustTier: 'community',
    tags: ['authentication'],
  })
}

/** Capture console.log output produced by `fn`. */
function captureOutput(fn: () => void): string {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]): void => {
    lines.push(args.map((a) => String(a)).join(' '))
  }
  try {
    fn()
  } finally {
    console.log = original
  }
  return lines.join('\n')
}

// ============================================================================
// Tests — formatEmptyIndexHint
// ============================================================================

describe('formatEmptyIndexHint (SMI-5427)', () => {
  it('carries leading and trailing newlines for displayResults padding', () => {
    const hint = stripAnsi(formatEmptyIndexHint())
    expect(hint.startsWith('\n')).toBe(true)
    expect(hint.endsWith('\n')).toBe(true)
  })

  it('contains the ℹ marker', () => {
    expect(formatEmptyIndexHint()).toContain(HINT_MARKER)
  })

  it('contains offline-relevant wording (not sync push)', () => {
    const hint = stripAnsi(formatEmptyIndexHint())
    expect(hint).toContain(OFFLINE_HINT_SUBSTRING)
    // SMI-5427: must NOT push skillsmith sync (sync requires connectivity too)
    expect(hint).not.toContain('skillsmith sync')
  })
})

// ============================================================================
// Tests — isLocalIndexEmpty (pure given a db)
// ============================================================================

describe('isLocalIndexEmpty (SMI-4926)', () => {
  let db: DatabaseType

  beforeEach(async () => {
    db = await createTestDatabase()
  })

  afterEach(() => {
    closeDatabase(db)
  })

  it('returns true for a fresh DB with no skills', () => {
    expect(isLocalIndexEmpty(db)).toBe(true)
  })

  it('returns false once a skill is present', () => {
    seedSkill(db)
    expect(isLocalIndexEmpty(db)).toBe(false)
  })
})

// ============================================================================
// Tests — search output: empty vs no-match vs match
// ============================================================================

describe('search display — empty vs no-match vs match (SMI-4926)', () => {
  let db: DatabaseType

  beforeEach(async () => {
    db = await createTestDatabase()
  })

  afterEach(() => {
    closeDatabase(db)
  })

  it('empty index + query → shows offline/empty hint, not the bare no-match message', () => {
    const results = new SearchService(db).search({ query: 'anything', limit: 20 })
    expect(results.items).toHaveLength(0)
    expect(isLocalIndexEmpty(db)).toBe(true)

    const output = captureOutput(() => {
      if (results.items.length === 0 && isLocalIndexEmpty(db)) {
        console.log(formatEmptyIndexHint())
      } else {
        displayResults(results.items, results.total, 0, 20)
      }
    })

    expect(output).toContain(HINT_MARKER)
    expect(output).not.toContain(NO_MATCH_SUBSTRING)
  })

  it('populated index + no-match query → shows the bare no-match message, not the hint', () => {
    seedSkill(db)
    const results = new SearchService(db).search({ query: 'zzz-nonexistent-zzz', limit: 20 })
    expect(results.items).toHaveLength(0)
    expect(isLocalIndexEmpty(db)).toBe(false)

    const output = captureOutput(() => {
      if (results.items.length === 0 && isLocalIndexEmpty(db)) {
        console.log(formatEmptyIndexHint())
      } else {
        displayResults(results.items, results.total, 0, 20)
      }
    })

    expect(output).toContain(NO_MATCH_SUBSTRING)
    expect(output).not.toContain(HINT_MARKER)
  })

  it('populated index + matching query → renders results, no hint', () => {
    seedSkill(db)
    const results = new SearchService(db).search({ query: 'auth', limit: 20 })
    expect(results.items.length).toBeGreaterThan(0)

    const output = captureOutput(() => {
      if (results.items.length === 0 && isLocalIndexEmpty(db)) {
        console.log(formatEmptyIndexHint())
      } else {
        displayResults(results.items, results.total, 0, 20)
      }
    })

    expect(output).toContain('auth-helper')
    expect(output).not.toContain(HINT_MARKER)
    expect(output).not.toContain(NO_MATCH_SUBSTRING)
  })
})
