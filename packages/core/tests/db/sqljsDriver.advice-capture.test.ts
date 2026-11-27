/**
 * SMI-7271: a sql.js handle captures its native-driver advice when it opens,
 * and every later render for it uses that captured value.
 *
 * The advice source is replaced with a mutable stub so the test can change
 * what a fresh lookup would say after the handle is open. The database file is
 * real, written by the native driver, and opened through the real sql.js driver.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NativeDriverAdvice } from '../../src/db/drivers/native-driver-advice.js'

const live = vi.hoisted(() => ({
  advice: { kind: 'rebuild' } as NativeDriverAdvice,
}))

vi.mock('../../src/db/drivers/native-driver-advice.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/db/drivers/native-driver-advice.js')>()
  return { ...actual, nativeDriverAdvice: () => live.advice }
})

import { createSqlJsDatabase } from '../../src/db/drivers/sqljsDriver.js'
import { createBetterSqlite3Database } from '../../src/db/drivers/betterSqlite3Driver.js'
import { initializeSchema, LATEST_SCHEMA_VERSION } from '../../src/db/schema.js'
import { readOnlyWriteError } from '../../src/repositories/read-only-guard.js'
import { DB_WASM_READ_ONLY_CODE } from '../../src/db/db-errors.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smi7271-capture-'))
  live.advice = { kind: 'rebuild' }
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

function nativeDb(schemaVersion?: number): string {
  const path = join(dir, 'skills.db')
  const db = createBetterSqlite3Database(path)
  initializeSchema(db)
  if (schemaVersion !== undefined) {
    db.prepare('DELETE FROM schema_version WHERE version > ?').run(schemaVersion)
  }
  db.close()
  return path
}

function refusal(fn: () => unknown): Error {
  try {
    fn()
  } catch (error) {
    expect((error as { code?: unknown }).code).toBe(DB_WASM_READ_ONLY_CODE)
    return error as Error
  }
  throw new Error('expected the write to be refused')
}

describe('SMI-7271: advice captured at open', () => {
  it('a later change to what the package lookup says does not change this handle', async () => {
    const db = await createSqlJsDatabase(nativeDb())
    // Opened while the lookup said "rebuild"; now it would say "no-prebuilt".
    live.advice = { kind: 'no-prebuilt', target: 'freebsd-x64' }

    const renders = {
      openNotice: db.openNotice ?? '',
      readOnlyReason: db.readOnlyReason ?? '',
      driverRefusal: refusal(() => db.exec('CREATE TABLE smi7271_probe (x)')).message,
      guardRefusal: readOnlyWriteError(db).message,
    }
    for (const [surface, text] of Object.entries(renders)) {
      expect(text, surface).toContain('npm rebuild better-sqlite3')
      expect(text, surface).not.toContain('freebsd-x64')
    }
    db.close()
  })

  it('SKILLSMITH_FORCE_WASM is captured too: unsetting it later changes nothing', async () => {
    vi.stubEnv('SKILLSMITH_FORCE_WASM', 'true')
    const db = await createSqlJsDatabase(nativeDb())
    vi.unstubAllEnvs()

    expect(db.openNotice).toContain('Unset SKILLSMITH_FORCE_WASM')
    expect(db.readOnlyReason).toContain('Unset SKILLSMITH_FORCE_WASM')
    expect(refusal(() => db.exec('CREATE TABLE smi7271_probe (x)')).message).toContain(
      'SKILLSMITH_FORCE_WASM is set'
    )
    db.close()
  })

  it('the initializeSchema refusal on an older schema uses the captured advice', async () => {
    const db = await createSqlJsDatabase(nativeDb(LATEST_SCHEMA_VERSION - 1))
    live.advice = { kind: 'no-prebuilt', target: 'freebsd-x64' }

    const text = refusal(() => initializeSchema(db)).message
    expect(text).toContain('cannot be upgraded while it is read-only')
    expect(text).toContain('npm rebuild better-sqlite3')
    expect(text).not.toContain('freebsd-x64')
    db.close()
  })

  it('a :memory: handle captures nothing and has no notice', async () => {
    const db = await createSqlJsDatabase(':memory:')
    expect(db.nativeAdvice).toBeUndefined()
    expect(db.openNotice).toBeUndefined()
    db.close()
  })
})
