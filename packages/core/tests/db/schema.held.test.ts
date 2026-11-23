/**
 * SMI-7260: schema initialization and migrations on a WASM handle another
 * process holds (read-only for the session).
 *
 * At the current schema there is nothing to do, so both must step aside and
 * let reads work — `initializeSchema`'s no-op `INSERT OR IGNORE` stamp would
 * otherwise be refused and turn every read command into a failure. Behind the
 * current schema, `initializeSchema` must refuse with the named error, and
 * `runMigrationsSafe` (the MCP server's path) must say plainly that the
 * database is read-only rather than warn that each migration "failed".
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBetterSqlite3Database } from '../../src/db/drivers/betterSqlite3Driver.js'
import { initializeSchema, openDatabaseAsync } from '../../src/db/schema.js'
import { createDatabaseAsync } from '../../src/db/createDatabase.js'
import { isDatabaseHeldElsewhereError } from '../../src/db/db-errors.js'
import type { Database } from '../../src/db/database-interface.js'

describe('schema on a held WASM handle (SMI-7260)', () => {
  let dir: string
  let path: string
  const open: Database[] = []
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'schema-held-'))
    path = join(dir, 'skills.db')
    vi.stubEnv('SKILLSMITH_FORCE_WASM', 'true')
    vi.stubEnv('SKILLSMITH_QUIET', '')
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    for (const db of open.splice(0)) {
      try {
        if (db.open) db.close()
      } catch {
        // nothing more to free
      }
    }
    warn.mockRestore()
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })

  /** Hold a current-schema database open natively; optionally one version behind. */
  function holdSchema(behind: boolean): void {
    const native = createBetterSqlite3Database(path)
    open.push(native)
    initializeSchema(native)
    if (behind) {
      native.exec(
        'DELETE FROM schema_version WHERE version = (SELECT MAX(version) FROM schema_version)'
      )
    }
    native.pragma('wal_checkpoint(TRUNCATE)') // sql.js reads only the main file
  }

  function warnings(): string[] {
    return warn.mock.calls.map((call: unknown[]) => String(call[0]))
  }

  it('openDatabaseAsync at the current schema: opens, reads, warns of no migration', async () => {
    holdSchema(false)
    const db = await openDatabaseAsync(path)
    open.push(db)
    expect(
      (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v
    ).toBeGreaterThan(1)
    expect(warnings().filter((m) => m.includes('Migration'))).toEqual([])
    expect(warnings().filter((m) => m.includes('was not upgraded'))).toEqual([])
  })

  it('openDatabaseAsync behind the schema: one plain read-only line, no "Migration N failed"', async () => {
    holdSchema(true)
    const db = await openDatabaseAsync(path)
    open.push(db)
    expect(warnings().filter((m) => m.includes('Migration'))).toEqual([])
    const plain = warnings().filter((m) => m.includes('was not upgraded because the database is'))
    expect(plain).toHaveLength(1)
    expect(plain[0]).toContain('read-only for this session')
  })

  it('initializeSchema at the current schema is a no-op; behind it, the named refusal', async () => {
    holdSchema(false)
    const current = await createDatabaseAsync(path)
    open.push(current)
    expect(() => initializeSchema(current)).not.toThrow()
    // Paired presence: the handle really is the held, read-only one.
    expect((current as { readOnlyReason?: string }).readOnlyReason).toBeDefined()
    current.close()

    const native = open[0]
    native.exec(
      'DELETE FROM schema_version WHERE version = (SELECT MAX(version) FROM schema_version)'
    )
    native.pragma('wal_checkpoint(TRUNCATE)')
    const behind = await createDatabaseAsync(path)
    open.push(behind)
    let refusal: unknown
    try {
      initializeSchema(behind)
    } catch (error) {
      refusal = error
    }
    expect(isDatabaseHeldElsewhereError(refusal)).toBe(true)
  })
})
