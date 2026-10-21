/**
 * SMI-7148: releasing an owned lock is serialized on `<lock>.reclaim`.
 *
 * `releaseOwned` used to read the claim, then unlink the path, with nothing
 * excluding a reclaimer or `doctor locks` in between. Two windows followed:
 *
 *  - T1 (window 1): a reclaimer that judged the holder dead removes the lock,
 *    a third process creates its own, and the original holder's unlink then
 *    destroys that one.
 *  - T2a (window 2): `doctor locks` has a newer lock moved aside, its holder
 *    releases, finds the path empty and reports itself released, and doctor
 *    then links the lock back with nobody left to release it.
 *
 * Also here: T3 (a leftover `.reclaim` fails the release closed), T4 (a failure
 * to create `.reclaim` fails closed and never throws) and T5 (the reclaim
 * lock's own release is unguarded, so no `.reclaim.reclaim` ever appears).
 * T2b, the cross-process form of T2a, is in
 * tests/integration/owned-lock-release-doctor.test.ts.
 *
 * `node:fs` is mocked because the source modules use named imports: the hooks
 * run inside `unlinkSync` (T1), make `openSync` fail for the `.reclaim` temp
 * file only (T4), and record every file created or linked (T5).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const inject = vi.hoisted(() => ({
  unlinkHook: null as null | { path: string; run: () => void },
  reclaimLinkHook: null as null | {
    path: string
    runOnAttempt: number
    attempts: number
    run: () => void
  },
  failReclaimTemp: false,
  failReclaimTempHits: 0,
  watch: false,
  linked: [] as string[],
  allLinked: [] as string[],
  created: [] as string[],
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const unlinkSync = ((p: fs.PathLike) => {
    const hook = inject.unlinkHook
    if (hook !== null && String(p) === hook.path) {
      inject.unlinkHook = null // one shot, disarmed before it runs
      hook.run()
    }
    return actual.unlinkSync(p)
  }) as typeof actual.unlinkSync
  const openSync = ((p: fs.PathLike, ...rest: unknown[]) => {
    const flags = rest[0]
    if (typeof flags === 'string' && flags.includes('w')) {
      if (inject.watch) inject.created.push(String(p))
      if (inject.failReclaimTemp && /\.lock\.reclaim\.[0-9a-f]+\.tmp$/.test(String(p))) {
        inject.failReclaimTempHits++
        throw Object.assign(new Error(`ENOSPC: no space left on device, open '${String(p)}'`), {
          code: 'ENOSPC',
        })
      }
    }
    return (actual.openSync as (p: fs.PathLike, ...r: unknown[]) => number)(p, ...rest)
  }) as typeof actual.openSync
  const linkSync = ((existing: fs.PathLike, created: fs.PathLike) => {
    const hook = inject.reclaimLinkHook
    if (hook !== null && String(created) === hook.path) {
      hook.attempts++
      if (hook.attempts === hook.runOnAttempt) hook.run()
    }
    if (inject.watch) {
      inject.linked.push(String(created))
      inject.allLinked.push(String(created))
    }
    return actual.linkSync(existing, created)
  }) as typeof actual.linkSync
  return {
    ...actual,
    unlinkSync,
    openSync,
    linkSync,
    default: { ...actual, unlinkSync, openSync, linkSync },
  }
})

import { acquireOwnedLock, RECLAIM_LOCK_TIMEOUT_MS } from '../../../src/config/owned-lock.js'
import { withFileLock } from '../../../src/config/file-lock.js'
import { releaseLock } from '../../../src/config/lock-doctor.js'
import { createLockExclusive, tryReclaimUnderLock } from '../../../src/config/owned-lock.claim.js'
import type { ReclaimOutcome } from '../../../src/config/owned-lock.types.js'
import { releaseOwned } from '../../../src/config/owned-lock.release.js'
import { mintDeadPid } from '../../helpers/deterministic-dead-pid.js'

const roots: string[] = []
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  inject.unlinkHook = null
  inject.reclaimLinkHook = null
  inject.failReclaimTemp = false
  inject.failReclaimTempHits = 0
  inject.watch = false
  inject.linked = []
  inject.allLinked = []
  inject.created = []
  vi.restoreAllMocks()
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

function fresh(): { dir: string; target: string; lockPath: string; reclaimPath: string } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'release-reclaim-')))
  roots.push(dir)
  const target = path.join(dir, 'm.json')
  const lockPath = `${target}.lock`
  return { dir, target, lockPath, reclaimPath: `${lockPath}.reclaim` }
}

function v1(pid: number, token: string): string {
  return JSON.stringify({ v: 1, pid, token, host: os.hostname(), acquiredAt: 1 }) + '\n'
}

/** The file's text, or null when it is not there (so a missing file fails an equality, not a read). */
function readOrNull(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

const warned = (name: string): boolean =>
  warnSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes(name))

