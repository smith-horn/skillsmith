/**
 * SMI-7260: callers of a read-only WASM handle.
 *
 * Fixtures are written by the native driver (better-sqlite3), the way a real
 * `skills.db` is; the code under test opens them on the WASM driver through
 * the same entry points production uses (`SKILLSMITH_FORCE_WASM` selects it).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabaseAsync as createBareDatabaseAsync } from '../../src/db/createDatabase.js'
import { createSqlJsDatabase } from '../../src/db/drivers/sqljsDriver.js'
import { createBetterSqlite3Database } from '../../src/db/drivers/betterSqlite3Driver.js'
import { DB_WASM_READ_ONLY_CODE } from '../../src/db/db-errors.js'
import {
  createDatabaseAsync,
  getSchemaVersion,
  initializeSchema,
  LATEST_SCHEMA_VERSION,
  openDatabaseAsync,
  SCHEMA_VERSION,
} from '../../src/db/schema.js'
import { SkillRepository } from '../../src/repositories/SkillRepository.js'
import { SearchService } from '../../src/services/SearchService.js'
import { QuarantineRepository } from '../../src/repositories/quarantine/QuarantineRepository.js'
import { ApprovalRepository } from '../../src/repositories/quarantine/ApprovalRepository.js'
import type { Database } from '../../src/db/database-interface.js'

let dir: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smi7260-callers-'))
  vi.stubEnv('SKILLSMITH_QUIET', '1')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

/** A skills.db built and closed by the native driver, with no quarantine tables. */
function nativeSkillsDb(name: string, schemaVersion = LATEST_SCHEMA_VERSION): string {
  const path = join(dir!, name)
  const db = createBetterSqlite3Database(path)
  initializeSchema(db)
  new SkillRepository(db).createBatch([
    { id: 'probe/one', name: 'one', description: 'a testing helper', author: 'probe' },
    { id: 'probe/two', name: 'two', description: 'another testing helper', author: 'probe' },
  ])
  db.exec('DROP TABLE IF EXISTS quarantine; DROP TABLE IF EXISTS quarantine_approvals')
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

async function codeOfAsync(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
    return 'no throw'
  } catch (error) {
    return (error as { code?: unknown }).code
  }
}

describe('SMI-7260 L9: the schema version constants agree', () => {
  it('SCHEMA_VERSION is the newest migration', () => {
    expect(SCHEMA_VERSION).toBe(LATEST_SCHEMA_VERSION)
  })
})

describe('SMI-7260 test 4: search works on a WASM handle without a quarantine table', () => {
  it('SearchService returns rows and QuarantineRepository degrades instead of throwing', async () => {
    const path = nativeSkillsDb('skills.db')
    const db = await createSqlJsDatabase(path)
    try {
      const results = new SearchService(db).search({ query: 'testing', limit: 10 })
      expect(results.items.map((r) => r.skill.id).sort()).toEqual(['probe/one', 'probe/two'])

      // What the MCP search tool does on every query.
      const quarantine = new QuarantineRepository(db)
      expect(quarantine.available).toBe(false)
      expect(quarantine.isQuarantined('probe/one')).toBe(false)
      expect(quarantine.findAll().items).toEqual([])
      expect(quarantine.query({}).items).toEqual([])
      expect(quarantine.getStats().total).toBe(0)
      expect(
        codeOf(() =>
          quarantine.create({
            skillId: 'probe/one',
            source: 'test',
            quarantineReason: 'r',
            severity: 'RISKY',
          })
        )
      ).toBe(DB_WASM_READ_ONLY_CODE)

      const approvals = new ApprovalRepository(db)
      expect(approvals.available).toBe(false)
      expect(approvals.getApprovals('q-1')).toEqual([])
      expect(approvals.isComplete('q-1')).toBe(false)
      expect(approvals.getPendingApprovalCount('q-1')).toBe(0)
      expect(
        codeOf(() =>
          approvals.recordApproval({
            skillId: 'q-1',
            reviewerId: 'r',
            reviewerEmail: 'r@example.com',
            decision: 'approved',
          })
        )
      ).toBe(DB_WASM_READ_ONLY_CODE)
    } finally {
      db.close()
    }
  })

  it('on a writable native handle both repositories create their table (the paired control)', () => {
    const db = createBetterSqlite3Database(':memory:')
    try {
      initializeSchema(db)
      expect(new QuarantineRepository(db).available).toBe(true)
      expect(new ApprovalRepository(db).available).toBe(true)
    } finally {
      db.close()
    }
  })
})

