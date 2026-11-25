/**
 * SMI-5649 (restored by SMI-7260, governance F6): an in-flight background sync
 * at SIGTERM settles before the database closes.
 *
 * This test lived in `shutdown-persistence-subprocess.test.ts`, which SMI-7260
 * deleted because its other cases proved WASM persistence that no longer
 * exists. This one never depended on persistence. It runs on the NATIVE driver
 * now: the WASM driver no longer starts background sync at all, so on WASM the
 * race this test exists for cannot happen.
 *
 * It spawns the real built `dist/src/index.js`, points the API client at a
 * local stub whose `/registry-sync` never answers, waits until a real sync is
 * mid-fetch, and sends SIGTERM. The shutdown coordinator must quiesce (abort
 * and await) that sync before closing the database: a clean exit 0 and an
 * intact database prove no write raced the close.
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

// SMI-5548: a local pre-push run in a worktree may have no built dist/; skip
// only in that exact combination. CI never sets SKILLSMITH_PREPUSH.
const skipInPrePush = process.env['SKILLSMITH_PREPUSH'] === '1' && !existsSync(DIST_ENTRY)
if (skipInPrePush) {
  console.warn('[SMI-5548] skipping background-sync subprocess test in pre-push (dist absent)')
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

  it('an in-flight background sync at SIGTERM time settles cleanly before db close (no write races the close)', async () => {
    const dbPath = path.join(
      os.tmpdir(),
      `skillsmith-shutdown-sync-race-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    )
    tmpDbPath = dbPath

    let syncRequestReceived: () => void = () => {}
    const syncRequestReceivedPromise = new Promise<void>((resolve) => {
      syncRequestReceived = resolve
    })

    // /health answers fast; /registry-sync never answers, so the sync stays
    // genuinely in flight until quiesce aborts it.
    const stubServer = http.createServer((req, res) => {
      if (req.url?.startsWith('/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'healthy', version: '1.0.0' }))
        return
      }
      if (req.url?.startsWith('/registry-sync')) {
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

      // Quiesce settled before close: no hang, no crash from a write on a closed db.
      expect(exitCode).toBe(0)
      // The native driver wrote the database, and it is intact.
      expect(stderrChunks.join('')).not.toContain('Skillsmith is using the WASM driver')
      const reopened = createDatabaseSync(dbPath)
      try {
        expect(reopened.prepare('PRAGMA quick_check').all()).toEqual([{ quick_check: 'ok' }])
      } finally {
        reopened.close()
      }
    } finally {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
      await new Promise<void>((resolve) => stubServer.close(() => resolve()))
    }
  }, 75_000)
})
