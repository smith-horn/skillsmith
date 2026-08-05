/**
 * SMI-5883 §8b -- cross-process proof that the two-level lock closes the
 * round-3 lock-theft race (two concurrent reclaimers can both validate the
 * same stale claim; the delayed one steals the winner's freshly-recreated
 * LIVE lock). This is the single most important regression guard in the
 * whole design: it is the test that specifically proves the round-3 race is
 * closed, with a negative control proving the test would actually catch a
 * regression if the fix were removed.
 *
 * Real child processes (`owned-lock-race-child.mjs`, spawned via
 * `node --import tsx`) synchronize on a filesystem barrier at the exact seam
 * (`onReclaimBoundary`) the reviewer required: after BOTH have independently
 * validated the SAME seeded dead claim, before EITHER has touched the
 * reclaim lock or removed anything. No `skipIf` -- every wait is bounded and
 * throws a labelled error on expiry (see `waitForAsync` below), so a
 * regression fails loudly instead of hanging the suite.
 */

import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { mintDeadPid } from '../helpers/deterministic-dead-pid.js'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const childPath = path.join(testDir, '..', 'helpers', 'owned-lock-race-child.mjs')

interface ChildResult {
  code: number | null
  stdout: string
  stderr: string
}

function spawnChild(argsList: string[]): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', childPath, ...argsList], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
  })
}

async function waitForAsync(
  predicate: () => boolean,
  label: string,
  capMs = 10_000
): Promise<void> {
  const deadline = Date.now() + capMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`[owned-lock-reclaim-race.test] timed out waiting for ${label}`)
    }
    await new Promise((r) => setTimeout(r, 5))
  }
}

function makeTempDir(prefix: string): { dir: string; barrierDir: string } {
  const dir = path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  const barrierDir = path.join(dir, 'barrier')
  mkdirSync(barrierDir, { recursive: true })
  return { dir, barrierDir }
}

function seedStaleLock(lockPath: string, deadPid: number): Buffer {
  writeFileSync(
    lockPath,
    JSON.stringify({
      v: 1,
      pid: deadPid,
      token: 'stale-token-0000',
      host: hostname(),
      acquiredAt: Date.now() - 60_000,
    }) + '\n'
  )
  return readFileSync(lockPath)
}

function readIfExists(p: string): Buffer | null {
  return existsSync(p) ? readFileSync(p) : null
}