describe('SMI-7260 test 9 (core): an older schema on a read-only WASM handle', () => {
  it('initializeSchema refuses with the named code and leaves the file untouched', async () => {
    const path = nativeSkillsDb('old.db', 10)
    const before = readFileSync(path)
    const db = await createSqlJsDatabase(path)
    try {
      expect(getSchemaVersion(db)).toBe(10)
      expect(codeOf(() => initializeSchema(db))).toBe(DB_WASM_READ_ONLY_CODE)
      // Presence: the handle still reads.
      expect(new SkillRepository(db).count()).toBe(2)
    } finally {
      db.close()
    }
    expect(readFileSync(path).equals(before)).toBe(true)
  })

  it('openDatabaseAsync (the MCP path) warns once per database and continues', async () => {
    vi.stubEnv('SKILLSMITH_FORCE_WASM', 'true')
    const path = nativeSkillsDb('old-mcp.db', 10)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const first = await openDatabaseAsync(path)
    const second = await openDatabaseAsync(path)
    try {
      expect(new SkillRepository(first).count()).toBe(2)
      expect(getSchemaVersion(second)).toBe(10)
    } finally {
      first.close()
      second.close()
    }
    const schemaWarnings = warn.mock.calls.filter((c) => String(c[0]).includes(path))
    expect(schemaWarnings).toHaveLength(1)
  })

  it('initializeSchema at the current schema is a no-op on a read-only handle', async () => {
    const path = nativeSkillsDb('current.db')
    const db = await createSqlJsDatabase(path)
    try {
      expect(codeOf(() => initializeSchema(db))).toBe('no throw')
      expect(new SkillRepository(db).count()).toBe(2)
    } finally {
      db.close()
    }
  })
})

describe('SMI-7260: every core skills.db opener seals the handle it returns', () => {
  const sealedAndUnwritten = (db: Database) => {
    expect(db.readonly).toBe(true)
    expect(codeOf(() => db.exec("INSERT INTO cache (key, value) VALUES ('k', 'v')"))).toBe(
      DB_WASM_READ_ONLY_CODE
    )
  }

  it('openDatabaseAsync on an existing database', async () => {
    vi.stubEnv('SKILLSMITH_FORCE_WASM', 'true')
    const db = await openDatabaseAsync(nativeSkillsDb('existing.db'))
    try {
      sealedAndUnwritten(db)
      expect(new SkillRepository(db).count()).toBe(2)
    } finally {
      db.close()
    }
  })

  it('createDatabaseAsync (schema.ts) on a first run; the file is never created', async () => {
    vi.stubEnv('SKILLSMITH_FORCE_WASM', 'true')
    const path = join(dir!, 'first-run.db')
    const db = await createDatabaseAsync(path)
    try {
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION)
      sealedAndUnwritten(db)
    } finally {
      db.close()
    }
    expect(existsSync(path)).toBe(false)
  })

  it('the bare factory plus initializeSchema (the MCP first-run path) on a first run', async () => {
    vi.stubEnv('SKILLSMITH_FORCE_WASM', 'true')
    const path = join(dir!, 'first-run-bare.db')
    const db = await createBareDatabaseAsync(path)
    expect(db.readonly).toBe(false)
    initializeSchema(db)
    try {
      sealedAndUnwritten(db)
    } finally {
      db.close()
    }
    expect(existsSync(path)).toBe(false)
  })

  it('openers on the native driver are untouched by the seal (the paired control)', async () => {
    const path = join(dir!, 'native.db')
    const db = await createDatabaseAsync(path)
    try {
      expect(db.readonly).toBe(false)
      expect(codeOf(() => db.exec("INSERT INTO cache (key, value) VALUES ('k', 'v')"))).toBe(
        'no throw'
      )
    } finally {
      db.close()
    }
    expect(existsSync(path)).toBe(true)
    expect(await codeOfAsync(() => openDatabaseAsync(path).then((d) => d.close()))).toBe('no throw')
  })
})
