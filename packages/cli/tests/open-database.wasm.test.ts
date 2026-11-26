/**
 * SMI-7260: `openCliDatabase` on the WASM driver.
 *
 * A file-backed WASM handle never writes to disk. The CLI's one database
 * opener must hand back a sealed handle on a first run (schema built in
 * memory), serve reads from an existing database, and refuse outright on an
 * older schema, where any command's writes would fail anyway. Fixtures are
 * written by the native driver; `SKILLSMITH_FORCE_WASM` selects WASM for the
 * open under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeDatabase,
  createDatabaseSync,
  DB_WASM_READ_ONLY_CODE,
  getSchemaVersion,
  initializeSchema,
  SCHEMA_VERSION,
  SkillRepository,
} from '@skillsmith/core'
import { openCliDatabase } from '../src/utils/open-database.js'

let dir: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smi7260-cli-'))
  vi.stubEnv('SKILLSMITH_QUIET', '1')
})

afterEach(() => {
  vi.unstubAllEnvs()
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function nativeSkillsDb(name: string, schemaVersion = SCHEMA_VERSION): string {
  const path = join(dir!, name)
  const db = createDatabaseSync(path)
  initializeSchema(db)
  new SkillRepository(db).create({
    id: 'probe/one',
    name: 'one',
    description: 'a testing helper',
    author: 'probe',
  })
  db.prepare('DELETE FROM schema_version WHERE version > ?').run(schemaVersion)
  db.close()
  return path
}

function codeOf(fn: () => unknown): unknown {
  try {
    fn()
    return 'no throw'
  } catch (error) {
    return (error as { code?: unknown }).code
  }
}

async function rejectionCode(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
    return 'resolved'
  } catch (error) {
    return (error as { code?: unknown }).code
  }
}

describe('SMI-7260: openCliDatabase seals every WASM handle it returns', () => {
  it('a first run: current schema in memory, writes refused, no file written', async () => {
    vi.stubEnv('SKILLSMITH_FORCE_WASM', 'true')
    const path = join(dir!, 'home', 'skills.db')
    const db = await openCliDatabase(path)
    try {
      expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION)
      expect(new SkillRepository(db).count()).toBe(0)
      expect(db.readonly).toBe(true)
      expect(
        codeOf(() =>
          new SkillRepository(db).create({ id: 'a/b', name: 'b', description: 'd', author: 'a' })
        )
      ).toBe(DB_WASM_READ_ONLY_CODE)
    } finally {
      closeDatabase(db)
    }
    expect(existsSync(path)).toBe(false)
  })

  it('an existing database at the current schema: reads work, writes are refused', async () => {
    const path = nativeSkillsDb('skills.db')
    const before = readFileSync(path)
    vi.stubEnv('SKILLSMITH_FORCE_WASM', 'true')
    const db = await openCliDatabase(path)
    try {
      expect(new SkillRepository(db).findById('probe/one')?.id).toBe('probe/one')
      expect(codeOf(() => new SkillRepository(db).delete('probe/one'))).toBe(DB_WASM_READ_ONLY_CODE)
    } finally {
      closeDatabase(db)
    }
    expect(readFileSync(path).equals(before)).toBe(true)
  })
})

describe('SMI-7260 test 9 (CLI): an older schema on the WASM driver is refused', () => {
  it('rejects with the named code and leaves the file untouched', async () => {
    const path = nativeSkillsDb('old.db', 10)
    const before = readFileSync(path)
    vi.stubEnv('SKILLSMITH_FORCE_WASM', 'true')
    expect(await rejectionCode(openCliDatabase(path))).toBe(DB_WASM_READ_ONLY_CODE)
    expect(readFileSync(path).equals(before)).toBe(true)
  })

  it('opens the same older database on the native driver and upgrades it (paired control)', async () => {
    const path = nativeSkillsDb('old-native.db', 10)
    const db = await openCliDatabase(path)
    try {
      expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION)
    } finally {
      closeDatabase(db)
    }
  })
})
