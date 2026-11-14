/**
 * SMI-6531 (A1 step 6c-ii-a): the ONE mount verdict the classifier and the
 * walker's re-check share (`mountVerdictAt`). A symlink copy root is never a
 * mount point and needs no realpath; any other root that cannot be resolved is
 * mounted (`realpath-failed`), never offered; and the two callers agree.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyCopy, mountAt } from '../../../src/install/prune.classify.js'
import { mountVerdictAt } from '../../../src/install/park-tree.mounts.js'
import { listParkedArea } from '../../../src/install/prune.list.parked.js'
import { mountFinding } from '../../../src/install/prune.walk.shared.js'
import type { ListedCopy } from '../../../src/install/prune.list.types.js'
import { injectMountinfo, mountinfoLine } from './prune.list.helpers.js'
import {
  jobFor,
  makeParent,
  parkCopy,
  removeFixture,
  runWalker,
  statusOf,
} from './prune.walk.helpers.js'
import type { ParkedCopy, PruneFixture } from './prune.walk.helpers.js'

const fixtures: PruneFixture[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const f of fixtures.splice(0)) removeFixture(f)
})

/** A parked copy whose root is replaced by a symlink to `target`; its sidecar is kept or removed. */
function linkCopy(target: string, keepSidecar: boolean): { c: ParkedCopy; copy: ListedCopy } {
  const f = makeParent('prune-mnt-')
  fixtures.push(f)
  const c = parkCopy(f.parent, 'tree')
  fs.rmSync(c.copyPath, { recursive: true })
  fs.symlinkSync(target, c.copyPath)
  if (!keepSidecar) fs.unlinkSync(c.sidecarPath)
  const l = listParkedArea(f.parent)
  expect(l.copies).toHaveLength(1)
  return { c, copy: l.copies[0] as ListedCopy }
}

const realpathFailsFor = (p: string): void => {
  const real = fs.realpathSync.bind(fs) as (...a: unknown[]) => unknown
  vi.spyOn(fs, 'realpathSync').mockImplementation(((x: unknown, ...rest: unknown[]) => {
    if (x === p) throw Object.assign(new Error('EIO'), { code: 'EIO' })
    return real(x, ...rest)
  }) as typeof fs.realpathSync)
}

describe('a symlink copy root is never a mount point', () => {
  it('a dangling symlink is not mounted: it gets the class the rest of the classifier gives it', () => {
    const { copy } = linkCopy('/nonexistent-prune-target-6cii', false)
    expect(classifyCopy(copy, 'parked')).toMatchObject({ klass: 'held', reason: 'sidecar-absent' })
  })

  it('a symlink to / is not mounted, though / is a mount point', () => {
    const { copy } = linkCopy('/', false)
    injectMountinfo(mountinfoLine('/'))
    expect(classifyCopy(copy, 'parked')).toMatchObject({ klass: 'held', reason: 'sidecar-absent' })
  })
})

describe('a non-symlink copy root that cannot be resolved is mounted', () => {
  it('realpath-failed is mounted, never offered, and the detail names realpath', () => {
    const f = makeParent('prune-mnt-')
    fixtures.push(f)
    const c = parkCopy(f.parent, 'tree')
    const l = listParkedArea(f.parent)
    realpathFailsFor(c.copyPath)
    const k = classifyCopy(l.copies[0] as ListedCopy, 'parked')
    expect(k).toMatchObject({ klass: 'mounted', reason: 'realpath-failed' })
    expect(k.detail).toContain('realpath')
    expect(k.detail).not.toContain('mountinfo')
  })

  it('the walker re-check still stops on it, naming realpath', () => {
    const f = makeParent('prune-mnt-')
    fixtures.push(f)
    const c = parkCopy(f.parent, 'tree')
    const run = runWalker(jobFor(c), {
      hooks: [
        {
          when: 'before',
          fn: 'realpathSync',
          a0Re: `${c.copyPath}$`,
          action: { kind: 'throw', code: 'EIO' },
        },
      ],
    })
    expect(statusOf(run)).toBe('kept/class-worsened')
    expect(String(run.item?.detail)).toContain('realpath failed (EIO)')
  })
})

