/**
 * SMI-6531 (A1 step 6c-ii-a): the two read-only listers and the legacy
 * leftover scan. Rows: T-X14's listing half (with and without a sidecar), no
 * symlink is followed at any level, `.prune-*` entries go to `inspectLeftover`,
 * temps are listed as unfinished, and nothing the listers, the classifier, the
 * size walk or the warning do writes anything (the dynamic read-only pin).
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listBackupStore } from '../../../src/install/prune.list.backups.js'
import { listParkedArea } from '../../../src/install/prune.list.parked.js'
import { classifyCopy } from '../../../src/install/prune.classify.js'
import { evaluateParkedUsage } from '../../../src/install/parked-usage.js'
import { listRemovingLeftovers } from '../../../src/install/remove-if-same.js'
import type { ListedCopy } from '../../../src/install/prune.list.types.js'
import { makeParent, parkCopy, removeFixture } from './prune.walk.helpers.js'
import type { PruneFixture } from './prune.walk.helpers.js'
import { makeBackup, tmpRoot } from './prune.list.helpers.js'

const fixtures: PruneFixture[] = []
const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const f of fixtures.splice(0)) removeFixture(f)
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})
const parent = (): PruneFixture => {
  const f = makeParent('prune-lst-')
  fixtures.push(f)
  return f
}
const root = (): string => {
  const r = tmpRoot('prune-lst-')
  roots.push(r)
  return r
}
const hex16 = (): string => crypto.randomBytes(8).toString('hex')

describe('listParkedArea', () => {
  it('an area that is not there is absent, not an error', () => {
    const f = parent()
    expect(listParkedArea(f.parent)).toMatchObject({ absent: true, refused: null, copies: [] })
  })

  it('T-X14: a copy with its sidecar and a copy without are both listed; an orphan sidecar is named', () => {
    const f = parent()
    const a = parkCopy(f.parent, 'with')
    const b = parkCopy(f.parent, 'without')
    fs.unlinkSync(b.sidecarPath)
    fs.writeFileSync(path.join(a.opDir, 'ghost-1234abcd.json'), '{}')
    const l = listParkedArea(f.parent)
    expect(l.copies.map((c) => c.copyPath).sort()).toEqual([a.copyPath, b.copyPath].sort())
    expect(l.orphanSidecars).toEqual([path.join(a.opDir, 'ghost-1234abcd.json')])
    const c = l.copies.find((x) => x.copyPath === b.copyPath) as ListedCopy
    expect(c).toMatchObject({
      opId: path.basename(b.opDir),
      parentDir: b.opDir,
      opDir: b.opDir,
      stagingRoot: l.areaDir,
      sidecarPath: `${b.copyPath}.json`,
    })
  })

  it('an op entry that is a symlink is an anomaly and is never followed', () => {
    const f = parent()
    const outside = path.join(f.root, 'outside')
    fs.mkdirSync(path.join(outside, 'victim-1234abcd'), { recursive: true })
    fs.mkdirSync(path.join(f.parent, '.skillsmith-parked'), { mode: 0o700 })
    fs.symlinkSync(outside, path.join(f.parent, '.skillsmith-parked', 'op-link'))
    const l = listParkedArea(f.parent)
    expect(l.copies).toEqual([])
    expect(l.anomalies).toEqual([
      { path: path.join(f.parent, '.skillsmith-parked', 'op-link'), detail: expect.any(String) },
    ])
  })

  it('an area that is a symlink is refused whole', () => {
    const f = parent()
    const real = path.join(f.root, 'real-area')
    fs.mkdirSync(path.join(real, 'op-1', 'x-1234abcd'), { recursive: true })
    fs.symlinkSync(real, path.join(f.parent, '.skillsmith-parked'))
    const l = listParkedArea(f.parent)
    expect(l.refused).toBe('set-aside area is not a real directory')
    expect(l.copies).toEqual([])
  })

  it('a .prune-* entry goes to inspectLeftover, and is never a copy', () => {
    const f = parent()
    parkCopy(f.parent, 'tree')
    const S = path.join(f.parent, '.skillsmith-parked', `.prune-${hex16()}`)
    fs.mkdirSync(S, { mode: 0o700 })
    const l = listParkedArea(f.parent)
    expect(l.copies).toHaveLength(1)
    expect(l.leftovers).toHaveLength(1)
    expect(l.leftovers[0]).toMatchObject({ S, state: 'empty' })
  })
})

describe('listBackupStore', () => {
  it('a store that is not there is absent', () => {
    expect(listBackupStore(path.join(root(), 'backups', 'update'))).toMatchObject({
      absent: true,
      areas: [],
    })
  })

  it('lists each <client>/<rootKey>/<dirName> area with its path facts', () => {
    const state = root()
    const a = makeBackup({ state, skillsDir: '/skills/a', dirName: 'foo', opId: 'op-1' })
    makeBackup({ state, skillsDir: '/skills/a', dirName: 'foo', opId: 'op-2', kind: 'undone' })
    makeBackup({ state, skillsDir: '/skills/b', client: 'cursor', dirName: 'bar', opId: 'op-3' })
    const l = listBackupStore(a.updateDir)
    expect(l.areas.map((x) => `${x.client}/${x.dirName}`).sort()).toEqual([
      'claude-code/foo',
      'cursor/bar',
    ])
    const foo = l.areas.find((x) => x.dirName === 'foo')
    expect(foo?.copies.map((c) => c.name).sort()).toEqual(['op-1', 'op-2.undone'])
    expect(foo?.copies[0]).toMatchObject({
      opId: 'op-1',
      parentDir: foo?.areaPath,
      stagingRoot: foo?.areaPath,
      opDir: foo?.areaPath,
      area: { client: 'claude-code', rootKey: foo?.rootKey, dirName: 'foo' },
    })
  })

  it('a symlink at the client, rootKey or dirName level is an anomaly and is never followed', () => {
    const state = root()
    const b = makeBackup({ state, skillsDir: '/skills/a' })
    const outside = path.join(state, 'outside')
    fs.mkdirSync(path.join(outside, 'k', 'foo', 'op-9'), { recursive: true })
    fs.symlinkSync(outside, path.join(b.updateDir, 'linked-client'))
    fs.symlinkSync(path.join(outside, 'k'), path.join(path.dirname(b.areaPath), '..', 'linked-key'))
    fs.symlinkSync(
      path.join(outside, 'k', 'foo'),
      path.join(path.dirname(b.areaPath), 'linked-dir')
    )
    const l = listBackupStore(b.updateDir)
    expect(l.areas).toHaveLength(1)
    expect(l.anomalies.map((a) => path.basename(a.path)).sort()).toEqual([
      'linked-client',
      'linked-dir',
      'linked-key',
    ])
  })

  it('a store that is a symlink is refused whole', () => {
    const state = root()
    const b = makeBackup({ state, skillsDir: '/skills/a' })
    const moved = path.join(state, 'update-real')
    fs.renameSync(b.updateDir, moved)
    fs.symlinkSync(moved, b.updateDir)
    expect(listBackupStore(b.updateDir)).toMatchObject({
      refused: 'backup store is not a real directory',
      areas: [],
    })
  })

  it('temps are unfinished, .prune-* is a leftover, a hidden entry is an anomaly, none is a copy', () => {
    const state = root()
    const b = makeBackup({ state, skillsDir: '/skills/a', opId: 'op-1' })
    const S = path.join(b.areaPath, `.prune-${hex16()}`)
    fs.mkdirSync(S, { mode: 0o700 })
    fs.mkdirSync(path.join(b.areaPath, '.tmp-op-2.undone'))
    fs.writeFileSync(path.join(b.areaPath, 'op-3.json.tmp'), '{')
    fs.writeFileSync(path.join(b.areaPath, 'op-4.json'), '{}')
    fs.writeFileSync(path.join(b.areaPath, '.hidden'), 'x')
    const area = listBackupStore(b.updateDir).areas[0]
    expect(area?.copies.map((c) => c.name)).toEqual(['op-1'])
    expect(area?.temps).toEqual([
      { path: path.join(b.areaPath, '.tmp-op-2.undone'), kind: 'copy-temp', base: 'op-2.undone' },
      { path: path.join(b.areaPath, 'op-3.json.tmp'), kind: 'sidecar-temp', base: 'op-3' },
    ])
    expect(area?.leftovers).toHaveLength(1)
    expect(area?.leftovers[0]).toMatchObject({ S, state: 'empty' })
    expect(area?.orphanSidecars).toEqual([path.join(b.areaPath, 'op-4.json')])
    expect(area?.anomalies.map((a) => path.basename(a.path))).toEqual(['.hidden'])
  })

  it('a tree with no sidecar is still listed (the classifier calls it held)', () => {
    const state = root()
    const b = makeBackup({ state, skillsDir: '/skills/a', noSidecar: true })
    const copies = listBackupStore(b.updateDir).areas.flatMap((a) => a.copies)
    expect(copies.map((c) => c.copyPath)).toEqual([b.copyPath])
  })
})

describe('listRemovingLeftovers', () => {
  it('lists every legacy removal leftover in a directory, whatever target it was for, and nothing else', async () => {
    const dir = root()
    const names = [
      `.foo.skillsmith-removing-${'a'.repeat(32)}`,
      `.bar-baz.skillsmith-removing-${'0'.repeat(32)}`,
    ]
    for (const n of names) fs.mkdirSync(path.join(dir, n))
    for (const n of [
      'foo',
      `.foo.skillsmith-removing-${'a'.repeat(31)}`,
      `.foo.skillsmith-removing-${'g'.repeat(32)}`,
      `foo.skillsmith-removing-${'a'.repeat(32)}`,
      `.foo.skillsmith-removing-${'a'.repeat(32)}.json`,
    ]) {
      fs.writeFileSync(path.join(dir, n), 'x')
    }
    const r = await listRemovingLeftovers(dir)
    expect(r.parked).toEqual(names.map((n) => path.join(dir, n)).sort())
    expect(r.unreadable).toBeUndefined()
  })

  it('a directory that cannot be listed is reported, not an empty list', async () => {
    const r = await listRemovingLeftovers(path.join(root(), 'nope'))
    expect(r.parked).toEqual([])
    expect(r.unreadable).toContain('ENOENT')
  })
})

/** Every fs member that changes the tree. */
const WRITERS = [
  'unlinkSync',
  'rmdirSync',
  'rmSync',
  'renameSync',
  'mkdirSync',
  'writeFileSync',
  'appendFileSync',
  'copyFileSync',
  'linkSync',
  'symlinkSync',
  'truncateSync',
  'chmodSync',
  'chownSync',
  'utimesSync',
  'mkdtempSync',
  'cpSync',
  'writeSync',
  'ftruncateSync',
] as const

