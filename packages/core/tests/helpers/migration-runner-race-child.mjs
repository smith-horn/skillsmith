#!/usr/bin/env node
/**
 * Cross-process child harness for migration-runner-race.test.ts (SMI-6003).
 * Deliberately OUTSIDE every vitest glob (plain `.mjs`, not `*.test.ts` /
 * `*.spec.ts`) -- exists only to be spawned as a real child process by the
 * parent test.
 *
 * WHY A CHILD PROCESS (not Promise.all() in-process): the bug under test is
 * a check-then-act race inside the fully-synchronous `runMigrations()` (no
 * `await` anywhere in its body). JS run-to-completion semantics mean two
 * purely-synchronous calls in a single process can never actually
 * interleave -- whichever Promise.all() branch's continuation runs first
 * would finish its entire synchronous `runMigrations()` call (including its
 * INSERT) before the other branch's continuation ever got a turn, so the
 * "loser reads a stale currentVersion" window could never open in-process.
 * Real OS-level concurrency (separate processes, same pattern as
 * owned-lock-lost-update.test.ts) is required to reproduce it.
 *
 * Spawned as:
 *   node --import tsx migration-runner-race-child.mjs <dbPath> <barrierDir> <id>
 *
 * Protocol: open its own better-sqlite3 connection to the shared `dbPath`,
 * touch `barrierDir/ready-<id>`, poll until BOTH `ready-*` markers exist
 * (tightens the race window to the actual check-then-act critical section
 * inside runMigrations, rather than relying on process-spawn jitter alone),
 * then call the real production `runMigrations(db)`. Reports outcome via
 * exit code (0 = no throw, 1 = threw -- message written to
 * barrierDir/error-<id> and to stderr) so the parent can assert both
 * children survived.
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDatabaseSync } from '../../src/db/createDatabase.ts'
import { runMigrations } from '../../src/db/migration-runner.ts'

const [dbPath, barrierDir, id] = process.argv.slice(2)

const WAIT_CAP_MS = 10_000

function touch(name) {
  writeFileSync(join(barrierDir, name), '')
}

function waitFor(predicate, label) {
  const deadline = Date.now() + WAIT_CAP_MS
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`[migration-runner-race-child ${id}] timed out waiting for ${label}`)
    }
  }
}

function countReady() {
  return readdirSync(barrierDir).filter((f) => f.startsWith('ready-')).length
}

try {
  const db = createDatabaseSync(dbPath)
  touch(`ready-${id}`)
  waitFor(() => countReady() >= 2, 'both children to be ready')
  runMigrations(db)
  db.close()
  process.exit(0)
} catch (err) {
  const message = String(err && err.stack ? err.stack : err)
  if (existsSync(barrierDir)) {
    writeFileSync(join(barrierDir, `error-${id}`), message)
  }
  console.error(message)
  process.exit(1)
}
