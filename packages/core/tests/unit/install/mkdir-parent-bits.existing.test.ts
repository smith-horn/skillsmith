/**
 * SMI-6531 (A1 step 2): an EXISTING directory is judged by the same permission
 * policy as a new one. Accepting it as it is would leave a hole: a directory
 * planted before the call, or one a call refused as `mode-unsafe` and left
 * behind, would be accepted by the next call. Narrower is still fine (it
 * succeeds with a warning); exposing the directory beyond what the parent
 * allows a class it lets through (wider bits, or non-sticky with a reaching
 * writer) is refused. Symlink and identity checks are unchanged.
 *
 * `park()` also carries the parked area's warnings (present only when non-empty).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdirWithParentBits,
  setNoFollowConstantsForTests,
} from '../../../src/install/mkdir-parent-bits.js'
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
  setNoFollowConstantsForTests(null)
  vi.restoreAllMocks()
  process.umask(prevUmask)
  fs.rmSync(base, { recursive: true, force: true })
})

describe('mkdirWithParentBits on an existing directory', () => {
  it('wider than the parent, for a class the parent lets through, is mode-unsafe, not created, and untouched', () => {
    const parent = parentWith(0o755)
    const dir = existing(parent, 'child', 0o777)
    const r = mkdirWithParentBits(dir, 0o755)
    expect(r).toMatchObject({
      ok: false,
      phase: 'mode-unsafe',
      created: false,
      wanted: 0o755,
      actual: 0o777,
    })
    expect(JSON.stringify(r)).not.toMatch(/chmod|remedy/i)
    expect(fs.statSync(dir).mode & 0o7777).toBe(0o777) // nothing is changed or removed
  })

  it('a group that reaches the parent only through its OTHER execute bit is judged: P 0701, A 0770 is mode-unsafe', () => {
    const parent = parentWith(0o701)
    const dir = existing(parent, 'child', 0o770)
    const r = mkdirWithParentBits(dir, 0o701)
    expect(r).toMatchObject({ ok: false, phase: 'mode-unsafe', wanted: 0o701, actual: 0o770 })
    expect(!r.ok && r.phase === 'mode-unsafe' && r.reasons.join(' ')).toContain('group read')
    // control: with nobody reaching (P 0700) the same directory is accepted
    expect(mkdirWithParentBits(dir, 0o700)).toMatchObject({ ok: true, warnings: [] })
  })

  it('an added setgid is a warning, not a refusal: P 0750, A 2750 succeeds and says setgid was added', () => {
    const parent = parentWith(0o750)
    const dir = existing(parent, 'child', 0o2750)
    expect(fs.statSync(dir).mode & 0o7777).toBe(0o2750) // control: the setgid is really there
    const r = mkdirWithParentBits(dir, 0o750)
    expect(r.ok && r.warnings).toEqual([
      `${dir} has mode 2750, not its parent's 0750; added: setgid ` +
        '(the directory already existed and was left as it is)',
    ])
  })

  it('the platform exemption is not reachable from the call arguments: a hooks.constants is ignored', () => {
    const parent = parentWith(0o755)
    const dir = existing(parent, 'child', 0o777)
    const hooks = { constants: { O_RDONLY: 0 } } as unknown as Parameters<
      typeof mkdirWithParentBits
    >[2]
    expect(mkdirWithParentBits(dir, 0o755, hooks)).toMatchObject({
      ok: false,
      phase: 'mode-unsafe',
    })
  })

  it('the constants seam refuses to run outside vitest', () => {
    const saved = process.env.VITEST
    delete process.env.VITEST
    try {
      expect(() => setNoFollowConstantsForTests({ O_RDONLY: 0 })).toThrow(/only under vitest/)
    } finally {
      process.env.VITEST = saved
    }
  })

  it('without a no-follow open an existing wider directory is not judged: ok, recorded, warned (control: mode-unsafe with it)', () => {
    const parent = parentWith(0o755)
    const dir = existing(parent, 'child', 0o777)
    expect(mkdirWithParentBits(dir, 0o755)).toMatchObject({ ok: false, phase: 'mode-unsafe' })
    setNoFollowConstantsForTests({ O_RDONLY: 0 })
    const r = mkdirWithParentBits(dir, 0o755)
    expect(r).toMatchObject({
      ok: true,
      created: false,
      bitsApplied: { state: 'not-applied', reason: 'no-nofollow-open', actual: 0o777 },
    })
    expect(r.ok && r.warnings).toEqual([
      `${dir} has mode 0777; its parent's 0755 could not be verified on this platform ` +
        "(this platform has no no-follow directory open, so the parent's bits were not applied)",
    ])
    const link = path.join(parent, 'link')
    fs.symlinkSync(dir, link)
    expect(mkdirWithParentBits(link, 0o755)).toMatchObject({
      ok: false,
      phase: 'not-directory',
    })
  })

  it('a tightened parent (0700) over an older 0755 directory is exact: nobody else can reach it', () => {
    const parent = parentWith(0o700)
    const dir = existing(parent, 'child', 0o755)
    const r = mkdirWithParentBits(dir, 0o700)
    expect(r).toMatchObject({ ok: true, created: false, warnings: [] })
  })

  it('non-sticky under a sticky parent, with a reaching writer, is mode-unsafe', () => {
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

  it('non-sticky under a sticky parent, with no reaching writer, succeeds with a warning', () => {
    const parent = parentWith(0o1777)
    const dir = existing(parent, 'child', 0o755)
    const r = mkdirWithParentBits(dir, 0o1777)
    expect(r.ok && r.warnings).toHaveLength(1)
    expect(r.ok && r.warnings[0]).toContain('missing: sticky, group write, other write')
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
    const parent = parentWith(0o755)
    const dir = path.join(parent, 'child')
    const real = fs.fchmodSync.bind(fs)
    const spy = vi.spyOn(fs, 'fchmodSync').mockImplementation((fd) => real(fd, 0o777))
    const first = mkdirWithParentBits(dir, 0o755)
    spy.mockRestore()
    expect(first).toMatchObject({ ok: false, phase: 'mode-unsafe', created: true, actual: 0o777 })
    expect(fs.existsSync(dir)).toBe(true) // it is left behind
    const second = mkdirWithParentBits(dir, 0o755)
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
  it('wider than the parent is refused as trash-mode-unsafe, not created, with both modes and the reasons, and no command', () => {
    const parent = parentWith(0o755)
    existing(parent, PARKED_DIR_NAME, 0o777)
    const r = ensureParkedRoot(parent)
    expect(r).toMatchObject({ ok: false, errno: null, detail: 'trash-mode-unsafe', created: false })
    expect(!r.ok && r.modeProblem).toMatchObject({ wanted: 0o755, actual: 0o777 })
    expect(!r.ok && r.modeProblem?.reasons.join(' ')).toContain('group write')
    const message = (!r.ok && r.modeProblem?.message) || ''
    expect(message).toContain('mode 0777')
    expect(message).toContain('its parent has 0755')
    expect(message).toContain('must not give other users more access than its parent does')
    expect(message).not.toMatch(/chmod/i)
    expect(JSON.stringify(r)).not.toMatch(/chmod|remedy/i)
  })

  it('a new area the filesystem made wider than the parent is refused the same way, reported created', () => {
    const parent = parentWith(0o755)
    const real = fs.fchmodSync.bind(fs)
    vi.spyOn(fs, 'fchmodSync').mockImplementation((fd) => real(fd, 0o777))
    const r = ensureParkedRoot(parent)
    expect(r).toMatchObject({ ok: false, errno: null, detail: 'trash-mode-unsafe', created: true })
    expect(!r.ok && r.modeProblem).toMatchObject({ wanted: 0o755, actual: 0o777 })
    expect(!r.ok && r.modeProblem?.message).toContain(path.join(parent, PARKED_DIR_NAME))
  })

  it('a tightened parent (0700) over an older 0755 area is accepted with no warning', () => {
    const parent = parentWith(0o700)
    existing(parent, PARKED_DIR_NAME, 0o755)
    expect(ensureParkedRoot(parent)).toMatchObject({ ok: true, created: false, warnings: [] })
  })

  it('non-sticky under a 1777 parent, with a reaching writer, is refused as trash-mode-unsafe', () => {
    const parent = parentWith(0o1777)
    existing(parent, PARKED_DIR_NAME, 0o777)
    expect(ensureParkedRoot(parent)).toMatchObject({ ok: false, detail: 'trash-mode-unsafe' })
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

  it('a wider existing area stops the park as park-failed, naming both modes and the reasons, and nothing is parked', () => {
    const f = simpleFixture('park-wide-')
    roots.push(f.root)
    fs.chmodSync(f.parent, 0o755)
    existing(f.parent, PARKED, 0o777)
    const r = park(f.parent, 'tree')
    expect(r).toMatchObject({
      status: 'stopped',
      reason: 'park-failed',
      detail: 'trash-mode-unsafe',
      modeProblem: { wanted: 0o755, actual: 0o777 },
    })
    expect(r.modeProblem?.reasons.join(' ')).toContain('group write')
    expect(r.modeProblem?.message).not.toMatch(/chmod/i)
    expect(fs.existsSync(f.origin)).toBe(true) // the tree did not move
  })
})