const TOKEN = 'a'.repeat(16)

describe('T1: window 1, a reclaimer cannot destroy the new owner’s lock', () => {
  it('a reclaimer and a new owner racing the unlink leave the new owner’s lock in place', () => {
    const { lockPath, reclaimPath } = fresh()
    const B = v1(process.pid, 'b'.repeat(16))
    // Ours by token, but its pid is dead: a reclaimer reads it as abandoned.
    fs.writeFileSync(lockPath, v1(mintDeadPid(), TOKEN))
    const seen = {
      hookRan: 0,
      reclaim: null as ReclaimOutcome | null,
      bAcquired: null as boolean | null,
    }
    inject.unlinkHook = {
      path: lockPath,
      run: () => {
        seen.hookRan++
        seen.reclaim = tryReclaimUnderLock(lockPath, reclaimPath, { reclaimLockTimeoutMs: 0 })
        seen.bAcquired = createLockExclusive(lockPath, B)
      },
    }

    const released = releaseOwned(lockPath, TOKEN)

    // The property: nobody who was told "yours" has lost the lock.
    expect(
      seen.bAcquired === false || readOrNull(lockPath) === B,
      `B acquired=${String(seen.bAcquired)}, lock on disk=${JSON.stringify(readOrNull(lockPath))}`
    ).toBe(true)
    // The mechanism, and the presence control that the competitor really ran
    // between the ownership read and the unlink.
    expect(seen.hookRan).toBe(1)
    expect(seen.reclaim).toBe('unavailable')
    expect(seen.bAcquired).toBe(false)
    expect(released).toBe(true)
    expect(fs.existsSync(lockPath)).toBe(false)
    expect(fs.existsSync(reclaimPath)).toBe(false)
  })

  it('control: with no competitor, release removes its own lock, returns true and leaves no .reclaim', () => {
    const { lockPath, reclaimPath } = fresh()
    fs.writeFileSync(lockPath, v1(mintDeadPid(), TOKEN))
    expect(releaseOwned(lockPath, TOKEN)).toBe(true)
    expect(fs.existsSync(lockPath)).toBe(false)
    expect(fs.existsSync(reclaimPath)).toBe(false)
    expect(warned('lock_release_')).toBe(false)
  })
})