describe('owned-lock cross-process reclaim race (§8b) -- the required test', () => {
  it('a delayed contender cannot steal the winner’s freshly-recreated live lock', async () => {
    const { dir, barrierDir } = makeTempDir('owned-lock-race')
    const target = path.join(dir, 'store.json')
    const lockPath = `${target}.lock`
    const reclaimPath = `${lockPath}.reclaim`
    const deadPid = mintDeadPid()
    const staleBytes = seedStaleLock(lockPath, deadPid)

    const pendingA = spawnChild([
      'A',
      target,
      barrierDir,
      '--signal-held=held-A',
      '--wait-release=release-A',
    ])
    const pendingB = spawnChild(['B', target, barrierDir, '--gate-on=held-A'])

    // Wait for A to hold and B to have recorded ITS reclaim-attempt outcome
    // (must come from the authoritative re-read finding a live owner, not
    // luck) -- while A STILL holds, i.e. before releasing it.
    await waitForAsync(() => existsSync(path.join(barrierDir, 'held-A')), "child A's held-A marker")
    await waitForAsync(
      () => readdirSync(barrierDir).some((f) => f.startsWith('attempted-B-')),
      "child B's reclaim-attempt outcome"
    )

    // ---- Assertions while A still holds ----
    // A-0 (anti-vacuity): the reclaim path actually executed.
    expect(existsSync(path.join(barrierDir, 'attempted-A-reclaimed'))).toBe(true)
    // A-1: the delayed contender did not enter concurrently.
    expect(existsSync(path.join(barrierDir, 'entered-B'))).toBe(false)
    // A-2: the lock is A's LIVE claim -- not removed/replaced by B.
    const duringClaim = JSON.parse(readFileSync(lockPath, 'utf-8')) as {
      v: number
      pid: number
      host: string
      token: string
    }
    expect(duringClaim.v).toBe(1)
    expect(duringClaim.host).toBe(hostname())
    expect(duringClaim.token).not.toBe('stale-token-0000')
    expect(readFileSync(lockPath).equals(staleBytes)).toBe(false)
    // A-3: B's refusal came from the authoritative re-read, not luck.
    expect(existsSync(path.join(barrierDir, 'attempted-B-not-stale'))).toBe(true)
    // A-4: both reclaim-lock acquisitions released.
    expect(existsSync(reclaimPath)).toBe(false)

    // ---- Liveness: the refusal is a refusal, not a deadlock ----
    writeFileSync(path.join(barrierDir, 'release-A'), '')
    await waitForAsync(
      () => existsSync(path.join(barrierDir, 'entered-B')),
      "child B's entered-B marker"
    )

    const [resultA, resultB] = await Promise.all([pendingA, pendingB])
    expect(resultA.code, `child A stderr:\n${resultA.stderr}`).toBe(0)
    expect(resultB.code, `child B stderr:\n${resultB.stderr}`).toBe(0)
    expect(existsSync(lockPath)).toBe(false)
    expect(existsSync(reclaimPath)).toBe(false)
    expect(readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false)

    rmSync(dir, { recursive: true, force: true })
  }, 20_000)

  it('negative control: removing the re-validation lets the delayed contender steal the live lock (proves the test discriminates)', async () => {
    const { dir, barrierDir } = makeTempDir('owned-lock-race-negctrl')
    const target = path.join(dir, 'store.json')
    const deadPid = mintDeadPid()
    seedStaleLock(`${target}.lock`, deadPid)

    const pendingA = spawnChild([
      'A',
      target,
      barrierDir,
      '--signal-held=held-A',
      '--wait-release=release-A',
      '--unsafe-skip-revalidation',
    ])
    const pendingB = spawnChild([
      'B',
      target,
      barrierDir,
      '--gate-on=held-A',
      '--unsafe-skip-revalidation',
    ])

    await waitForAsync(() => existsSync(path.join(barrierDir, 'held-A')), "child A's held-A marker")
    // Under the unsafe build, B does not wait for a genuine refusal -- it
    // proceeds straight to an unconditional unlink once it holds the
    // reclaim lock, so it reports 'reclaimed' too (never 'not-stale').
    await waitForAsync(
      () => readdirSync(barrierDir).some((f) => f.startsWith('attempted-B-')),
      "child B's reclaim-attempt outcome"
    )

    const reclaimedCount = readdirSync(barrierDir).filter((f) =>
      /^attempted-[AB]-reclaimed$/.test(f)
    ).length
    // THIS is the failure the safe build's A-2/A-3 assertions exist to
    // catch: with the authoritative re-read removed, BOTH children believe
    // they reclaimed the stale lock -- the exact round-3 lock-theft race.
    expect(reclaimedCount).toBe(2)
    expect(existsSync(path.join(barrierDir, 'attempted-B-not-stale'))).toBe(false)

    writeFileSync(path.join(barrierDir, 'release-A'), '')
    const [resultA, resultB] = await Promise.all([pendingA, pendingB])
    // Best-effort cleanup -- one of the two children's release() may warn
    // (ownership already stolen) but must not hang the suite.
    void resultA
    void resultB
    rmSync(dir, { recursive: true, force: true })
  }, 20_000)

  it('symmetric stress (50 iterations): exactly one reclaimed outcome per iteration, never two', async () => {
    const ITERATIONS = 50
    for (let i = 0; i < ITERATIONS; i++) {
      const { dir, barrierDir } = makeTempDir(`owned-lock-race-stress-${i}`)
      const target = path.join(dir, 'store.json')
      const deadPid = mintDeadPid()
      seedStaleLock(`${target}.lock`, deadPid)

      const pending1 = spawnChild(['1', target, barrierDir])
      const pending2 = spawnChild(['2', target, barrierDir])
      const [result1, result2] = await Promise.all([pending1, pending2])
      expect(result1.code, `child 1 stderr:\n${result1.stderr}`).toBe(0)
      expect(result2.code, `child 2 stderr:\n${result2.stderr}`).toBe(0)

      const reclaimedCount = readdirSync(barrierDir).filter((f) =>
        /^attempted-[12]-reclaimed$/.test(f)
      ).length
      expect(reclaimedCount, `iteration ${i}: expected exactly one reclaimed outcome`).toBe(1)
      // Never a `gone` for a participant that ALSO shows `reclaimed` (would
      // mean two successful reclaims were both recorded for one lock).
      const goneAndReclaimed =
        readIfExists(path.join(barrierDir, 'attempted-1-gone')) !== null &&
        readIfExists(path.join(barrierDir, 'attempted-1-reclaimed')) !== null
      expect(goneAndReclaimed).toBe(false)

      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