describe('the walker re-check does not stop a symlink copy root', () => {
  it('a dangling symlink copy is not stopped by the mount check', () => {
    const { c } = linkCopy('/nonexistent-prune-target-6cii', true)
    const run = runWalker(jobFor(c))
    expect(statusOf(run)).not.toBe('kept/class-worsened')
    expect(statusOf(run)).not.toBe('held/mount-in-staging')
    expect(String(run.item?.detail ?? '')).not.toContain('realpath failed')
  })
})

describe('the classifier and the walker re-check agree on the same roots', () => {
  const cases: { name: string; make: () => string; mountinfo?: string | { throws: string } }[] = [
    {
      name: 'a plain directory',
      make: () => linkDir(),
    },
    {
      name: 'a directory with a mount point under it',
      make: () => linkDir(),
      mountinfo: 'UNDER',
    },
    { name: 'a dangling symlink', make: () => danglingLink() },
    { name: 'a symlink to /', make: () => danglingLink('/'), mountinfo: mountinfoLine('/') },
    { name: 'an unreadable mount table', make: () => linkDir(), mountinfo: { throws: 'EACCES' } },
  ]

  function linkDir(): string {
    const f = makeParent('prune-mnt-')
    fixtures.push(f)
    return parkCopy(f.parent, 'tree').copyPath
  }
  function danglingLink(target = '/nonexistent-prune-target-6cii'): string {
    const f = makeParent('prune-mnt-')
    fixtures.push(f)
    const p = path.join(f.parent, 'lnk')
    fs.symlinkSync(target, p)
    return p
  }

  for (const k of cases) {
    it(`${k.name}: mounted for the classifier iff mountFinding is non-null`, () => {
      const copyPath = k.make()
      if (k.mountinfo === 'UNDER') {
        injectMountinfo(mountinfoLine(path.join(fs.realpathSync(copyPath), 'sub')))
      } else if (k.mountinfo !== undefined) {
        injectMountinfo(k.mountinfo)
      }
      const input = {
        copyPath,
        name: path.basename(copyPath),
        opId: 'op',
        parentDir: path.dirname(copyPath),
        sidecarPath: `${copyPath}.json`,
        stagingRoot: path.dirname(copyPath),
        opDir: path.dirname(copyPath),
      }
      const mountedByClassifier = classifyCopy(input, 'parked').klass === 'mounted'
      expect(mountedByClassifier).toBe(mountFinding(copyPath) !== null)
      expect(mountedByClassifier).toBe(k.mountinfo === 'UNDER' || typeof k.mountinfo === 'object')
    })
  }
})

describe('F9: a path that became a symlink after the caller looked is a refusal', () => {
  it('the verdict names the symlink; mountAt (which needs a directory) refuses it; the walker check does not', () => {
    const f = makeParent('prune-f9-')
    fixtures.push(f)
    const target = path.join(f.parent, 'target')
    fs.mkdirSync(target)
    const link = path.join(f.parent, 'link')
    fs.symlinkSync(target, link)
    expect(mountVerdictAt(link)).toEqual({ mounted: false, symlink: true })
    expect(mountAt(link)).toBe(true)
    // The walker unlinks a link without following it, so its own check still lets a link through.
    expect(mountFinding(link)).toBeNull()
    // Control: a real directory is neither.
    expect(mountVerdictAt(target)).toEqual({ mounted: false })
    expect(mountAt(target)).toBe(false)
  })

  it('a set-aside area swapped for a symlink between the lister lstat and the mount check is refused whole', () => {
    const real = makeParent('prune-f9-real-')
    const f = makeParent('prune-f9-root-')
    fixtures.push(real, f)
    parkCopy(real.parent, 'tree')
    const areaDir = path.join(f.parent, '.skillsmith-parked')
    fs.symlinkSync(path.join(real.parent, '.skillsmith-parked'), areaDir)
    // The caller's lstat sees the directory it will be swapped for; every later look sees the link.
    const lstat = fs.lstatSync.bind(fs) as (...a: unknown[]) => unknown
    let first = true
    vi.spyOn(fs, 'lstatSync').mockImplementation(((p: unknown, ...rest: unknown[]) => {
      if (p === areaDir && first) {
        first = false
        return fs.statSync(areaDir, { bigint: true })
      }
      return lstat(p, ...rest)
    }) as typeof fs.lstatSync)
    const l = listParkedArea(f.parent)
    expect(first).toBe(false)
    expect(l.refused).not.toBeNull()
    expect(l.copies).toEqual([])
  })
})
