/**
 * SMI-7143 (A1 step 0): the manifest lock's pre-commit check and the shared
 * locked update. T-M1 (legacy lock theft), T-M3 (lock-age boundaries, on the
 * two clocks the owner chose on 2026-10-18), T-L1 (waiting never blocks the
 * event loop), and the retry rule.
 *
 * T-M1 in the plan stops the holder with SIGSTOP for 32 s. The legacy stealer
 * decides only from the lock file's mtime age (`legacy-manifest-lock.ts`), so
 * here the holder pauses at its load and the lock's mtime is backdated 31 s:
 * the same protocol state, without a 32 s test.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireOwnedLock } from '../../../src/config/owned-lock.js'
import { withFileLock } from '../../../src/config/file-lock.js'
import { writeManifestAtomic } from '../../../src/services/skill-manifest.atomic.js'
import {
  MAX_LOCK_AGE_NS,
  ManifestLockLost,
  lockStillOurs,
  runManifestUpdate,
  snapshotLock,
} from '../../../src/services/skill-manifest.lock.js'
import type { LockSnapshot } from '../../../src/services/skill-manifest.lock.js'
import { legacyAcquire, legacyRelease } from './legacy-manifest-lock.js'

type Manifest = { version: string; installedSkills: Record<string, unknown> }

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})
const tmp = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mlock-')))
  roots.push(root)
  const manifestPath = path.join(root, 'manifest.json')
  fs.writeFileSync(manifestPath, JSON.stringify({ version: '1.0.0', installedSkills: {} }))
  return { root, manifestPath, lockPath: `${manifestPath}.lock` }
}
const read = (p: string): Manifest => JSON.parse(fs.readFileSync(p, 'utf8')) as Manifest
const load = async (p: string): Promise<Manifest> => read(p)
const add =
  (key: string) =>
  (m: Manifest): Manifest => ({
    ...m,
    installedSkills: { ...m.installedSkills, [key]: { id: key } },
  })
const backdate = (p: string, seconds: number) => {
  const t = Date.now() / 1000 - seconds
  fs.utimesSync(p, t, t)
}
const gate = () => {
  let open: () => void = () => {}
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { open, opened }
}

describe('T-M3: lock-age boundaries on the two clocks', () => {
  const S = 1_000_000_000n
  const T0 = 1_800_000_000n * S
  const snap = (mtimeNs: bigint): LockSnapshot => ({
    ino: 7n,
    mtimeNs,
    bytes: Buffer.from('claim'),
  })
  const acquired = snap(T0)
  const at = (fsAgeNs: bigint, wallAgeNs = fsAgeNs) =>
    lockStillOurs(acquired, snap(T0), { fsNs: T0 + fsAgeNs, wallNs: T0 + wallAgeNs })

  it('25 s is the limit', () => {
    expect(MAX_LOCK_AGE_NS).toBe(25n * S)
  })
  it('ages 0 and 24.999999 s pass', () => {
    expect(at(0n)).toBe(null)
    expect(at(24_999_999_000n)).toBe(null)
  })
  for (const [label, age] of [
    ['25 s', 25n * S],
    ['25.000001 s', 25_000_001_000n],
    ['30 s', 30n * S],
  ] as const) {
    it(`age ${label} on the file clock fails closed`, () => {
      expect(at(age)).toMatch(/25 s old or older/)
    })
    it(`age ${label} on the wall clock fails closed even when the file clock says young`, () => {
      expect(at(0n, age)).toMatch(/25 s old or older/)
    })
  }
  it('a lock 1 ns newer than the file just written beside it fails closed', () => {
    expect(at(-1n, 0n)).toMatch(/file clock moved backwards/)
  })
  it('a lock that only looks newer than the wall clock (skew) passes', () => {
    expect(at(5_000_000n, -740_000n)).toBe(null)
  })
  it('a missing lock, another inode, or other bytes fail', () => {
    const clocks = { fsNs: T0, wallNs: T0 }
    expect(lockStillOurs(acquired, null, clocks)).toMatch(/gone/)
    expect(lockStillOurs(acquired, { ...snap(T0), ino: 8n }, clocks)).toMatch(/another inode/)
    expect(lockStillOurs(acquired, { ...snap(T0), bytes: Buffer.from('other') }, clocks)).toMatch(
      /content changed/
    )
  })
})

describe('T-M3: the legacy stealer itself (E18)', () => {
  it('steals a lock backdated 29.7 s within 1 s', async () => {
    const { manifestPath, lockPath } = tmp()
    fs.writeFileSync(lockPath, 'held')
    backdate(lockPath, 29.7)
    const t0 = Date.now()
    await legacyAcquire(manifestPath, { timeoutMs: 2000 })
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(fs.readFileSync(lockPath, 'utf8')).toBe('424242')
  })
  it('never steals a future-dated lock', async () => {
    const { manifestPath, lockPath } = tmp()
    fs.writeFileSync(lockPath, 'held')
    backdate(lockPath, -60)
    await expect(legacyAcquire(manifestPath, { timeoutMs: 1500 })).rejects.toThrow(
      /Failed to acquire/
    )
    expect(fs.readFileSync(lockPath, 'utf8')).toBe('held')
  })
})

describe('T-M1: a legacy writer that steals the lock keeps its change', () => {
  /**
   * The holder loads, then pauses. Its lock is backdated past the legacy
   * threshold; the legacy writer steals it, saves its own change, and holds
   * the lock a while longer. The holder then resumes.
   */
  async function scenario(holderWrite: 'runManifestUpdate' | 'no-check') {
    const { manifestPath, lockPath } = tmp()
    const paused = gate()
    const resume = gate()
    let loads = 0
    const holderLoad = async () => {
      const m = read(manifestPath)
      loads += 1
      if (loads === 1) {
        paused.open()
        await resume.opened
      }
      return m
    }
    const holder =
      holderWrite === 'runManifestUpdate'
        ? runManifestUpdate<Manifest>({
            manifestPath,
            load: holderLoad,
            update: add('holder'),
            onLegacyWait: () => {},
          })
        : withFileLock(manifestPath, 'no-check control', async () => {
            const m = add('holder')(await holderLoad())
            await writeManifestAtomic(manifestPath, JSON.stringify(m))
          })
    await paused.opened
    backdate(lockPath, 31)
    await legacyAcquire(manifestPath, { timeoutMs: 2000 })
    fs.writeFileSync(manifestPath, JSON.stringify(add('legacy')(read(manifestPath))))
    resume.open()
    // The legacy writer still holds its stolen lock while the holder resumes.
    await new Promise((resolve) => setTimeout(resolve, 300))
    const legacyLockWhileHeld = fs.readFileSync(lockPath, 'utf8')
    await legacyRelease(manifestPath)
    await holder
    return { final: read(manifestPath), loads, legacyLockWhileHeld }
  }

  it('the holder does not save over it, retries from the load, and both changes survive', async () => {
    const r = await scenario('runManifestUpdate')
    expect(Object.keys(r.final.installedSkills).sort()).toEqual(['holder', 'legacy'])
    expect(r.loads).toBe(2)
    // The holder neither removed nor overwrote the legacy writer's claim (E8).
    expect(r.legacyLockWhileHeld).toBe('424242')
  })

  it('control: without the pre-commit check the legacy change is lost', async () => {
    const r = await scenario('no-check')
    expect(Object.keys(r.final.installedSkills)).toEqual(['holder'])
  })
})