/** Every file and directory under `dir`, with the bytes of each file. */
function snapshot(dir: string): string[] {
  const out: string[] = []
  const walk = (p: string): void => {
    const st = fs.lstatSync(p)
    if (st.isDirectory()) {
      out.push(`d ${p} ${st.mode}`)
      for (const n of fs.readdirSync(p).sort()) walk(path.join(p, n))
    } else if (st.isSymbolicLink()) out.push(`l ${p} ${fs.readlinkSync(p)}`)
    else out.push(`f ${p} ${st.mode} ${st.mtimeMs} ${fs.readFileSync(p).toString('base64')}`)
  }
  walk(dir)
  return out
}

describe('read-only: nothing listed, classified, measured or evaluated writes', () => {
  function run(f: PruneFixture, state: string): void {
    const parked = listParkedArea(f.parent)
    const store = listBackupStore(path.join(state, 'backups', 'update'))
    const copies = [
      ...parked.copies.map((c) => [c, 'parked'] as const),
      ...store.areas.flatMap((a) => a.copies.map((c) => [c, 'backup'] as const)),
    ]
    const entries = copies.map(([c, s]) => {
      const k = classifyCopy(c, s)
      return {
        path: c.copyPath,
        storeDir: c.parentDir,
        units: k.measured.units,
        unmeasured: k.measured.unmeasured,
        originPath: null,
        opId: c.opId,
      }
    })
    evaluateParkedUsage(entries, { statfs: () => ({ bavail: 1, bsize: 1 }) })
  }

  function fixture(): { f: PruneFixture; state: string } {
    const f = parent()
    const state = root()
    parkCopy(f.parent, 'one')
    fs.unlinkSync(parkCopy(f.parent, 'two').sidecarPath)
    makeBackup({ state, skillsDir: '/skills/a' })
    const b = makeBackup({ state, skillsDir: '/skills/a', opId: 'op-2', kind: 'undone' })
    fs.mkdirSync(path.join(b.areaPath, `.prune-${hex16()}`), { mode: 0o700 })
    fs.writeFileSync(path.join(b.areaPath, 'op-9.json.tmp'), '{')
    return { f, state }
  }

  it('no write-family fs call is made, and every file is byte-identical afterwards', () => {
    const { f, state } = fixture()
    const calls: string[] = []
    for (const w of WRITERS) {
      vi.spyOn(fs as unknown as Record<string, () => unknown>, w).mockImplementation(() => {
        calls.push(w)
        throw new Error(`${w} must not be called`)
      })
    }
    const realOpen = fs.openSync.bind(fs)
    vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, flags?: fs.OpenMode) => {
      const writes =
        typeof flags === 'string'
          ? flags !== 'r'
          : typeof flags === 'number' &&
            (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0
      if (writes) {
        calls.push('openSync(write)')
        throw new Error('openSync with a write flag')
      }
      return realOpen(p, flags ?? 'r')
    }) as typeof fs.openSync)
    const before = [snapshot(f.root), snapshot(state)]
    run(f, state)
    expect(calls).toEqual([])
    expect([snapshot(f.root), snapshot(state)]).toEqual(before)
  })

  it('control: a write made from inside product code is seen, so a silent pass is not the spy being blind', () => {
    const { f, state } = fixture()
    const calls: string[] = []
    const planted = path.join(state, 'planted')
    vi.spyOn(fs, 'mkdirSync').mockImplementation((() => {
      calls.push('mkdirSync')
      return undefined
    }) as typeof fs.mkdirSync)
    // The test body never writes. A directory read the PRODUCT code makes (listing, classifying,
    // measuring) is wrapped to write through the same `fs` object: the write is seen only if
    // the product's `fs` is the object the spies sit on.
    const realReaddir = fs.readdirSync.bind(fs) as (...a: unknown[]) => unknown
    let productReads = 0
    vi.spyOn(fs, 'readdirSync').mockImplementation(((...a: unknown[]) => {
      productReads += 1
      fs.mkdirSync(planted)
      return realReaddir(...a)
    }) as unknown as typeof fs.readdirSync)
    run(f, state)
    expect(productReads).toBeGreaterThan(0)
    expect(calls.length).toBe(productReads)
    expect(new Set(calls)).toEqual(new Set(['mkdirSync']))
    expect(fs.existsSync(planted)).toBe(false)
  })
})
