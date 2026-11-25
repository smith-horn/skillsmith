/**
 * SMI-5649 (restored by SMI-7260, governance F6): an in-flight background sync
 * at SIGTERM settles before the database closes.
 *
 * This test lived in `shutdown-persistence-subprocess.test.ts`, which SMI-7260
 * deleted because its other cases proved WASM persistence that no longer
 * exists. It runs on the NATIVE driver: the WASM driver does not start
 * background sync at all.
 *
 * **The contract it pins is today's (owner decision; SMI-7267 tracks making
 * quiesce cancel).** The shutdown quiesce does not abort a request already in
 * flight: the sync is not handed the signal at the HTTP layer, so quiesce
 * WAITS for the answer (bounded by `SHUTDOWN_QUIESCE_TIMEOUT_MS`, 2 s). Once
 * the answer arrives, the aborted sync skips its upsert but still records its
 * run (`setLastSync`, `completeRun`), and only then does the database close.
 *
 * So the stub holds `/registry-sync` until SIGTERM, then answers
 * {@link ANSWER_DELAY_MS} later with a valid payload. Measured (native, this
 * container): with the quiesce, the answer was flushed 202 ms after SIGTERM,
 * the server exited 0 at 274 ms, and the run was recorded `success` with
 * `last_sync_at` set. With `await runQuiesce(...)` removed, the server exited
 * 15 ms after SIGTERM, before the answer, leaving the run `running` and
 * `last_sync_at` NULL. The recorded run is therefore the assertion that pins
 * the quiesce; the stub's "response sent" marker proves the answer landed.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createDatabaseSync } from '@skillsmith/core'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const DIST_ENTRY = path.join(REPO_ROOT, 'packages', 'mcp-server', 'dist', 'src', 'index.js')

/** How long after SIGTERM the stub answers: well inside the 2 s quiesce bound. */
const ANSWER_DELAY_MS = 200

// SMI-5548: a local pre-push run in a worktree may have no built dist/; skip
// only in that exact combination. CI never sets SKILLSMITH_PREPUSH.
const skipInPrePush = process.env['SKILLSMITH_PREPUSH'] === '1' && !existsSync(DIST_ENTRY)
if (skipInPrePush) {
  console.warn('[SMI-5548] skipping background-sync subprocess test in pre-push (dist absent)')
}

/** A valid `/registry-sync` page (one skill), as SearchResponseSchema parses it. */
function registrySyncPage(): string {
  return JSON.stringify({
    data: [
      {
        id: 'probe/late-skill',
        name: 'late-skill',
        description: 'answered after SIGTERM',
        author: 'probe',
        repo_url: 'https://github.com/probe/late-skill',
        quality_score: 0.5,
        trust_tier: 'community',
        tags: [],
        updated_at: new Date().toISOString(),
      },
    ],
    meta: { limit: 100, offset: 0, since: null },
  })
}

