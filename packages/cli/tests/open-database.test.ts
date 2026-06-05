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
import { mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

describe('SMI-4484: openCliDatabase corrupt-DB self-heal', () => {
  let tempDir: string

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true })
  })

  it('recovers from a corrupt on-disk database by backing it up and rebuilding', async () => {
    tempDir = mkdtempSync(
      join(tmpdir(), `smi4484-cli-${Date.now()}-${Math.random().toString(36).slice(2)}-`)
    )
    const dbPath = join(tempDir, 'skills.db')
    // A corrupt file the WASM driver cannot read.
    writeFileSync(dbPath, Buffer.from('not a sqlite database — corrupt on-disk file'))

    const db = await openCliDatabase(dbPath)
    closeDatabase(db)

    // The corrupt file was backed up out of the way.
    const backups = readdirSync(tempDir).filter((f) => f.includes('.corrupt-'))
    expect(backups.length).toBe(1)

    // A fresh, schema-initialized DB was opened in its place.
    const reopened = await openCliDatabase(dbPath)
    expect(new SkillRepository(reopened).count()).toBe(0)
    closeDatabase(reopened)
  })
})
