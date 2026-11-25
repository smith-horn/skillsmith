/**
 * SMI-7260: the MCP server's tool context on the WASM driver.
 *
 * A file-backed WASM handle never writes to disk. These drive the real
 * `createToolContextAsync` (the server's only skills.db opener) against real
 * files: a first run with no database, and an existing database the native
 * driver wrote. `SKILLSMITH_FORCE_WASM` selects the WASM driver the same way a
 * failed native load does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BackgroundSyncService,
  createDatabaseSync,
  DB_WASM_READ_ONLY_CODE,
  getSchemaVersion,
  initializeSchema,
  SCHEMA_VERSION,
  SkillRepository,
} from '@skillsmith/core'
import { createToolContextAsync, resetAsyncToolContext } from '../../src/context.async.js'
import type { ToolContext } from '../../src/context.types.js'

let dir: string | undefined
const opened: ToolContext[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smi7260-mcp-'))
  vi.stubEnv('SKILLSMITH_QUIET', '1')
  vi.stubEnv('SKILLSMITH_TELEMETRY_ENABLED', 'false')
})

afterEach(async () => {
  for (const ctx of opened.splice(0)) if (ctx.db.open) ctx.db.close()
  await resetAsyncToolContext()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

/** A skills.db built and closed by the native driver. */
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

async function context(dbPath: string, backgroundSync = false): Promise<ToolContext> {
  const ctx = await createToolContextAsync({
    dbPath,
    backgroundSyncConfig: { enabled: backgroundSync },
    apiClientConfig: { offlineMode: true },
  })
  opened.push(ctx)
  return ctx
}

function codeOf(fn: () => unknown): unknown {
  try {
    fn()
    return 'no throw'
  } catch (error) {
    return (error as { code?: unknown }).code
  }
}

describe('SMI-7260 test 5: first run on the WASM driver', () => {
  it('builds the schema in memory, serves an empty search, refuses writes, and never creates the file', async () => {
    vi.stubEnv('SKILLSMITH_FORCE_WASM', 'true')
    const path = join(dir!, 'skills.db')

    const ctx = await context(path)
    // Presence: the schema exists (built in memory), so reads work.
    expect(getSchemaVersion(ctx.db)).toBe(SCHEMA_VERSION)
    expect(ctx.searchService.search({ query: 'testing', limit: 5 }).items).toEqual([])
    // Absence: the handle is sealed, so a write is refused by name.
    expect(ctx.db.readonly).toBe(true)
    expect(
      codeOf(() =>
        ctx.skillRepository.create({ id: 'a/b', name: 'b', description: 'd', author: 'a' })
      )
    ).toBe(DB_WASM_READ_ONLY_CODE)

    ctx.db.close()
    expect(existsSync(path)).toBe(false)
  })
})

describe('SMI-7260 test 6: no background sync on a read-only handle', () => {
  it('does not start it on WASM, and does start it on the native driver (paired control)', async () => {
    const start = vi.spyOn(BackgroundSyncService.prototype, 'start').mockImplementation(() => {})
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubEnv('SKILLSMITH_QUIET', '')

    const nativeCtx = await context(nativeSkillsDb('native.db'), true)
    expect(start).toHaveBeenCalledTimes(1)
    expect(nativeCtx.backgroundSync).toBeDefined()

    vi.stubEnv('SKILLSMITH_FORCE_WASM', 'true')
    const wasmCtx = await context(nativeSkillsDb('wasm.db'), true)
    expect(start).toHaveBeenCalledTimes(1)
    expect(wasmCtx.backgroundSync).toBeUndefined()
    // It says so, once.
    const syncOff = errors.mock.calls.filter((c) => String(c[0]).includes('Background sync is off'))
    expect(syncOff).toHaveLength(1)
  })

  it('the "sync is off" line is silent in quiet mode, and printed without it (the paired run)', async () => {
    vi.spyOn(BackgroundSyncService.prototype, 'start').mockImplementation(() => {})
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const syncOff = () =>
      errors.mock.calls.filter((c) => String(c[0]).includes('Background sync is off'))
    vi.stubEnv('SKILLSMITH_FORCE_WASM', 'true')

    vi.stubEnv('SKILLSMITH_QUIET', '1')
    await context(nativeSkillsDb('quiet.db'), true)
    expect(syncOff()).toHaveLength(0)

    vi.stubEnv('SKILLSMITH_QUIET', '')
    await context(nativeSkillsDb('loud.db'), true)
    expect(syncOff()).toHaveLength(1)
  })
})

describe('SMI-7260 test 9 (MCP): an older schema on the WASM driver', () => {
  it('warns once and serves reads from the old schema without writing the file', async () => {
    const path = nativeSkillsDb('old.db', 10)
    const before = readFileSync(path)
    vi.stubEnv('SKILLSMITH_FORCE_WASM', 'true')
    vi.stubEnv('SKILLSMITH_QUIET', '')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const ctx = await context(path)
    expect(getSchemaVersion(ctx.db)).toBe(10)
    expect(ctx.skillRepository.findById('probe/one')?.id).toBe('probe/one')
    const schemaLines = warn.mock.calls.filter(
      (c) => String(c[0]).includes(path) && String(c[0]).includes('schema version')
    )
    expect(schemaLines).toHaveLength(1)

    ctx.db.close()
    expect(readFileSync(path).equals(before)).toBe(true)
  })
})

describe('SMI-7260: the MCP context seals every file-backed WASM handle it opens', () => {
  it('seals an existing database, which still serves search', async () => {
    vi.stubEnv('SKILLSMITH_FORCE_WASM', 'true')
    const ctx = await context(nativeSkillsDb('existing.db'))
    expect(ctx.db.readonly).toBe(true)
    expect(ctx.searchService.search({ query: 'testing', limit: 5 }).items.length).toBe(1)
  })

  it('leaves a native handle writable (paired control)', async () => {
    const ctx = await context(nativeSkillsDb('native-writable.db'))
    expect(ctx.db.readonly).toBe(false)
    expect(
      codeOf(() =>
        ctx.skillRepository.create({ id: 'a/b', name: 'b', description: 'd', author: 'a' })
      )
    ).toBe('no throw')
  })
})
