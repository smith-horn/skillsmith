/**
 * SMI-4484 / SMI-4807: SQLite corruption self-heal + native-driver failure capture
 *
 * Covers:
 * - isCorruptionError predicate (true for corruption-class messages, false otherwise)
 * - backupCorruptDbFile renames the bad file out of the way
 * - createSqlJsDatabase self-heals when handed a corrupt on-disk file
 * - getBetterSqlite3FailureReason returns a string after a forced failure
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isCorruptionError, backupCorruptDbFile } from '../../src/db/drivers/corruption.js'
import { createSqlJsDatabase } from '../../src/db/drivers/sqljsDriver.js'
import {
  isBetterSqlite3Available,
  getBetterSqlite3FailureReason,
} from '../../src/db/drivers/betterSqlite3Driver.js'

/** Create a unique temp directory for filesystem-touching tests. */
function makeTempDir(): string {
  return mkdtempSync(
    join(tmpdir(), `smi4484-${Date.now()}-${Math.random().toString(36).slice(2)}-`)
  )
}

describe('isCorruptionError', () => {
  it('returns true for "database disk image is malformed"', () => {
    expect(isCorruptionError(new Error('database disk image is malformed'))).toBe(true)
  })

  it('returns true for "file is not a database"', () => {
    expect(isCorruptionError(new Error('file is not a database'))).toBe(true)
  })

  it('returns true for an SQLITE_CORRUPT error', () => {
    expect(isCorruptionError(new Error('SQLITE_CORRUPT: database is corrupt'))).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isCorruptionError(new Error('DATABASE DISK IMAGE IS MALFORMED'))).toBe(true)
  })

  it('accepts a plain string', () => {
    expect(isCorruptionError('file is not a database')).toBe(true)
  })

  it('returns false for unrelated errors', () => {
    expect(isCorruptionError(new Error('no such table: cache'))).toBe(false)
    expect(isCorruptionError(new Error('ENOENT: no such file or directory'))).toBe(false)
    expect(isCorruptionError(new Error('connection timed out'))).toBe(false)
  })

  it('returns false for non-error values', () => {
    expect(isCorruptionError(undefined)).toBe(false)
    expect(isCorruptionError(null)).toBe(false)
    expect(isCorruptionError(42)).toBe(false)
  })
})

describe('backupCorruptDbFile', () => {
  let tempDir: string

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true })
  })

  it('renames the corrupt file to a timestamped .corrupt-* path', () => {
    tempDir = makeTempDir()
    const dbPath = join(tempDir, 'skills.db')
    writeFileSync(dbPath, 'garbage')

    const backupPath = backupCorruptDbFile(dbPath)

    expect(backupPath).toMatch(/skills\.db\.corrupt-/)
    expect(existsSync(dbPath)).toBe(false)
    expect(existsSync(backupPath)).toBe(true)
  })

  it('throws for an in-memory path', () => {
    expect(() => backupCorruptDbFile(':memory:')).toThrow(/in-memory/)
  })

  it('throws when the file does not exist', () => {
    tempDir = makeTempDir()
    expect(() => backupCorruptDbFile(join(tempDir, 'missing.db'))).toThrow(/does not exist/)
  })
})

describe('createSqlJsDatabase — corrupt-DB self-heal (SMI-4484)', () => {
  let tempDir: string

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true })
  })

  it('does not throw on a corrupt file, backs it up, and returns a usable empty DB', async () => {
    tempDir = makeTempDir()
    const dbPath = join(tempDir, 'skills.db')
    // Write garbage bytes — not a valid SQLite file.
    writeFileSync(dbPath, Buffer.from('this is definitely not a sqlite database file'))

    const db = await createSqlJsDatabase(dbPath)

    // A backup file should now exist alongside the (rebuilt) database.
    const backups = readdirSync(tempDir).filter((f) => f.includes('.corrupt-'))
    expect(backups.length).toBe(1)

    // The returned database is usable and empty.
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')
    db.prepare('INSERT INTO t (name) VALUES (?)').run('hello')
    const row = db.prepare<{ name: string }>('SELECT name FROM t WHERE id = 1').get()
    expect(row?.name).toBe('hello')

    db.close()
  })
})

describe('getBetterSqlite3FailureReason — SMI-4807', () => {
  it('returns undefined or a string consistent with native availability', () => {
    const available = isBetterSqlite3Available()
    const reason = getBetterSqlite3FailureReason()

    if (available) {
      // Native loaded — no failure reason retained.
      expect(reason).toBeUndefined()
    } else {
      // Native unavailable — a human-readable reason must be captured.
      expect(typeof reason).toBe('string')
      expect((reason ?? '').length).toBeGreaterThan(0)
    }
  })
})
