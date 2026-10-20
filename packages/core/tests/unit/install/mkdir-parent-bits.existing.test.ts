/**
 * SMI-6531 (A1 step 2): an EXISTING directory is judged by the same permission
 * policy as a new one. Accepting it as it is would leave a hole: a directory
 * planted before the call, or one a call refused as `mode-unsafe` and left
 * behind, would be accepted by the next call. Narrower is still fine (it
 * succeeds with a warning); wider than the parent, or non-sticky under a sticky
 * parent, is refused. Symlink and identity checks are unchanged.
 *
 * `park()` also carries the parked area's warnings (present only when non-empty).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirWithParentBits } from '../../../src/install/mkdir-parent-bits.js'
import { ensureParkedRoot, PARKED_DIR_NAME } from '../../../src/install/park-tree.destination.js'
import { PARKED, cleanup, park, simpleFixture } from './park-tree.helpers.js'

let prevUmask: number
let base: string

function parentWith(mode: number): string {
  const parent = fs.mkdtempSync(path.join(base, 'parent-'))
  fs.chmodSync(parent, mode)
  return parent
}

/** A directory that already exists with exactly `mode`. */
function existing(parent: string, name: string, mode: number): string {
  const dir = path.join(parent, name)
  fs.mkdirSync(dir)
  fs.chmodSync(dir, mode)
  return dir
}

beforeEach(() => {
  prevUmask = process.umask(0o022)
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mkdir-existing-')))
})

afterEach(() => {
  vi.restoreAllMocks()
  process.umask(prevUmask)
  fs.rmSync(base, { recursive: true, force: true })
})

describe('mkdirWithParentBits on an existing directory', () => {
  it('wider than the parent is mode-unsafe, not created, and untouched', () => {
    const parent = parentWith(0o700)
    const dir = existing(parent, 'child', 0o777)
    const r = mkdirWithParentBits(dir, 0o700)
    expect(r).toMatchObject({
      ok: false,
      phase: 'mode-unsafe',
      created: false,
      wanted: 0o700,
      actual: 0o777,
    })
    expect(fs.statSync(dir).mode & 0o7777).toBe(0o777) // nothing is changed or removed
  })

  it('non-sticky under a sticky parent is mode-unsafe', () => {
    const parent = parentWith(0o1777)
    const dir = existing(parent, 'child', 0o777)
    const r = mkdirWithParentBits(dir, 0o1777)
    expect(r).toMatchObject({
      ok: false,
      phase: 'mode-unsafe',
      created: false,
      wanted: 0o1777,
      actual: 0o777,
    })
  })

  it('narrower than the parent succeeds, not created, with a warning naming the missing bits', () => {
    const parent = parentWith(0o777)
    const dir = existing(parent, 'child', 0o750)
    const r = mkdirWithParentBits(dir, 0o777)
    expect(r.ok && r.created).toBe(false)
    expect(r.ok && r.bitsApplied).toEqual({
      state: 'not-applied',
      reason: 'existing-directory',
      errno: null,
      actual: 0o750,
    })
    expect(r.ok && r.warnings).toEqual([
      `${dir} has mode 0750, not its parent's 0777; missing: group write, other read, ` +
        'other write, other execute (the directory already existed and was left as it is)',
    ])
  })

  it('a directory left behind by a mode-unsafe refusal is refused both times', () => {
    const parent = parentWith(0o700)
    const dir = path.join(parent, 'child')
    const real = fs.fchmodSync.bind(fs)
    const spy = vi.spyOn(fs, 'fchmodSync').mockImplementation((fd) => real(fd, 0o777))
    const first = mkdirWithParentBits(dir, 0o700)
    spy.mockRestore()
    expect(first).toMatchObject({ ok: false, phase: 'mode-unsafe', created: true, actual: 0o777 })
    expect(fs.existsSync(dir)).toBe(true) // it is left behind
    const second = mkdirWithParentBits(dir, 0o700)
    expect(second).toMatchObject({ ok: false, phase: 'mode-unsafe', created: false, actual: 0o777 })
  })

  it('control: an existing directory with exactly the parent’s bits has no warnings', () => {
    const parent = parentWith(0o755)
    const dir = existing(parent, 'child', 0o755)
    const r = mkdirWithParentBits(dir, 0o755)
    expect(r.ok && r.warnings).toEqual([])
  })
})

describe('ensureParkedRoot on an existing parked area', () => {
  it('wider than the parent is refused as trash-unusable, not created', () => {
    const parent = parentWith(0o700)
    existing(parent, PARKED_DIR_NAME, 0o777)
    expect(ensureParkedRoot(parent)).toEqual({
      ok: false,
      errno: null,
      detail: 'trash-unusable',
      created: false,
    })
  })

  it('non-sticky under a 1777 parent is refused as trash-unusable', () => {
    const parent = parentWith(0o1777)
    existing(parent, PARKED_DIR_NAME, 0o777)
    expect(ensureParkedRoot(parent)).toMatchObject({ ok: false, detail: 'trash-unusable' })
  })

  it('narrower succeeds with a warning', () => {
    const parent = parentWith(0o777)
    const area = existing(parent, PARKED_DIR_NAME, 0o755)
    const r = ensureParkedRoot(parent)
    expect(r.ok && r.created).toBe(false)
    expect(r.ok && r.warnings).toEqual([
      `${area} has mode 0755, not its parent's 0777; missing: group write, other write ` +
        '(the directory already existed and was left as it is)',
    ])
  })
})

describe('park() carries the parked area’s warnings', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const r of roots.splice(0)) cleanup(r)
  })

  it('a narrower existing area: the parked result has warnings; a refused one has none', () => {
    const f = simpleFixture('park-warn-')
    roots.push(f.root)
    fs.chmodSync(f.parent, 0o777)
    const area = existing(f.parent, PARKED, 0o755)
    const r = park(f.parent, 'tree')
    expect(r.status).toBe('parked')
    expect(r.warnings).toEqual([
      `${area} has mode 0755, not its parent's 0777; missing: group write, other write ` +
        '(the directory already existed and was left as it is)',
    ])
  })

  it('control: an exact area gives a result with no warnings key at all', () => {
    const f = simpleFixture('park-nowarn-')
    roots.push(f.root)
    const r = park(f.parent, 'tree')
    expect(r.status).toBe('parked')
    expect('warnings' in r).toBe(false)
  })

  it('a wider existing area stops the park as park-failed, and nothing is parked', () => {
    const f = simpleFixture('park-wide-')
    roots.push(f.root)
    fs.chmodSync(f.parent, 0o700)
    existing(f.parent, PARKED, 0o777)
    const r = park(f.parent, 'tree')
    expect(r).toMatchObject({ status: 'stopped', reason: 'park-failed', detail: 'trash-unusable' })
    expect(fs.existsSync(f.origin)).toBe(true) // the tree did not move
  })
})
