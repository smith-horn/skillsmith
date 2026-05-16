/**
 * @fileoverview Unit tests for `skillsmith search` empty-index hinting.
 * @see SMI-4926
 *
 * A 0-result search against an EMPTY local index (not yet synced) must surface
 * an actionable, sync-state-aware hint instead of the bare "no skills found
 * matching your criteria" message used for a genuine no-match.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SearchService, SkillRepository, SyncHistoryRepository } from '@skillsmith/core'
import { createTestDatabase, closeDatabase } from '@skillsmith/core/testkit'
import type { Database as DatabaseType } from '@skillsmith/core'
import { displayResults } from './search-formatters.js'
import { isLocalIndexEmpty, formatEmptyIndexHint, AUTO_SYNC_COOLDOWN_MS } from './search.helpers.js'

// ============================================================================
// Helpers
// ============================================================================

const NO_MATCH_SUBSTRING = 'matching your criteria'
const HINT_MARKER = 'ℹ'

/** Strip ANSI color codes so newline-padding assertions are color-agnostic. */
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

/**
 * Record a sync attempt and force its `started_at` to a given ISO timestamp,
 * since SyncHistoryRepository.startRun() always stamps "now".
 */
function seedSyncAttempt(db: DatabaseType, startedAt: string): void {
  const id = new SyncHistoryRepository(db).startRun()
  db.prepare('UPDATE sync_history SET started_at = ? WHERE id = ?').run(startedAt, id)
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
// Tests — search output: empty vs no-match vs match
// ============================================================================

describe('search — empty-index hinting (SMI-4926)', () => {
  let db: DatabaseType

  beforeEach(async () => {
    db = await createTestDatabase()
  })

  afterEach(() => {
    closeDatabase(db)
  })

  it('empty index + query → shows the hint, not the bare no-match message', () => {
    const results = new SearchService(db).search({ query: 'anything', limit: 20 })
    expect(results.items).toHaveLength(0)
    expect(isLocalIndexEmpty(db)).toBe(true)

    const output = captureOutput(() => {
      if (results.items.length === 0 && isLocalIndexEmpty(db)) {
        console.log(formatEmptyIndexHint(db))
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
        console.log(formatEmptyIndexHint(db))
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
        console.log(formatEmptyIndexHint(db))
      } else {
        displayResults(results.items, results.total, 0, 20)
      }
    })

    expect(output).toContain('auth-helper')
    expect(output).not.toContain(HINT_MARKER)
    expect(output).not.toContain(NO_MATCH_SUBSTRING)
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
// Tests — formatEmptyIndexHint (sync-state aware)
// ============================================================================

describe('formatEmptyIndexHint (SMI-4926)', () => {
  let db: DatabaseType

  beforeEach(async () => {
    db = await createTestDatabase()
  })

  afterEach(() => {
    closeDatabase(db)
  })

  it('no recent sync attempt → "run `skillsmith sync`" wording with the ℹ prefix', () => {
    const hint = formatEmptyIndexHint(db)
    expect(hint).toContain(HINT_MARKER)
    expect(hint).toContain('skillsmith sync')
    expect(hint).not.toContain('in progress')
  })

  it('stale sync attempt (outside cooldown) → still "run `skillsmith sync`" wording', () => {
    const stale = new Date(Date.now() - AUTO_SYNC_COOLDOWN_MS - 60_000).toISOString()
    seedSyncAttempt(db, stale)

    const hint = formatEmptyIndexHint(db)
    expect(hint).toContain(HINT_MARKER)
    expect(hint).toContain('skillsmith sync')
    expect(hint).not.toContain('in progress')
  })

  it('recent sync attempt (within cooldown) → "in progress" wording with the ℹ prefix', () => {
    const recent = new Date(Date.now() - 60_000).toISOString()
    seedSyncAttempt(db, recent)

    const hint = formatEmptyIndexHint(db)
    expect(hint).toContain(HINT_MARKER)
    expect(hint).toContain('in progress')
    expect(hint).not.toContain('skillsmith sync')
  })

  it('both wordings carry leading and trailing newlines for displayResults padding', () => {
    const noAttempt = stripAnsi(formatEmptyIndexHint(db))
    expect(noAttempt.startsWith('\n')).toBe(true)
    expect(noAttempt.endsWith('\n')).toBe(true)

    seedSyncAttempt(db, new Date(Date.now() - 60_000).toISOString())
    const recent = stripAnsi(formatEmptyIndexHint(db))
    expect(recent.startsWith('\n')).toBe(true)
    expect(recent.endsWith('\n')).toBe(true)
  })
})