describe('T2a: window 2, a holder releasing while doctor has its lock aside', () => {
  function runDoctor(releaseDuringAside: boolean): {
    outcome: string
    refusal: string | undefined
    released: boolean | null
    aside: number
    B: string
    lockPath: string
    dir: string
  } {
    const { dir, lockPath } = fresh()
    const tokB = 'c'.repeat(16)
    const B = v1(process.pid, tokB)
    fs.writeFileSync(lockPath, v1(mintDeadPid(), 'd'.repeat(16))) // stale; doctor may release it
    const seen = { asideRan: 0, released: null as boolean | null }
    const r = releaseLock(lockPath, {
      beforeFinalCheck: () => {
        fs.rmSync(lockPath) // the stale holder is gone ...
        expect(createLockExclusive(lockPath, B)).toBe(true) // ... and B holds the path
      },
      afterMoveAside: () => {
        seen.asideRan++
        if (releaseDuringAside) {
          seen.released = releaseOwned(lockPath, tokB, { reclaimLockTimeoutMs: 50 })
        }
      },
    })
    expect(seen.asideRan).toBe(1) // presence: B's lock really was set aside
    return {
      outcome: r.outcome,
      refusal: r.outcome === 'refused' ? r.refusal : undefined,
      released: seen.released,
      aside: fs.readdirSync(dir).filter((n) => n.includes('.doctor-')).length,
      B,
      lockPath,
      dir,
    }
  }

  it('B’s release during the aside does not report released while its lock is put back', () => {
    const run = runDoctor(true)

    // The property: a claim reported released is not still on disk.
    expect(
      !(run.released === true && readOrNull(run.lockPath) === run.B),
      `released=${String(run.released)}, B on disk=${String(readOrNull(run.lockPath) === run.B)}`
    ).toBe(true)
    // The mechanism: B could not take .reclaim (doctor holds it), nothing was
    // removed by B, and doctor refused and put B's lock back.
    expect(run.released).toBe(false)
    expect(warned('lock_release_reclaim_unavailable')).toBe(true)
    expect(run.outcome).toBe('refused')
    expect(run.refusal).toBe('changed')
    expect(readOrNull(run.lockPath)).toBe(run.B)
    expect(run.aside).toBe(0)
  })

  it('control: with no release during the aside, doctor refuses "changed" and B’s lock is back', () => {
    const run = runDoctor(false)
    expect(run.released).toBeNull()
    expect(run.outcome).toBe('refused')
    expect(run.refusal).toBe('changed')
    expect(readOrNull(run.lockPath)).toBe(run.B)
    expect(warned('lock_release_')).toBe(false)
  })
})

describe('T3: release fails closed when .reclaim stays held', () => {
  it('waits out the full budget, removes nothing and names both paths; then releases once .reclaim is gone', () => {
    const { lockPath, reclaimPath } = fresh()
    const ours = v1(process.pid, TOKEN)
    fs.writeFileSync(lockPath, ours)
    const orphan = v1(process.pid, 'e'.repeat(16)) // a live-owner .reclaim: the orphan stand-in
    fs.writeFileSync(reclaimPath, orphan)

    const t0 = Date.now()
    const released = releaseOwned(lockPath, TOKEN) // the default budget, deliberately
    const elapsed = Date.now() - t0

    expect(released).toBe(false)
    expect(readOrNull(lockPath)).toBe(ours)
    expect(readOrNull(reclaimPath)).toBe(orphan)
    expect(warned('lock_release_reclaim_unavailable')).toBe(true)
    const message = String(
      warnSpy.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .find((m: string) => m.includes('_unavailable'))
    )
    expect(message).toContain(lockPath)
    expect(message).toContain(`doctor locks --release ${reclaimPath}`)
    expect(elapsed).toBeGreaterThanOrEqual(RECLAIM_LOCK_TIMEOUT_MS - 20)

    // Presence, in the same run: the same call succeeds once the orphan is gone.
    fs.rmSync(reclaimPath)
    expect(releaseOwned(lockPath, TOKEN)).toBe(true)
    expect(fs.existsSync(lockPath)).toBe(false)
    expect(fs.existsSync(reclaimPath)).toBe(false)
  })

  it('the release a caller gets back rides out a .reclaim that is held only briefly', () => {
    // acquireOwnedLock's release must not inherit a zero wait: a holder that
    // lets go a moment later (here, between the first and second try) must not
    // leave the lock behind.
    const { target, lockPath, reclaimPath } = fresh()
    const release = acquireOwnedLock(target, { timeoutMs: 1_000, reclaimLockTimeoutMs: 0 })
    fs.writeFileSync(reclaimPath, v1(process.pid, 'e'.repeat(16))) // momentarily held
    inject.reclaimLinkHook = {
      path: reclaimPath,
      runOnAttempt: 2,
      attempts: 0,
      run: () => fs.rmSync(reclaimPath), // the other holder lets go before the second try
    }

    expect(release()).toBe(true)

    expect(inject.reclaimLinkHook?.attempts).toBeGreaterThanOrEqual(2) // it did retry
    expect(fs.existsSync(lockPath)).toBe(false)
    expect(fs.existsSync(reclaimPath)).toBe(false)
    expect(warned('lock_release_')).toBe(false)
  })

  it('never takes over a leftover .reclaim, even one whose owner is dead', () => {
    const { lockPath, reclaimPath } = fresh()
    const ours = v1(process.pid, TOKEN)
    fs.writeFileSync(lockPath, ours)
    const dead = v1(mintDeadPid(), 'e'.repeat(16))
    fs.writeFileSync(reclaimPath, dead)

    expect(releaseOwned(lockPath, TOKEN, { reclaimLockTimeoutMs: 0 })).toBe(false)
    expect(readOrNull(lockPath)).toBe(ours)
    expect(readOrNull(reclaimPath)).toBe(dead)
  })
})

