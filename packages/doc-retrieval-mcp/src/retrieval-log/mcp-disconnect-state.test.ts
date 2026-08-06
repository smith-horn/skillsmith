/**
 * SMI-5941 — unit + real-concurrency tests for the mcp-disconnect-state module.
 *
 * The concurrency tests spawn genuinely separate OS processes (via the
 * `_lib/mcp-disconnect-worker.ts` helper, run through `tsx`) rather than
 * in-process `Promise.all` — plan-review pass 3 correctly noted that
 * synchronous `mkdirSync`-based calls wrapped in `Promise.all` can execute
 * sequentially within one event-loop tick with no real overlap, which would
 * let a race test pass without ever exercising the lock.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MCP_DISCONNECT_DISABLE_VAR,
  probeContainerStatus,
  readAndAck,
  readState,
  recordDisconnect,
  renderDisconnectBanner,
  resolveServerName,
  withLock,
  type McpDisconnectEntry,
} from './mcp-disconnect-state.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKER = join(HERE, '..', '_lib', 'mcp-disconnect-worker.ts')
const TSX_BIN = join(HERE, '..', '..', '..', '..', 'node_modules', '.bin', 'tsx')

// The reclaim-safety tests specifically need a worker process with NO
// intermediary — `tsx <script>.ts` always forks a real Node child to do the
// actual work (confirmed empirically: the PID recorded by the worker's own
// `process.pid` differs from the `spawn()`-returned wrapper PID). Killing
// the wrapper only orphans that child to this container's PID 1 (a bare
// `tail` keep-alive process, not an init/reaper) — the orphan becomes an
// unreapable zombie that still answers `kill(pid, 0)` as "alive" forever,
// which would make the reclaim-dead-process test unable to ever observe a
// real death. Running the already-`tsc`-compiled `dist/` output via plain
// `node` avoids the fork entirely: the spawned process IS the one holding
// the lock, so a direct kill is reaped normally by this test as its actual
// parent. Requires the workspace to have been built (`npm run build`) —
// true for the standard `npm run preflight` sequence this repo's CI runs
// before tests. The other tests below intentionally keep exercising the
// real tsx-invocation path (that's how the production hook script actually
// spawns the state CLI), since they don't need to kill anything.
const DIST_WORKER = join(HERE, '..', '..', 'dist', 'src', '_lib', 'mcp-disconnect-worker.js')

// ── Helpers ────────────────────────────────────────────────────────────────────

const tmpDirs: string[] = []

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
  delete process.env.SKILLSMITH_MCP_DISCONNECT_HOME
  delete process.env.SKILLSMITH_MCP_DISCONNECT_LOCK_STALE_MS
  delete process.env.SKILLSMITH_MCP_DISCONNECT_LOCK_ACQUIRE_TIMEOUT_MS
})

function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `${prefix}-`))
  tmpDirs.push(d)
  return d
}

/** Points the module's default state path at a fresh, isolated tmp dir. */
function freshHome(): void {
  process.env.SKILLSMITH_MCP_DISCONNECT_HOME = tmpDir('mcp-disconnect-home')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForAsync(pred: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timeout waiting for condition')
    await sleep(5)
  }
}

/** Spawns the worker as a real OS process; resolves with its captured stdout on a clean exit. */
function spawnWorker(
  mode: string,
  readyFile: string,
  goFile: string,
  repoKey: string,
  server: string,
  extra: string[] = []
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX_BIN, [WORKER, mode, readyFile, goFile, repoKey, server, ...extra], {
      env: process.env,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('exit', (code) =>
      code === 0 ? resolve({ stdout }) : reject(new Error(`worker exited ${code}: ${stderr}`))
    )
    child.on('error', reject)
  })
}

// ── Unit tests ─────────────────────────────────────────────────────────────────

