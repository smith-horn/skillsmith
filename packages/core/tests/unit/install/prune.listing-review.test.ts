/**
 * SMI-6531 (A1 step 6c-ii-a): the review findings on wave 1 of the read-only
 * listing layer. Each block is one finding: the classifier's area check, a
 * symlinked copy root, the size walk crossing a mount, the backup lister's
 * device/owner/mount checks, hidden entries in the parked lister, the sidecar
 * `exists()` reason, and the space warning's unknown-free-space, both-facts and
 * symlinked-store cases.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyCopy } from '../../../src/install/prune.classify.js'
import { measure } from '../../../src/install/prune.measure.js'
import { listBackupStore } from '../../../src/install/prune.list.backups.js'
import { listParkedArea } from '../../../src/install/prune.list.parked.js'
import { evaluateParkedUsage } from '../../../src/install/parked-usage.js'
import type { ParkedUsageEntry } from '../../../src/install/parked-usage.js'
import type { ListedCopy } from '../../../src/install/prune.list.types.js'
import { makeParent, parkCopy, removeFixture } from './prune.walk.helpers.js'
import type { PruneFixture } from './prune.walk.helpers.js'
import { injectMountinfo, makeBackup, mountinfoLine, tmpRoot } from './prune.list.helpers.js'

const fixtures: PruneFixture[] = []
const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const f of fixtures.splice(0)) removeFixture(f)
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})
const parent = (): PruneFixture => {
  const f = makeParent('prune-rev-')
  fixtures.push(f)
  return f
}
const root = (): string => {
  const r = tmpRoot('prune-rev-')
  roots.push(r)
  return r
}
const MB = 1e6

/** Makes lstat (bigint form only) report a shifted `dev` and/or `uid` for the paths `match` picks. */
function spoofLstat(match: (p: string) => boolean, shift: { dev?: bigint; uid?: bigint }): void {
  const real = fs.lstatSync.bind(fs) as (p: fs.PathLike, o?: unknown) => fs.BigIntStats
  vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, o?: { bigint?: boolean }) => {
    const st = real(p, o)
    if (typeof p !== 'string' || o?.bigint !== true || !match(p)) return st
    return new Proxy(st, {
      get(t, k) {
        if (k === 'dev' && shift.dev !== undefined) return t.dev + shift.dev
        if (k === 'uid' && shift.uid !== undefined) return t.uid + shift.uid
        const v = Reflect.get(t, k) as unknown
        return typeof v === 'function' ? (v as () => unknown).bind(t) : v
      },
    })
  }) as unknown as typeof fs.lstatSync)
}

describe('finding 1: a backup copy with no area is never clean', () => {
  it('a backup-store input whose `area` is missing is unverified/area-unknown', () => {
    const state = root()
    const b = makeBackup({ state, skillsDir: '/skills/a' })
    const listed = listBackupStore(b.updateDir).areas.flatMap((a) => a.copies)
    const copy = { ...(listed[0] as ListedCopy) }
    expect(classifyCopy(copy, 'backup').klass).toBe('clean')
    delete copy.area
    const k = classifyCopy(copy, 'backup')
    expect(k.klass).toBe('unverified')
    expect(k.reason).toBe('area-unknown')
  })
})

describe('finding 3: a parked symlink is not checked for mounts at its target', () => {
  const link = (target: string): ListedCopy => {
    const f = parent()
    const opDir = path.join(f.parent, 'op-1')
    fs.mkdirSync(opDir)
    const copyPath = path.join(opDir, 'lnk-1234abcd')
    fs.symlinkSync(target, copyPath)
    return {
      copyPath,
      name: 'lnk-1234abcd',
      opId: 'op-1',
      parentDir: opDir,
      sidecarPath: `${copyPath}.json`,
      stagingRoot: f.parent,
      opDir,
    }
  }

  it('a dangling link is not mounted, and has no false mountinfo error', () => {
    const k = classifyCopy(link('/nonexistent-target-for-prune-review'), 'parked')
    expect(k.klass).toBe('held')
    expect(k.reason).toBe('sidecar-absent')
    expect(k.detail ?? '').not.toContain('mountinfo')
  })

  it('a link to / is not mounted (a symlink is not a mount point)', () => {
    const k = classifyCopy(link('/'), 'parked')
    expect(k.klass).toBe('held')
    expect(k.reason).toBe('sidecar-absent')
  })

  it('a real mount at the link name itself is still mounted', () => {
    const copy = link('/nonexistent-target-for-prune-review')
    injectMountinfo(mountinfoLine(copy.copyPath))
    expect(classifyCopy(copy, 'parked').klass).toBe('mounted')
  })

  it('a directory that cannot be resolved is unverified/realpath-failed, never a mountinfo reason', () => {
    const copy = link('/')
    const real = fs.realpathSync.bind(fs) as (p: fs.PathLike, o?: unknown) => string
    vi.spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
      if (p === copy.opDir) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      return real(p, o)
    }) as unknown as typeof fs.realpathSync)
    const k = classifyCopy(copy, 'parked')
    expect(k.klass).toBe('unverified')
    expect(k.reason).toBe('realpath-failed')
    expect(k.detail).toContain('EACCES')
  })
})

