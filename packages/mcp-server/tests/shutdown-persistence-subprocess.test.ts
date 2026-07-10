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
import * as os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

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
})
