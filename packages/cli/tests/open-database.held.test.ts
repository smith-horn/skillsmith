/**
 * @fileoverview `openCliDatabase` on a database another process holds (SMI-7260).
 *
 * The WASM (sql.js) driver opens such a database read-only for the session. If
 * `openCliDatabase` then ran schema initialization, its no-op `INSERT OR
 * IGNORE` stamp would be refused, and every command that opens the database —
 * read commands included — would fail. These tests drive the real native
 * driver as the holder and the real WASM driver (via SKILLSMITH_FORCE_WASM)
 * through `openCliDatabase`, with no mocks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createDatabaseSync,
  initializeSchema,
  isDatabaseHeldElsewhereError,
  SearchService,
  SkillRepository,
  SyncConfigRepository,
  SyncHistoryRepository,
  type DatabaseType,
} from '@skillsmith/core'
import { openCliDatabase } from '../src/utils/open-database.js'

/** The error `fn` threw, or `undefined`; recorded, then asserted. */
function attempt(fn: () => unknown): unknown {
  try {
    fn()
    return undefined
  } catch (error) {
    return error
  }
}

describe('openCliDatabase on a held database (SMI-7260)', () => {
  let dir: string
  let path: string
  const open: DatabaseType[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-open-held-'))
    path = join(dir, 'skills.db')
    vi.stubEnv('SKILLSMITH_FORCE_WASM', 'true')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    for (const db of open.splice(0)) {
      try {
        if (db.open) db.close()
      } catch {
        // nothing more to free
      }
    }
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * A native connection with the full current schema and one skill
   * checkpointed into the main file, holding the database open (WAL mode, so
   * `-wal`/`-shm` exist) with a second skill in the WAL only.
   */
  function holdCurrentSchema(): DatabaseType {
    const native = createDatabaseSync(path)
    initializeSchema(native)
    native.pragma('wal_autocheckpoint = 0')
    new SkillRepository(native).create({ id: 'acme/checkpointed', name: 'checkpointed' })
    native.pragma('wal_checkpoint(TRUNCATE)')
    new SkillRepository(native).create({ id: 'acme/wal-only', name: 'wal-only' })
    return native
  }

  it('opens for reading: queries work and a write is refused with the named error', async () => {
    open.push(holdCurrentSchema())

    const db = await openCliDatabase(path)
    open.push(db)

    // A read command's queries: `info`'s lookup, `search`'s local fallback
    // (which writes its cache — skipped on a read-only handle), and `sync
    // status` (whose config repository seeds a default row — also skipped).
    const repo = new SkillRepository(db)
    expect(repo.findById('acme/checkpointed')?.name).toBe('checkpointed')
    expect(repo.count()).toBe(1)
    const found = new SearchService(db).search({ query: 'checkpointed' })
    expect(found.items.map((r) => r.skill.id)).toEqual(['acme/checkpointed'])
    expect(new SyncConfigRepository(db).getConfig().id).toBe('default')
    expect(new SyncHistoryRepository(db).getStats().totalRuns).toBe(0)

    const refusal = attempt(() => repo.create({ id: 'acme/new', name: 'new' }))
    expect(isDatabaseHeldElsewhereError(refusal)).toBe(true)
  })

  it('refuses with the named error when the schema is not current', async () => {
    const native = holdCurrentSchema()
    open.push(native)
    // Make the held schema look one version behind.
    native.exec(
      'DELETE FROM schema_version WHERE version = (SELECT MAX(version) FROM schema_version)'
    )
    native.pragma('wal_checkpoint(TRUNCATE)') // sql.js reads only the main file

    let opened: DatabaseType | undefined
    let failure: unknown
    try {
      opened = await openCliDatabase(path)
    } catch (error) {
      failure = error
    }
    if (opened) open.push(opened)

    expect(opened).toBeUndefined()
    expect(isDatabaseHeldElsewhereError(failure)).toBe(true)
  })
})