describe('finding 4: measure() does not descend into another device', () => {
  it('an entry on another device is counted, and nothing beneath it is', () => {
    const dir = root()
    const tree = path.join(dir, 'tree')
    const sub = path.join(tree, 'sub')
    fs.mkdirSync(sub, { recursive: true })
    fs.writeFileSync(path.join(sub, 'inner'), Buffer.alloc(100_000, 1))
    const inner = fs.lstatSync(path.join(sub, 'inner'), { bigint: true })
    const innerKey = `${inner.dev}:${inner.ino}`
    expect(measure(tree).units.has(innerKey)).toBe(true)
    const subSt = fs.lstatSync(sub, { bigint: true })
    spoofLstat((p) => p === sub || p.startsWith(`${sub}${path.sep}`), { dev: 7n })
    const m = measure(tree)
    // The entry on the other device is counted; the file beneath it is not reached.
    expect(m.units.has(`${subSt.dev + 7n}:${subSt.ino}`)).toBe(true)
    expect(m.units.has(`${inner.dev + 7n}:${inner.ino}`)).toBe(false)
  })
})

describe('finding 6: the backup lister checks device, owner and mount at every level', () => {
  const levels = (): { updateDir: string; dirs: Record<string, string> } => {
    const state = root()
    const b = makeBackup({ state, skillsDir: '/skills/a' })
    const rootDir = path.dirname(b.areaPath)
    return {
      updateDir: b.updateDir,
      dirs: { client: path.dirname(rootDir), rootKey: rootDir, dirName: b.areaPath },
    }
  }

  for (const level of ['client', 'rootKey', 'dirName']) {
    it(`a ${level} directory on another device is an anomaly and nothing below it is listed`, () => {
      const { updateDir, dirs } = levels()
      const bad = dirs[level] as string
      spoofLstat((p) => p === bad, { dev: 5n })
      const l = listBackupStore(updateDir)
      expect(l.areas).toEqual([])
      expect([...l.anomalies.map((a) => a.path)]).toContain(bad)
    })

    it(`a ${level} directory owned by another user is an anomaly and nothing below it is listed`, () => {
      const { updateDir, dirs } = levels()
      const bad = dirs[level] as string
      spoofLstat((p) => p === bad, { uid: 1n })
      const l = listBackupStore(updateDir)
      expect(l.areas).toEqual([])
      expect([...l.anomalies.map((a) => a.path)]).toContain(bad)
    })

    it(`a mount point at the ${level} directory is an anomaly and nothing below it is listed`, () => {
      const { updateDir, dirs } = levels()
      const bad = dirs[level] as string
      injectMountinfo(mountinfoLine(bad))
      const l = listBackupStore(updateDir)
      expect(l.areas).toEqual([])
      expect([...l.anomalies.map((a) => a.path)]).toContain(bad)
    })
  }

  it('control: unspoofed, the same tree lists its one area', () => {
    const { updateDir } = levels()
    expect(listBackupStore(updateDir).areas).toHaveLength(1)
  })
})

