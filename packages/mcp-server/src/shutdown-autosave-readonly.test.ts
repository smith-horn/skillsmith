/**
 * @fileoverview Periodic autosave on a read-only WASM handle (SMI-7260).
 *
 * The WASM driver makes a handle read-only when another process may hold the
 * database (sidecars at open) or changed it after this handle read it (found
 * at a save). Autosave must then stop: calling `persist()` every interval would
 * refuse each time and log a false "recent writes may not survive" error.
 *
 * Real drivers: native better-sqlite3 as the other process, the WASM driver
 * (SKILLSMITH_FORCE_WASM) as the server's handle. Only the logger is mocked, as
 * in shutdown-coordinator.test.ts, so what was logged can be asserted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabaseAsync, createDatabaseSync, type DatabaseType } from '@skillsmith/core'
import {
  persistDbIfSupported,
  startPeriodicFlush,
  stopPeriodicFlush,
  _resetShutdownGuardForTests,
} from './shutdown.js'

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

vi.mock('@skillsmith/core/logging', () => ({
  createLogger: vi.fn(() => mockLogger),
}))

const CREATE_T = 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)'

describe('autosave on a read-only WASM handle (SMI-7260)', () => {
  let dir: string
  let path: string
  const open: DatabaseType[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-autosave-ro-'))
    path = join(dir, 'skills.db')
    vi.stubEnv('SKILLSMITH_FORCE_WASM', 'true')
    vi.stubEnv('SKILLSMITH_AUTOSAVE_DISABLE', '')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockLogger.error.mockClear()
    mockLogger.warn.mockClear()
    _resetShutdownGuardForTests()
  })

  afterEach(() => {
    stopPeriodicFlush()
    vi.useRealTimers()
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

  function readOnlyReason(db: DatabaseType): string | undefined {
    return (db as { readOnlyReason?: string }).readOnlyReason
  }

  it('held at start: never persists, never logs an error, says so once', async () => {
    const native = createDatabaseSync(path)
    open.push(native)
    native.pragma('journal_mode = WAL')
    native.exec(CREATE_T)
    native.prepare("INSERT INTO t (v) VALUES ('native')").run()
    const inodeBefore = statSync(path).ino
    const bytesBefore = readFileSync(path)

    const db = await createDatabaseAsync(path)
    open.push(db)
    expect(readOnlyReason(db)).toBeDefined()

    vi.useFakeTimers()
    vi.stubEnv('SKILLSMITH_AUTOSAVE_INTERVAL_MS', '1000')
    startPeriodicFlush(() => db)
    vi.advanceTimersByTime(5000)
    persistDbIfSupported(() => db)
    persistDbIfSupported(() => db)

    expect(statSync(path).ino).toBe(inodeBefore)
    expect(readFileSync(path).equals(bytesBefore)).toBe(true)
    expect(mockLogger.error).not.toHaveBeenCalled()
    expect(mockLogger.warn).toHaveBeenCalledTimes(1)
    expect(String(mockLogger.warn.mock.calls[0][0])).toContain('Autosave is off for this session')
  })

  it('changed mid-session: the refused save is a warning, then autosave stops', async () => {
    const seed = createDatabaseSync(path)
    seed.pragma('journal_mode = WAL')
    seed.exec(CREATE_T)
    seed.close()

    const db = await createDatabaseAsync(path)
    open.push(db)
    expect(readOnlyReason(db)).toBeUndefined()
    db.prepare("INSERT INTO t (v) VALUES ('wasm')").run()

    // Another process writes and closes after the server's handle read the file.
    const other = createDatabaseSync(path)
    other.prepare("INSERT INTO t (v) VALUES ('native')").run()
    other.close()
    // Precondition: nothing for the sidecar check to see, so only the file's
    // changed identity can stop the save.
    expect(existsSync(`${path}-wal`) || existsSync(`${path}-shm`)).toBe(false)
    const inodeBefore = statSync(path).ino
    const bytesBefore = readFileSync(path)

    persistDbIfSupported(() => db)
    persistDbIfSupported(() => db)
    persistDbIfSupported(() => db)

    expect(statSync(path).ino).toBe(inodeBefore)
    expect(readFileSync(path).equals(bytesBefore)).toBe(true)
    const check = createDatabaseSync(path)
    open.push(check)
    expect(check.prepare('SELECT v FROM t').all()).toEqual([{ v: 'native' }])

    expect(mockLogger.error).not.toHaveBeenCalled()
    expect(mockLogger.warn).toHaveBeenCalledTimes(1)
    expect(String(mockLogger.warn.mock.calls[0][0])).toContain('Autosave did not write it')
    expect(readOnlyReason(db)).toBeDefined()
  })
})