describe('resolveServerName', () => {
  it('resolves mcp__skillsmith__* to skillsmith', () => {
    expect(resolveServerName('mcp__skillsmith__search')).toBe('skillsmith')
  })

  it('resolves mcp__skillsmith-doc-retrieval__* to skillsmith-doc-retrieval — never the shorter prefix', () => {
    expect(resolveServerName('mcp__skillsmith-doc-retrieval__skill_docs_search')).toBe(
      'skillsmith-doc-retrieval'
    )
  })

  it('returns null for anything else', () => {
    expect(resolveServerName('mcp__linear__save_issue')).toBeNull()
    expect(resolveServerName('Bash')).toBeNull()
  })
})

describe('renderDisconnectBanner', () => {
  it('names the server, the unacknowledged count, container status, and the reconnect instruction', () => {
    const entry: McpDisconnectEntry = {
      totalCount: 3,
      sinceAckCount: 2,
      lastTimestamp: '2026-01-01T00:00:00.000Z',
      lastTool: 'mcp__skillsmith__search',
      lastErrorExcerpt: 'transport closed',
      containerStatus: 'healthy',
    }
    const banner = renderDisconnectBanner('skillsmith', entry)
    expect(banner).toContain('skillsmith')
    expect(banner).toContain('2 unacknowledged')
    expect(banner).toContain('healthy')
    expect(banner).toContain('/mcp')
    expect(banner).toContain(MCP_DISCONNECT_DISABLE_VAR)
  })
})

describe('recordDisconnect / readAndAck — single-process round trip', () => {
  it('increments totalCount and sinceAckCount; ack resets sinceAckCount only', () => {
    freshHome()
    const repoKey = '/fake/repo'
    recordDisconnect(repoKey, 'skillsmith', {
      tool: 'mcp__skillsmith__search',
      errorExcerpt: 'transport closed',
      timestamp: new Date().toISOString(),
    })
    recordDisconnect(repoKey, 'skillsmith', {
      tool: 'mcp__skillsmith__search',
      errorExcerpt: 'transport closed',
      timestamp: new Date().toISOString(),
    })
    const acked = readAndAck(repoKey, 'skillsmith')
    expect(acked?.totalCount).toBe(2)
    expect(acked?.sinceAckCount).toBe(2)

    const after = readState()[repoKey]?.skillsmith
    expect(after?.sinceAckCount).toBe(0)
    expect(after?.totalCount).toBe(2) // lifetime count is never reset by an ack
  })

  it('tracks each MCP server namespace independently', () => {
    freshHome()
    const repoKey = '/fake/repo'
    recordDisconnect(repoKey, 'skillsmith', {
      tool: 'mcp__skillsmith__search',
      errorExcerpt: 'transport closed',
      timestamp: new Date().toISOString(),
    })
    recordDisconnect(repoKey, 'skillsmith-doc-retrieval', {
      tool: 'mcp__skillsmith-doc-retrieval__skill_docs_search',
      errorExcerpt: 'transport closed',
      timestamp: new Date().toISOString(),
    })
    const state = readState()
    expect(state[repoKey]?.skillsmith?.totalCount).toBe(1)
    expect(state[repoKey]?.['skillsmith-doc-retrieval']?.totalCount).toBe(1)
  })

  it('readAndAck returns null when there is nothing unacknowledged', () => {
    freshHome()
    expect(readAndAck('/fake/repo', 'skillsmith')).toBeNull()
  })

  it('a missing/corrupt state file reads as empty rather than throwing', () => {
    freshHome()
    expect(readState('/definitely/does/not/exist.state')).toEqual({})
  })
})

describe('probeContainerStatus', () => {
  it('never throws and returns one of the documented states', () => {
    const status = probeContainerStatus()
    expect(['healthy', 'unhealthy-or-starting', 'down', 'unknown']).toContain(status)
  })
})

// ── Real-concurrency tests (pass-3 C1/C2) ──────────────────────────────────────