describe('finding 7: hidden entries are anomalies in both listers', () => {
  it('a dot-name inside a parked op dir is an anomaly, not a copy', () => {
    const f = parent()
    const c = parkCopy(f.parent, 'tree')
    fs.writeFileSync(path.join(c.opDir, '.DS_Store'), 'x')
    const l = listParkedArea(f.parent)
    expect(l.copies.map((x) => x.copyPath)).toEqual([c.copyPath])
    expect(l.anomalies.map((a) => a.path)).toEqual([path.join(c.opDir, '.DS_Store')])
  })

  it('a parked copy of a dot-named entry is still a copy', () => {
    const f = parent()
    const c = parkCopy(f.parent, '.hid')
    const l = listParkedArea(f.parent)
    expect(l.copies.map((x) => x.copyPath)).toEqual([c.copyPath])
    expect(l.anomalies).toEqual([])
  })

  it('a non-.prune dot-entry in the area is reported, not silently dropped', () => {
    const f = parent()
    const c = parkCopy(f.parent, 'tree')
    const hidden = path.join(path.dirname(c.opDir), '.DS_Store')
    fs.writeFileSync(hidden, 'x')
    const l = listParkedArea(f.parent)
    expect(l.copies).toHaveLength(1)
    expect(l.anomalies.map((a) => a.path)).toEqual([hidden])
  })
})

describe('finding 8: reason text', () => {
  it('a sidecar whose lstat fails with anything but ENOENT is held/sidecar-unreadable', () => {
    const state = root()
    const b = makeBackup({ state, skillsDir: '/skills/a' })
    const copy = listBackupStore(b.updateDir).areas.flatMap((a) => a.copies)[0] as ListedCopy
    const real = fs.lstatSync.bind(fs) as (p: fs.PathLike, o?: unknown) => unknown
    vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
      if (p === copy.sidecarPath) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      return real(p, o)
    }) as unknown as typeof fs.lstatSync)
    const k = classifyCopy(copy, 'backup')
    expect(k.klass).toBe('held')
    expect(k.reason).toBe('sidecar-unreadable')
    expect(k.detail).toContain('EACCES')
  })

  it('a sidecar that is truly absent is still held/sidecar-absent', () => {
    const state = root()
    const b = makeBackup({ state, skillsDir: '/skills/a', noSidecar: true })
    const copy = listBackupStore(b.updateDir).areas.flatMap((a) => a.copies)[0] as ListedCopy
    expect(classifyCopy(copy, 'backup').reason).toBe('sidecar-absent')
  })
})

const entry = (storeDir: string, bytes: number, over: Partial<ParkedUsageEntry> = {}) => ({
  path: path.join(storeDir, `e-${bytes}`),
  storeDir,
  units: new Map([[`1:${bytes}`, bytes]]),
  unmeasured: 0,
  originPath: null,
  opId: `op-${bytes}`,
  ...over,
})
const throwingStatfs = () => {
  throw new Error('EIO')
}

describe('finding 2: unknown free space is never silence', () => {
  it('500 MB held with a failing statfs warns, and says free space could not be read', () => {
    const w = evaluateParkedUsage([entry(root(), 500 * MB)], { statfs: throwingStatfs })
    expect(w.warn).toBe(true)
    expect(w.perVolume[0]?.warn).toBe(true)
    expect(w.message).toContain('free space on this disk could not be read')
  })

  it('a readable statfs under the threshold stays silent (control)', () => {
    const w = evaluateParkedUsage([entry(root(), 4 * MB)], {
      statfs: () => ({ bavail: 100 * MB, bsize: 1 }),
    })
    expect(w.warn).toBe(false)
    expect(w.message).toBeNull()
  })
})

describe('finding 8: over the threshold and unmeasured says both', () => {
  it('names the warning level that was passed and the unmeasured entries', () => {
    const w = evaluateParkedUsage([entry(root(), 8 * MB, { unmeasured: 2 })], {
      statfs: () => ({ bavail: 100 * MB, bsize: 1 }),
    })
    const msg = w.message as string
    expect(msg).toMatch(/over the [\d.]+ MB warning level/)
    expect(msg).toContain('2 entries could not be measured')
    expect(msg).toContain('at least')
  })
})

describe('finding 9: a symlinked storeDir groups with its target volume', () => {
  it('a link to a directory on another device is the same volume as the directory', () => {
    const shm = '/dev/shm'
    expect(fs.existsSync(shm)).toBe(true)
    const here = root()
    // The fixture must span two devices, or this tests nothing.
    expect(fs.lstatSync(shm).dev).not.toBe(fs.lstatSync(os.tmpdir()).dev)
    const link = path.join(here, 'link-to-shm')
    fs.symlinkSync(shm, link)
    const w = evaluateParkedUsage([entry(link, 1000), entry(shm, 2000)], {
      statfs: () => ({ bavail: 100e9, bsize: 1 }),
    })
    expect(w.perVolume).toHaveLength(1)
  })
})