describe('T4: release never throws when .reclaim cannot be created', () => {
  it('ENOSPC on the .reclaim temp file: false, lock left, a warning that names the code', () => {
    const { lockPath } = fresh()
    const ours = v1(process.pid, TOKEN)
    fs.writeFileSync(lockPath, ours)
    inject.failReclaimTemp = true

    let released: boolean | undefined
    expect(() => {
      released = releaseOwned(lockPath, TOKEN)
    }).not.toThrow()

    expect(released).toBe(false)
    expect(readOrNull(lockPath)).toBe(ours)
    expect(warned('lock_release_reclaim_failed')).toBe(true)
    expect(warned('ENOSPC')).toBe(true)
    expect(inject.failReclaimTempHits).toBeGreaterThanOrEqual(1) // the mock was hit
  })

  it('withFileLock returns the work’s result when .reclaim cannot be created and the logger throws', async () => {
    const { target, lockPath } = fresh()
    warnSpy.mockImplementation(() => {
      throw new Error('logger exploded')
    })

    const out = await withFileLock(
      target,
      'test',
      async () => {
        inject.failReclaimTemp = true // only the release is affected
        return 'saved'
      },
      { rank: 'unordered' }
    )

    expect(out).toBe('saved')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('lock_release_reclaim_failed'))
    expect(inject.failReclaimTempHits).toBeGreaterThanOrEqual(1)
    expect(fs.existsSync(lockPath)).toBe(true) // left behind, not silently dropped
  })
})

describe('T5: the reclaim lock’s own release is unguarded', () => {
  const reclaimLinks = (): string[] => inject.linked.filter((p) => p.endsWith('.lock.reclaim'))
  const nested = (): string[] =>
    [...inject.allLinked, ...inject.created].filter((p) => p.includes('.reclaim.reclaim'))

  it('auto-reclaim, a guarded release and a doctor release never create a .reclaim.reclaim', () => {
    const { target, lockPath, dir } = fresh()
    inject.watch = true

    // (a) an auto-reclaim of a dead holder's lock
    fs.writeFileSync(lockPath, v1(mintDeadPid(), TOKEN))
    const release = acquireOwnedLock(target, { timeoutMs: 2_000, reclaimProbeAfterMs: 0 })
    expect(reclaimLinks().length, 'auto-reclaim took .reclaim').toBeGreaterThanOrEqual(1)

    // (b) the guarded release of the main lock just acquired
    inject.linked = []
    expect(release()).toBe(true)
    expect(reclaimLinks().length, 'the guarded release took .reclaim').toBeGreaterThanOrEqual(1)

    // (c) a doctor release of a dead lock
    inject.linked = []
    fs.writeFileSync(lockPath, v1(mintDeadPid(), 'f'.repeat(16)))
    expect(releaseLock(lockPath).outcome).toBe('released')
    expect(reclaimLinks().length, 'doctor took .reclaim').toBeGreaterThanOrEqual(1)

    // The property: across all three, no third-level file was ever made.
    expect(nested()).toEqual([])
    expect(inject.created.some((p) => p.includes('.reclaim.'))).toBe(true) // the watch saw .reclaim temps
    expect(fs.readdirSync(dir).filter((n) => n.includes('reclaim'))).toEqual([])
  })
})