describe('real OS-process concurrency: two-producer collision', () => {
  it('loses no updates across several iterations of two genuinely concurrent processes', async () => {
    freshHome()
    const repoKey = '/fake/repo'
    const ITERATIONS = 5
    for (let i = 0; i < ITERATIONS; i++) {
      const dir = tmpDir('mcp-disconnect-barrier')
      const ready1 = join(dir, 'ready1')
      const ready2 = join(dir, 'ready2')
      const go = join(dir, 'go')
      const p1 = spawnWorker('record', ready1, go, repoKey, 'skillsmith', [
        'toolA',
        'transport closed',
      ])
      const p2 = spawnWorker('record', ready2, go, repoKey, 'skillsmith', [
        'toolB',
        'transport closed',
      ])
      await waitForAsync(() => existsSync(ready1) && existsSync(ready2))
      writeFileSync(go, '1')
      await Promise.all([p1, p2])
    }
    const state = readState()
    expect(state[repoKey]?.skillsmith?.totalCount).toBe(ITERATIONS * 2)
    expect(state[repoKey]?.skillsmith?.sinceAckCount).toBe(ITERATIONS * 2)
  }, 30_000)
})

describe('real OS-process concurrency: producer/consumer interleave with seeded history', () => {
  it('never drops an event, accounting for history that predates the race (pass-3 #5)', async () => {
    freshHome()
    const repoKey = '/fake/repo'

    // Seed prior, already-existing (unacknowledged) history BEFORE the race —
    // the pass-2 revision's invariant only held for fresh state; this proves
    // the fix accounts for it.
    for (let i = 0; i < 3; i++) {
      recordDisconnect(repoKey, 'skillsmith', {
        tool: 'seed',
        errorExcerpt: 'transport closed',
        timestamp: new Date().toISOString(),
      })
    }
    const initial = readState()[repoKey]!.skillsmith!
    expect(initial.totalCount).toBe(3)

    const ITERATIONS = 4
    let acknowledgedThisRun = 0
    for (let i = 0; i < ITERATIONS; i++) {
      const dir = tmpDir('mcp-disconnect-interleave')
      const readyP = join(dir, 'readyP')
      const readyC = join(dir, 'readyC')
      const go = join(dir, 'go')
      const producer = spawnWorker('record', readyP, go, repoKey, 'skillsmith', [
        `tool${i}`,
        'transport closed',
      ])
      const consumer = spawnWorker('ack', readyC, go, repoKey, 'skillsmith')
      await waitForAsync(() => existsSync(readyP) && existsSync(readyC))
      writeFileSync(go, '1')
      const [, consumerResult] = await Promise.all([producer, consumer])
      const acked: McpDisconnectEntry | null = JSON.parse(consumerResult.stdout || 'null')
      if (acked) acknowledgedThisRun += acked.sinceAckCount
    }

    const final = readState()[repoKey]!.skillsmith!
    // Conservation invariant: everything ever produced (seed + this run) is
    // either reflected in the final unacknowledged count or was captured by
    // an ack during the run — nothing vanishes, regardless of which caller's
    // lock acquisition won each individual race.
    expect(final.totalCount).toBe(initial.totalCount + ITERATIONS)
    expect(final.sinceAckCount + acknowledgedThisRun).toBe(final.totalCount)
  }, 30_000)
})

