/**
 * SMI-5419 W0.1 — end-to-end case-fix round-trip.
 *
 * The original outage: a lower-cased cwd encoded to a project dir that did not
 * match Claude Code's case-preserving directory, so writes split into a second
 * dir and the read side never saw them (silent for ~6 weeks). This exercises
 * the WHOLE native write path (not just the resolver unit): a mis-cased cwd
 * must reconcile to the EXISTING on-disk dir so a write and a subsequent read
 * land in the same DB — and no new mis-cased dir is created.
 *
 * Lives in a sibling file (not writer.test.ts) because that file is already at
 * the 500-line soft cap; this keeps the case-fix e2e grouped and isolated.
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type BetterSqlite3 from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same native gate as writer.test.ts: require() succeeds even for a Mach-O
// binary on Linux, so probe by actually opening an in-memory DB.
const require = createRequire(import.meta.url)
let Database: typeof BetterSqlite3 | null = null
let nativeSqliteAvailable = false
try {
  const Ctor = require('better-sqlite3') as typeof BetterSqlite3
  const probe = new Ctor(':memory:')
  probe.close()
  Database = Ctor
  nativeSqliteAvailable = true
} catch {
  nativeSqliteAvailable = false
}

/** Fresh module instance so the project-dir memo + cached DB handle start null. */
async function freshWriter(): Promise<typeof import('./writer.js')> {
  vi.resetModules()
  return import('./writer.js')
}

let scratch: string
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'writer-casefix-'))
  // Delete the override so the writer exercises the real resolver path.
  delete process.env.RETRIEVAL_LOG_DIR_OVERRIDE
  delete process.env.IS_DOCKER
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(async () => {
  const { closeRetrievalLog } = await import('./writer.js')
  closeRetrievalLog()
  warnSpy.mockRestore()
  vi.unstubAllEnvs()
  rmSync(scratch, { recursive: true, force: true })
})

describe.skipIf(!nativeSqliteAvailable)('SMI-5419 mis-cased cwd write->read round-trip', () => {
  it('reconciles to the existing on-disk dir so write and read agree', async () => {
    // Fake HOME with an EXISTING title-cased project dir (what Claude Code wrote).
    const fakeHome = join(scratch, 'home')
    const projects = join(fakeHome, '.claude', 'projects')
    const onDisk = '-Users-Foo-Bar' // canonical casing already on disk
    mkdirSync(join(projects, onDisk), { recursive: true })
    vi.stubEnv('HOME', fakeHome)

    // Mis-cased cwd (the bug shape). findMainRepoRoot('/users/foo/bar') => null
    // (no .git ancestor) so the resolver keys on the cwd directly:
    //   encode('/users/foo/bar')      = '-users-foo-bar'
    //   asciiFold('-Users-Foo-Bar')   = '-users-foo-bar'  → single variant → reconciled
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/users/foo/bar')

    try {
      const { logRetrievalEvent } = await freshWriter()
      logRetrievalEvent({
        sessionId: 'mc-1',
        ts: '2026-06-27T00:00:00Z',
        trigger: 'session_start_priming',
        query: 'q',
        topKResults: '[]',
        hookOutcome: 'primed',
      })

      // The DB lands in the reconciled (title-cased) dir...
      const reconciledDb = join(projects, onDisk, 'retrieval-logs.db')
      expect(existsSync(reconciledDb)).toBe(true)

      // ...and NO new mis-cased dir was created (the original split bug).
      expect(readdirSync(projects)).toEqual([onDisk])

      // Read back through a fresh reader: the row is in the reconciled DB.
      const db = new Database!(reconciledDb, { readonly: true })
      const row = db
        .prepare("SELECT session_id FROM retrieval_events WHERE session_id = 'mc-1'")
        .get() as { session_id: string } | undefined
      db.close()
      expect(row?.session_id).toBe('mc-1')

      // A single clean variant must NOT trip the ambiguity guard.
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringMatching(/ambiguous project dir/))
    } finally {
      cwdSpy.mockRestore()
      vi.unstubAllEnvs()
    }
  })
})
