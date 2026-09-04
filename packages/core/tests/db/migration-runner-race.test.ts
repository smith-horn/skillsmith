/**
 * SMI-6003: regression test for the unguarded concurrent-migration race in
 * runMigrations() (packages/core/src/db/migration-runner.ts).
 *
 * Two processes opening the same fresh DB concurrently can both read
 * currentVersion = getSchemaVersion(db) BEFORE either has stamped a row,
 * both decide the same migration is pending, and the loser's plain
 * `INSERT INTO schema_version (version) VALUES (?)` throws `UNIQUE
 * constraint failed: schema_version.version`. This is the exact real-world
 * failure crash-handler-integration.test.ts's SMI-5999 fix sidesteps by
 * isolating each spawned mcp-server process's HOME — that test proves the
 * SYMPTOM is contained by isolation; this test proves the underlying
 * migration-runner bug itself is fixed, independent of any caller-side
 * isolation.
 *
 * Genuine concurrency is required to reproduce this — see
 * migration-runner-race-child.mjs's header for why a single-process
 * Promise.all() over synchronous better-sqlite3 calls cannot do it. This
 * spawns two REAL child processes (same established pattern as
 * owned-lock-lost-update.test.ts), each opening its own connection to the
 * same DB file, barrier-synced so both call the real `runMigrations()` at
 * effectively the same instant.
 */
import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDatabaseSync } from '../../src/db/createDatabase.js'
import { SCHEMA_SQL } from '../../src/db/schema-sql.js'
import { MIGRATION_V5_SQL } from '../../src/db/migrations/v5-skill-versions.js'
import { closeDatabase } from '../../src/db/schema.js'
import { isBetterSqlite3Available } from '../../src/db/drivers/betterSqlite3Driver.js'

// Evaluated once at module load — used by describe.skipIf() to skip this
// suite when the native SQLite driver is unavailable (e.g. WASM fallback
// mode); the race under test is specific to a real, file-backed SQLite
// connection shared across processes, not the in-memory WASM driver.
const skipIfNoSqlite = !isBetterSqlite3Available()

const testDir = path.dirname(fileURLToPath(import.meta.url))
const childPath = path.join(testDir, '..', 'helpers', 'migration-runner-race-child.mjs')

interface ChildResult {
  code: number | null
  stderr: string
}

function spawnChild(dbPath: string, barrierDir: string, id: number): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', childPath, dbPath, barrierDir, String(id)],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    )
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('exit', (code) => resolve({ code, stderr }))
  })
}

describe.skipIf(skipIfNoSqlite)('SMI-6003 runMigrations concurrent-migration race', () => {
  it('two concurrent runMigrations() calls against the same fresh DB file do not throw', async () => {
    const dir = path.join(
      os.tmpdir(),
      `migration-runner-race-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    mkdirSync(dir, { recursive: true })
    const dbPath = path.join(dir, 'race.db')

    // Set up a "fresh" DB already stamped at v16 — migrations v17 AND v18
    // (SMI-6343 Wave 2, the last two entries in MIGRATIONS) are pending, so
    // BOTH children will race to apply and INSERT the same version rows.
    // This isolates the test to the check-then-act bug itself (contested
    // INSERTs) rather than incidental concurrent DDL from re-running the
    // full migration chain (which would also happen to trip the same bug,
    // just less deterministically — v17's own apply() short-circuits to a
    // cheap SELECT probe on a fresh SCHEMA_SQL base, since the base schema
    // already includes 'curated' in the trust_tier CHECK — see
    // migrations/v17-curated-trust-tier.ts).
    //
    // v18's `DELETE FROM skill_versions` needs that table to exist, and
    // SCHEMA_SQL (migration v1's own baseline) never included it — it's
    // created by migration v5, which this setup deliberately skips (along
    // with the rest of v2-v16) to keep the race window minimal. Explicitly
    // replay v5's (idempotent, `CREATE TABLE IF NOT EXISTS`) SQL here so
    // v18 has a real table to race against, without pulling in the full
    // v2-v16 chain this test is designed to avoid.
    const setupDb = createDatabaseSync(dbPath)
    setupDb.exec(SCHEMA_SQL)
    setupDb.exec(MIGRATION_V5_SQL)
    setupDb.prepare('INSERT INTO schema_version (version) VALUES (16)').run()
    closeDatabase(setupDb)

    const results = await Promise.all([spawnChild(dbPath, dir, 0), spawnChild(dbPath, dir, 1)])

    for (const r of results) {
      expect(r.code, `child stderr:\n${r.stderr}`).toBe(0)
    }

    rmSync(dir, { recursive: true, force: true })
  }, 30_000)
})