describe('lock-acquisition timeout — fail-soft (the durable write may be skipped, but nothing throws)', () => {
  it('recordDisconnect returns false and does not persist when the lock cannot be acquired in time', async () => {
    freshHome()
    process.env.SKILLSMITH_MCP_DISCONNECT_LOCK_ACQUIRE_TIMEOUT_MS = '150'

    const dir = tmpDir('mcp-disconnect-timeout-producer')
    const ready = join(dir, 'ready')
    const go = join(dir, 'go')
    const holder = spawnWorker('hold-lock', ready, go, '/fake/repo', 'skillsmith', ['1000'])
    await waitForAsync(() => existsSync(ready))
    writeFileSync(go, '1')
    await sleep(50) // let the holder acquire before we contend

    const persisted = recordDisconnect('/fake/repo', 'skillsmith', {
      tool: 'mcp__skillsmith__search',
      errorExcerpt: 'transport closed',
      timestamp: new Date().toISOString(),
    })
    expect(persisted).toBe(false)
    expect(readState()['/fake/repo']?.skillsmith).toBeUndefined()

    await holder
  }, 10_000)

  it('readAndAck returns null and does not crash when the lock cannot be acquired in time', async () => {
    freshHome()
    // Seed an unacknowledged entry while the lock is free.
    recordDisconnect('/fake/repo', 'skillsmith', {
      tool: 'mcp__skillsmith__search',
      errorExcerpt: 'transport closed',
      timestamp: new Date().toISOString(),
    })

    process.env.SKILLSMITH_MCP_DISCONNECT_LOCK_ACQUIRE_TIMEOUT_MS = '150'
    const dir = tmpDir('mcp-disconnect-timeout-consumer')
    const ready = join(dir, 'ready')
    const go = join(dir, 'go')
    const holder = spawnWorker('hold-lock', ready, go, '/fake/repo', 'skillsmith', ['1000'])
    await waitForAsync(() => existsSync(ready))
    writeFileSync(go, '1')
    await sleep(50)

    expect(readAndAck('/fake/repo', 'skillsmith')).toBeNull()

    await holder
    // Nothing was lost — the seeded entry is still there, unacknowledged, for the next attempt.
    expect(readState()['/fake/repo']?.skillsmith?.sinceAckCount).toBe(1)
  }, 10_000)
})

describe('lock reclaim safety (pass-3 C1 — the actual bug this design fixes)', () => {
  it('never reclaims a lock held by a live-but-slow process', async () => {
    freshHome()
    process.env.SKILLSMITH_MCP_DISCONNECT_LOCK_STALE_MS = '150'
    // Deliberately shorter than the holder's hold time, so a failed
    // acquisition attempt here proves the reclaim was correctly refused
    // while the holder was still alive — not that we just got unlucky with
    // timing and happened to time out before the holder's natural release.
    process.env.SKILLSMITH_MCP_DISCONNECT_LOCK_ACQUIRE_TIMEOUT_MS = '400'

    const dir = tmpDir('mcp-disconnect-reclaim-live')
    const ready = join(dir, 'ready')
    const go = join(dir, 'go')
    const holder = spawnWorker('hold-lock', ready, go, '/fake/repo', 'skillsmith', ['900'])
    await waitForAsync(() => existsSync(ready))
    writeFileSync(go, '1')
    await sleep(50) // let the holder actually acquire before we contend

    const attemptWhileAlive = withLock(() => 'stolen')
    expect(attemptWhileAlive.acquired).toBe(false)

    await holder // holder releases naturally at ~900ms

    const attemptAfterRelease = withLock(() => 'ok')
    expect(attemptAfterRelease.acquired).toBe(true)
  }, 10_000)

  it('can reclaim a lock left behind by a genuinely dead process', async () => {
    freshHome()
    process.env.SKILLSMITH_MCP_DISCONNECT_LOCK_STALE_MS = '150'
    process.env.SKILLSMITH_MCP_DISCONNECT_LOCK_ACQUIRE_TIMEOUT_MS = '2000'

    const dir = tmpDir('mcp-disconnect-reclaim-dead')
    const ready = join(dir, 'ready')
    const go = join(dir, 'go')
    // Long hold time — but this process gets SIGKILLed mid-hold, simulating a
    // real crash. Spawns the compiled dist/ worker directly (see DIST_WORKER's
    // comment above) so the killed PID is the actual lock holder with no
    // intermediary process for the OS to orphan into an unreapable zombie.
    const holder = spawn(
      'node',
      [DIST_WORKER, 'hold-lock', ready, go, '/fake/repo', 'skillsmith', '5000'],
      {
        env: process.env,
      }
    )
    await waitForAsync(() => existsSync(ready))
    writeFileSync(go, '1')
    await sleep(100) // let it acquire the lock
    holder.kill('SIGKILL')
    await sleep(400) // past the 150ms stale threshold, with margin for the kill to land

    const outcome = withLock(() => 'ok')
    expect(outcome.acquired).toBe(true)
  }, 10_000)
})