describe.skipIf(skipInPrePush)('SMI-5649 shutdown with an in-flight background sync', () => {
  let tmpDbPath: string | undefined

  beforeAll(() => {
    if (!existsSync(DIST_ENTRY)) {
      const build = spawnSync('npm', ['run', 'build', '--workspace=@skillsmith/mcp-server'], {
        stdio: 'inherit',
        cwd: REPO_ROOT,
      })
      if (build.status !== 0) throw new Error('mcp-server build failed in beforeAll')
    }
    if (!existsSync(DIST_ENTRY)) throw new Error(`Expected ${DIST_ENTRY} to exist after build`)
  }, 120_000)

  afterEach(() => {
    if (tmpDbPath === undefined) return
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${tmpDbPath}${suffix}`, { force: true })
    tmpDbPath = undefined
  })

  it('waits for the in-flight sync answered after SIGTERM, records the run, then closes the db cleanly', async () => {
    const dbPath = path.join(
      os.tmpdir(),
      `skillsmith-shutdown-sync-race-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    )
    tmpDbPath = dbPath

    // Server-side markers: what the stub saw and did, in order.
    const stubLog: string[] = []
    let heldResponse: http.ServerResponse | undefined
    let syncRequestReceived: () => void = () => {}
    const syncRequestReceivedPromise = new Promise<void>((resolve) => {
      syncRequestReceived = resolve
    })

    // /health answers at once; /registry-sync is held until SIGTERM.
    const stubServer = http.createServer((req, res) => {
      if (req.url?.startsWith('/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'healthy', version: '1.0.0' }))
        return
      }
      if (req.url?.startsWith('/registry-sync')) {
        stubLog.push('registry-sync held')
        heldResponse = res
        syncRequestReceived()
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => stubServer.listen(0, '127.0.0.1', resolve))
    const stubPort = (stubServer.address() as AddressInfo).port

    // The native driver: nothing forces WASM, whatever the parent environment says.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SKILLSMITH_DB_PATH: dbPath,
      SKILLSMITH_SKIP_SKILL_INSTALL: '1',
      SKILLSMITH_AUTO_UPDATE_CHECK: 'false',
      SKILLSMITH_TIER1_AUTOINSTALL_DISABLE: '1',
      SKILLSMITH_AUDIT_EMAIL_DISABLE: '1',
      // Deliberately NOT setting SKILLSMITH_BACKGROUND_SYNC=false.
      SKILLSMITH_API_URL: `http://127.0.0.1:${stubPort}`,
    }
    delete env.SKILLSMITH_FORCE_WASM
    const proc = spawn('node', [DIST_ENTRY], { env, stdio: ['pipe', 'pipe', 'pipe'] })

    const stderrChunks: string[] = []
    proc.stderr.on('data', (d: Buffer) => stderrChunks.push(d.toString()))

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`server boot timeout — stderr so far:\n${stderrChunks.join('')}`))
        }, 60_000)
        proc.stderr.on('data', (d: Buffer) => {
          if (d.toString().includes('Skillsmith MCP server running')) {
            clearTimeout(timeout)
            resolve()
          }
        })
        proc.on('error', (err) => {
          clearTimeout(timeout)
          reject(err)
        })
      })

      // A real sync is mid-fetch, not an assumption about startup timing.
      await Promise.race([
        syncRequestReceivedPromise,
        new Promise<void>((_resolve, reject) =>
          setTimeout(
            () => reject(new Error('background sync never reached /registry-sync in time')),
            20_000
          )
        ),
      ])

      const exited = new Promise<number | null>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(
            new Error(
              `process did not exit within 10s of SIGTERM — stderr:\n${stderrChunks.join('')}`
            )
          )
        }, 10_000)
        proc.on('exit', (code) => {
          clearTimeout(timeout)
          resolve(code)
        })
      })
      proc.kill('SIGTERM')
      // The held request is answered after SIGTERM, well inside the quiesce bound.
      const answered = new Promise<void>((resolve) => {
        setTimeout(() => {
          heldResponse?.writeHead(200, { 'Content-Type': 'application/json' })
          heldResponse?.end(registrySyncPage(), () => stubLog.push('response sent'))
          resolve()
        }, ANSWER_DELAY_MS)
      })
      const exitCode = await exited
      await answered

      // A clean exit, and an intact native database.
      expect(exitCode).toBe(0)
      expect(stderrChunks.join('')).not.toContain('Skillsmith is using the WASM driver')
      const reopened = createDatabaseSync(dbPath)
      let runs: Array<{ status: string; completed_at: string | null }>
      let lastSyncAt: string | null | undefined
      try {
        expect(reopened.prepare('PRAGMA quick_check').all()).toEqual([{ quick_check: 'ok' }])
        runs = reopened
          .prepare('SELECT status, completed_at FROM sync_history ORDER BY started_at')
          .all() as Array<{ status: string; completed_at: string | null }>
        lastSyncAt = (
          reopened.prepare("SELECT last_sync_at FROM sync_config WHERE id = 'default'").get() as
            | { last_sync_at: string | null }
            | undefined
        )?.last_sync_at
      } finally {
        reopened.close()
      }
      // THE QUIESCE: the late answer was waited for, and the sync recorded its
      // run before the database closed. Without the quiesce the process exits
      // first and this run is left `running`, with last_sync_at NULL.
      expect(runs).toHaveLength(1)
      expect(runs[0]?.status).toBe('success')
      expect(runs[0]?.completed_at).not.toBeNull()
      expect(lastSyncAt).not.toBeNull()
      // The control: the stub's answer really went out, so the run above was
      // recorded from it rather than from some other path.
      expect(stubLog).toEqual(['registry-sync held', 'response sent'])
    } finally {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
      await new Promise<void>((resolve) => stubServer.close(() => resolve()))
    }
  }, 75_000)
})