describe('the retry rule', () => {
  it('a second loss throws ManifestLockLost, after two loads, and saves nothing', async () => {
    const { manifestPath, lockPath } = tmp()
    const before = fs.readFileSync(manifestPath)
    let loads = 0
    const sabotage = async () => {
      loads += 1
      // Each attempt's own lock is aged past 25 s before the rename. The claim
      // stays this process's, so its release removes it and the retry starts
      // from a free lock.
      backdate(lockPath, 26)
      return read(manifestPath)
    }
    await expect(
      runManifestUpdate<Manifest>({ manifestPath, load: sabotage, update: add('x') })
    ).rejects.toBeInstanceOf(ManifestLockLost)
    expect(loads).toBe(2)
    expect(fs.readFileSync(manifestPath).equals(before)).toBe(true)
    expect(snapshotLock(lockPath)).toBe(null)
  })

  it('an update that returns a promise is refused and nothing is saved', async () => {
    const { manifestPath } = tmp()
    const before = fs.readFileSync(manifestPath)
    await expect(
      runManifestUpdate<Manifest>({
        manifestPath,
        load: () => load(manifestPath),
        update: (async (m: Manifest) => m) as unknown as (m: Manifest) => Manifest,
      })
    ).rejects.toThrow(/update must be synchronous/)
    expect(fs.readFileSync(manifestPath).equals(before)).toBe(true)
  })

  it('a clean update saves once and leaves no lock behind', async () => {
    const { manifestPath, lockPath } = tmp()
    await runManifestUpdate<Manifest>({
      manifestPath,
      load: () => load(manifestPath),
      update: add('a'),
    })
    expect(Object.keys(read(manifestPath).installedSkills)).toEqual(['a'])
    expect(snapshotLock(lockPath)).toBe(null)
  })
})

describe('T-L1: waiting for the manifest lock never blocks the event loop', () => {
  /** How late a 100 ms timer fires while `contend` runs. */
  async function lateness(contend: () => Promise<unknown> | unknown): Promise<number> {
    const t0 = performance.now()
    const timer = new Promise<number>((resolve) =>
      setTimeout(() => resolve(performance.now() - t0), 100)
    )
    await Promise.resolve()
      .then(contend)
      .catch(() => undefined)
    return (await timer) - 100
  }

  it('a same-process contender waits without delaying a 100 ms timer by more than 50 ms', async () => {
    const { manifestPath } = tmp()
    const release = gate()
    const holder = runManifestUpdate<Manifest>({
      manifestPath,
      load: async () => {
        await release.opened
        return read(manifestPath)
      },
      update: add('holder'),
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    let contender: Promise<void> | undefined
    const late = await lateness(() => {
      contender = runManifestUpdate<Manifest>({
        manifestPath,
        load: () => load(manifestPath),
        update: add('contender'),
      })
      setTimeout(release.open, 150)
    })
    await holder
    await contender
    expect(late).toBeLessThan(50)
    expect(Object.keys(read(manifestPath).installedSkills).sort()).toEqual(['contender', 'holder'])
  })

  it('control: a blocking acquireOwnedLock delays the same timer past 50 ms', async () => {
    const { manifestPath } = tmp()
    const release = acquireOwnedLock(manifestPath, { timeoutMs: 0, reclaimProbeAfterMs: 0 })
    try {
      const late = await lateness(() => acquireOwnedLock(manifestPath, { timeoutMs: 400 }))
      expect(late).toBeGreaterThan(50)
    } finally {
      release()
    }
  })
})
