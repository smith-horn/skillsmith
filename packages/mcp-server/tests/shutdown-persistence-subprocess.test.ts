/**
 * SMI-5639 Wave 2 Step 4: End-to-end subprocess SIGTERM persistence check.
 *
 * Spawns the real BUILT `dist/src/index.js` binary (not source — mirrors
 * `startup-probe.test.ts`'s own pattern, including its `beforeAll`
 * build-if-absent gate and pre-push carve-out) against a temp WASM
 * (`sql.js`) database, waits for it to report ready, sends a real `SIGTERM`,
 * and asserts the temp DB file went from "does not exist" to "exists with
 * non-zero size" as a direct result of the signal.
 *
 * This is the single most direct proof the fix works against the real
 * binary: the WASM driver's `close()` is the only thing that ever calls
 * `persist()` (`writeFileSync`), so the DB file does not exist AT ALL until
 * the first successful close — before SMI-5639's fix, nothing in the
 * shutdown path ever called `close()`, so this file would never appear no
 * matter how long the server ran or how many writes it made.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, statSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createToolContextAsync, closeToolContext } from '../src/context.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const DIST_ENTRY = path.join(REPO_ROOT, 'packages', 'mcp-server', 'dist', 'src', 'index.js')

// SMI-5548: mirrors startup-probe.test.ts's pre-push carve-out — a local
// pre-push run has no built dist/ in a worktree (the build itself fails
// there), so skip only in that exact combination. CI never sets
// SKILLSMITH_PREPUSH, so it always builds dist and runs this suite for real.
const skipInPrePush = process.env['SKILLSMITH_PREPUSH'] === '1' && !existsSync(DIST_ENTRY)
if (skipInPrePush) {
  console.warn(
    '[SMI-5548] skipping shutdown-persistence subprocess test in pre-push (dist absent; covered by CI)'
  )
}

describe.skipIf(skipInPrePush)('SMI-5639 shutdown persistence — subprocess SIGTERM', () => {
  let tmpDbPath: string

  beforeAll(() => {
    // H9 pattern (startup-probe.test.ts): build mcp-server explicitly if dist
    // is missing, fail loudly if it still isn't present afterwards. Ensures
    // this test never silently runs against a stale binary.
    if (!existsSync(DIST_ENTRY)) {
      const build = spawnSync('npm', ['run', 'build', '--workspace=@skillsmith/mcp-server'], {
        stdio: 'inherit',
        cwd: REPO_ROOT,
      })
      if (build.status !== 0) {
        throw new Error('mcp-server build failed in beforeAll')
      }
    }
    if (!existsSync(DIST_ENTRY)) {
      throw new Error(`Expected ${DIST_ENTRY} to exist after build`)
    }
  }, 120_000)

  afterEach(() => {
    if (tmpDbPath) {
      try {
        rmSync(tmpDbPath, { force: true })
      } catch {
        // Best-effort cleanup — not test-critical.
      }
    }
  })

  it('creates and persists the WASM database file to disk on SIGTERM shutdown', async () => {
    tmpDbPath = path.join(
      os.tmpdir(),
      `skillsmith-shutdown-subprocess-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    )

    // Before boot: nothing has ever written to this path.
    expect(existsSync(tmpDbPath)).toBe(false)

    // IMPORTANT: stdin must stay an open pipe, NOT 'ignore'. `StdioServerTransport`
    // (the MCP SDK) only listens for stdin 'data'/'error' — it never wires up
    // 'end'/'close', so it does NOT call `onclose()` on stdin EOF. With
    // `stdio: 'ignore'`, stdin is immediately at EOF, and — since nothing else
    // keeps the event loop alive — the process exits NATURALLY (bypassing
    // `shutdownAndExit` entirely) before this test ever gets to send SIGTERM,
    // which would make this test pass/fail for the wrong reason (a race, not
    // the shutdown-hook contract this test exists to verify). Keeping stdin
    // open as a real pipe (and never calling `proc.stdin.end()`) keeps the
    // child alive until the explicit SIGTERM below, exercising the REAL
    // `process.on('SIGTERM', shutdownAndExit)` path.
    const proc = spawn('node', [DIST_ENTRY], {
      env: {
        ...process.env,
        SKILLSMITH_FORCE_WASM: 'true',
        SKILLSMITH_DB_PATH: tmpDbPath,
        SKILLSMITH_SKIP_SKILL_INSTALL: '1',
        SKILLSMITH_AUTO_UPDATE_CHECK: 'false',
        SKILLSMITH_TIER1_AUTOINSTALL_DISABLE: '1',
        SKILLSMITH_AUDIT_EMAIL_DISABLE: '1',
        SKILLSMITH_BACKGROUND_SYNC: 'false',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const stderrChunks: string[] = []
    const stdoutChunks: string[] = []
    proc.stderr.on('data', (d: Buffer) => stderrChunks.push(d.toString()))
    proc.stdout.on('data', (d: Buffer) => stdoutChunks.push(d.toString()))

    try {
      // 1. Wait for the server to report it's up and running.
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(
            new Error(
              `server boot timeout — stderr so far:\n${stderrChunks.join('')}\nstdout so far:\n${stdoutChunks.join('')}`
            )
          )
        }, 60_000)
        proc.stderr.on('data', (d: Buffer) => {
          // SMI-5615: this exact stderr line is emitted via console.error in
          // index.ts's main(), immediately after transport.connect().
          if (d.toString().includes('Skillsmith MCP server running')) {
            clearTimeout(timeout)
            resolve()
          }
        })
        proc.on('error', (err) => {
          clearTimeout(timeout)
          reject(err)
        })
        proc.on('exit', (code) => {
          if (code !== null && code !== 0) {
            clearTimeout(timeout)
            reject(
              new Error(
                `mcp-server exited ${code} before reporting "running"; stderr:\n${stderrChunks.join('')}`
              )
            )
          }
        })
      })

      // 2. The server is fully booted (schema initialized in-memory), but the
      //    WASM driver only ever calls persist() -> writeFileSync inside
      //    close() — so the file must still not exist yet.
      expect(existsSync(tmpDbPath)).toBe(false)

      // 3. Send a real SIGTERM and wait for the process to actually exit —
      //    this exercises the REAL process.on('SIGTERM', shutdownAndExit)
      //    wiring in index.ts, not a mocked trigger call.
      const exitCode = await new Promise<number | null>((resolve, reject) => {
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
        proc.kill('SIGTERM')
      })

      // shutdownAndExit's onDone is `() => process.exit(0)` — a clean exit
      // code confirms the shutdown trigger ran to completion rather than the
      // process being force-killed by some other mechanism.
      expect(exitCode).toBe(0)

      // 4. The definitive assertion: this specific check fails before the
      //    SMI-5639 fix (file never appears, no matter how the process
      //    exits) and passes after it.
      expect(existsSync(tmpDbPath)).toBe(true)
      const stats = statSync(tmpDbPath)
      expect(stats.size).toBeGreaterThan(0)
    } finally {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGKILL')
      }
    }
  }, 75_000)

  /**
   * SMI-5649 Wave A Step 4: the race-fix proof. Before this wave,
   * `context.async.ts` registered its OWN independent SIGTERM/SIGINT
   * handlers whose `backgroundSync?.stop()` was fire-and-forget — it did not
   * await the in-flight sync, so a write from `SyncEngine.upsertSkills()`
   * could still be issued after `index.ts`'s independently-registered
   * handlers had already closed the db. This test forces a REAL background
   * sync to be genuinely in flight (deliberately does NOT set
   * `SKILLSMITH_BACKGROUND_SYNC=false`, unlike the test above) by pointing
   * the API client at a local HTTP stub (`SKILLSMITH_API_URL`) that stalls
   * its `/skills-search` response, then sends SIGTERM while that request is
   * still pending. The coordinator must quiesce (abort + await) that sync
   * before closing the db — a clean exit 0 and a valid persisted file prove
   * no write raced the close.
   */
  it('an in-flight background sync at SIGTERM time settles cleanly before db close (no write races the close)', async () => {
    tmpDbPath = path.join(
      os.tmpdir(),
      `skillsmith-shutdown-subprocess-race-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    )

    let searchRequestReceived: () => void
    const searchRequestReceivedPromise = new Promise<void>((resolve) => {
      searchRequestReceived = resolve
    })

    // Minimal local stub: /health responds fast (checkApiHealth's own 5s
    // timeout must not trip); /skills-search stalls for well longer than the
    // test needs to observe + send SIGTERM, simulating a genuinely in-flight
    // sync request at signal time.
    const stubServer = http.createServer((req, res) => {
      if (req.url?.startsWith('/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'healthy', version: '1.0.0' }))
        return
      }
      if (req.url?.startsWith('/skills-search')) {
        searchRequestReceived()
        // Never respond within this test's lifetime — the abort signal (not
        // a resolved/rejected fetch) is what ends this request from the
        // client's perspective once quiesce runs.
        return
      }
      res.writeHead(404)
      res.end()
    })

    await new Promise<void>((resolve) => stubServer.listen(0, '127.0.0.1', resolve))
    const stubPort = (stubServer.address() as AddressInfo).port

    const proc = spawn('node', [DIST_ENTRY], {
      env: {
        ...process.env,
        SKILLSMITH_FORCE_WASM: 'true',
        SKILLSMITH_DB_PATH: tmpDbPath,
        SKILLSMITH_SKIP_SKILL_INSTALL: '1',
        SKILLSMITH_AUTO_UPDATE_CHECK: 'false',
        SKILLSMITH_TIER1_AUTOINSTALL_DISABLE: '1',
        SKILLSMITH_AUDIT_EMAIL_DISABLE: '1',
        SKILLSMITH_AUTOSAVE_DISABLE: '1',
        // Deliberately NOT setting SKILLSMITH_BACKGROUND_SYNC=false — the
        // whole point of this test is a REAL in-flight background sync.
        SKILLSMITH_API_URL: `http://127.0.0.1:${stubPort}`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

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

      // Wait for the stub to actually receive the search request — proves a
      // real sync is genuinely mid-fetch, not a race against an assumption
      // about startup timing.
      await Promise.race([
        searchRequestReceivedPromise,
        new Promise<void>((_resolve, reject) =>
          setTimeout(
            () => reject(new Error('background sync never reached /skills-search in time')),
            20_000
          )
        ),
      ])

      const exitCode = await new Promise<number | null>((resolve, reject) => {
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
        proc.kill('SIGTERM')
      })

      // The whole point: a clean exit 0 proves the coordinator's quiesce
      // (abort + await the in-flight sync) settled before db close/process
      // exit — not a hang, not a crash from a write hitting a closed db.
      expect(exitCode).toBe(0)
      expect(existsSync(tmpDbPath)).toBe(true)
      expect(statSync(tmpDbPath).size).toBeGreaterThan(0)
    } finally {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGKILL')
      }
      await new Promise<void>((resolve) => stubServer.close(() => resolve()))
    }
  }, 75_000)

  /**
   * SMI-5640: autosave survives an ungraceful kill. Unlike the SIGTERM test
   * above (which asserts the db file does NOT exist until the graceful
   * shutdown persists it), this is the novel proof for the periodic
   * autosave: the file must exist BEFORE any signal is ever sent, and its
   * content must survive a SIGKILL (which bypasses every shutdown hook
   * entirely — no coordinator, no `onclose`, nothing).
   */
  it('the periodic autosave persists to disk before any signal, and survives SIGKILL', async () => {
    tmpDbPath = path.join(
      os.tmpdir(),
      `skillsmith-shutdown-subprocess-autosave-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    )

    const proc = spawn('node', [DIST_ENTRY], {
      env: {
        ...process.env,
        SKILLSMITH_FORCE_WASM: 'true',
        SKILLSMITH_DB_PATH: tmpDbPath,
        SKILLSMITH_SKIP_SKILL_INSTALL: '1',
        SKILLSMITH_AUTO_UPDATE_CHECK: 'false',
        SKILLSMITH_TIER1_AUTOINSTALL_DISABLE: '1',
        SKILLSMITH_AUDIT_EMAIL_DISABLE: '1',
        SKILLSMITH_BACKGROUND_SYNC: 'false',
        // Short interval so the test doesn't wait the real 5-minute default.
        SKILLSMITH_AUTOSAVE_INTERVAL_MS: '200',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

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

      // Wait comfortably past several flush intervals — no signal sent yet.
      await new Promise((resolve) => setTimeout(resolve, 1500))

      // The novel assertion (contrast the SIGTERM test above, which asserts
      // non-existence until the signal): the autosave timer, not any
      // shutdown hook, has already written the file to disk.
      expect(existsSync(tmpDbPath)).toBe(true)
      expect(statSync(tmpDbPath).size).toBeGreaterThan(0)

      // An ungraceful kill — bypasses transport.onclose, SIGTERM, SIGINT,
      // the whole shutdown coordinator entirely.
      const exitPromise = new Promise<void>((resolve) => proc.on('exit', () => resolve()))
      proc.kill('SIGKILL')
      await exitPromise

      // Reopen a FRESH connection against the same on-disk file — proves the
      // autosave's last flush produced a valid, non-corrupt export that
      // survives a kill no shutdown hook could ever catch.
      const freshContext = await createToolContextAsync({
        dbPath: tmpDbPath,
        backgroundSyncConfig: { enabled: false },
        apiClientConfig: { offlineMode: true },
      })
      try {
        expect(freshContext.db.open).toBe(true)
        const tables = freshContext.db
          .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
        expect(tables.some((t) => t.name === 'skills')).toBe(true)
      } finally {
        await closeToolContext(freshContext)
      }
    } finally {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGKILL')
      }
    }
  }, 75_000)
})
