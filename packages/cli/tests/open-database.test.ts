/**
 * @fileoverview Tests for the shared CLI database opener.
 * @see SMI-4917 — Bug 1: `search` crashed with `no such table: cache` on a
 *   fresh DB because it used the bare `createDatabaseAsync` factory without
 *   `initializeSchema`.
 *
 * The regression guard: a DB opened via `openCliDatabase` must be fully
 * schema-initialized so `SearchService` (which queries the `cache` table) does
 * not throw on a brand-new database.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { SearchService, SkillRepository, closeDatabase, type DatabaseType } from '@skillsmith/core'
import { openCliDatabase } from '../src/utils/open-database.js'

describe('SMI-4917 Bug 1: openCliDatabase', () => {
  const opened: DatabaseType[] = []

  afterEach(() => {
    for (const db of opened) closeDatabase(db)
    opened.length = 0
  })

  async function open(): Promise<DatabaseType> {
    const db = await openCliDatabase(':memory:')
    opened.push(db)
    return db
  }

  it('returns a fully schema-initialized database', async () => {
    const db = await open()
    // The `cache` table only exists once the schema is initialized.
    const cacheTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cache'")
      .get()
    expect(cacheTable).toBeDefined()
  })

  it('a fresh search no longer throws `no such table: cache`', async () => {
    const db = await open()
    const search = new SearchService(db)
    // Before the fix, SearchService.search() crashed here on a bare DB.
    expect(() => search.search({ query: 'mcp', limit: 10 })).not.toThrow()
  })

  it('search on a fresh DB returns an empty result set, not an error', async () => {
    const db = await open()
    const search = new SearchService(db)
    const results = search.search({ query: 'anything', limit: 10 })
    expect(results.items).toEqual([])
    expect(results.total).toBe(0)
  })

  it('the skills table is queryable on a fresh DB', async () => {
    const db = await open()
    expect(new SkillRepository(db).count()).toBe(0)
  })
})
