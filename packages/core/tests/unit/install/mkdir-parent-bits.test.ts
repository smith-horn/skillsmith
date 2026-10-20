/**
 * SMI-6531 (A1 step 2, C5) and SMI-7149: a new directory carries its parent's
 * permission bits, sticky and setgid included, whatever the process umask.
 *
 * Every test runs under umask 022, which is what makes a plain
 * `mkdir(p, { mode })` lose the group/other write bits and the sticky bit. The
 * first test pins that precondition, so a result that merely happens to match
 * the parent's bits (a umask of 0, say) cannot pass for the property.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdirWithParentBits,
  PARENT_BITS_MASK,
  setNoFollowConstantsForTests,
} from '../../../src/install/mkdir-parent-bits.js'
import { ensureParkedRoot, PARKED_DIR_NAME } from '../../../src/install/park-tree.destination.js'

let prevUmask: number
let base: string

const bits = (p: string): number => fs.statSync(p).mode & 0o7777

/** A fresh parent directory with exactly `mode` (chmod is not subject to the umask). */
function parentWith(mode: number): string {
  const parent = fs.mkdtempSync(path.join(base, 'parent-'))
  fs.chmodSync(parent, mode)
  expect(bits(parent)).toBe(mode)
  return parent
}

beforeEach(() => {
  prevUmask = process.umask(0o022)
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mkdir-bits-')))
})

afterEach(() => {
  setNoFollowConstantsForTests(null)
  vi.restoreAllMocks()
  process.umask(prevUmask)
  fs.rmSync(base, { recursive: true, force: true })
})

describe('precondition: the umask is live', () => {
  it.each([
    ['0777', 0o777],
    ['1777', 0o1777],
  ])('a plain mkdir asking for %s does not get those bits under umask 022', (_label, mode) => {
    const p = path.join(base, 'plain')
    fs.mkdirSync(p, { mode })
    expect(bits(p)).not.toBe(mode)
  })
})

describe('mkdirWithParentBits', () => {
  it.each([
    ['0777', 0o777],
    ['1777', 0o1777],
    ['0755', 0o755],
    ['0700', 0o700],
    ['0770', 0o770],
  ])('a new directory under a %s parent gets exactly that mode', (_label, mode) => {
    const parent = parentWith(mode)
    const r = mkdirWithParentBits(path.join(parent, 'child'), mode)
    expect(r.ok).toBe(true)
    expect(r.ok && r.created).toBe(true)
    expect(bits(path.join(parent, 'child'))).toBe(mode)
  })

  it('applies the mask: setuid is dropped, setgid and sticky are kept', () => {
    expect(PARENT_BITS_MASK).toBe(0o3777)
    const parent = parentWith(0o755)
    const r = mkdirWithParentBits(path.join(parent, 'c'), 0o7777 | 0o40000)
    expect(r.ok).toBe(true)
    // setgid may be cleared by the OS for a group the caller is not in, but setuid never survives.
    expect(bits(path.join(parent, 'c')) & 0o4000).toBe(0)
    expect(bits(path.join(parent, 'c')) & 0o1000).toBe(0o1000)
    expect(bits(path.join(parent, 'c')) & 0o777).toBe(0o777)
  })

  it('returns the identity of the directory it made', () => {
    const parent = parentWith(0o1777)
    const child = path.join(parent, 'child')
    const r = mkdirWithParentBits(child, 0o1777)
    const st = fs.lstatSync(child, { bigint: true })
    expect(r.ok && r.identity.ino).toBe(st.ino)
    expect(r.ok && r.identity.dev).toBe(st.dev)
  })

  it('an existing directory is accepted, reported not created, and keeps its own bits', () => {
    const parent = parentWith(0o755) // was 1777: a sticky parent now refuses a non-sticky child
    const child = path.join(parent, 'child')
    fs.mkdirSync(child)
    fs.chmodSync(child, 0o750)
    const r = mkdirWithParentBits(child, 0o755)
    expect(r.ok).toBe(true)
    expect(r.ok && r.created).toBe(false)
    expect(bits(child)).toBe(0o750)
  })

  it('refuses a symlink where the directory should be, and does not chmod through it', () => {
    const parent = parentWith(0o1777)
    const elsewhere = fs.mkdtempSync(path.join(base, 'elsewhere-'))
    fs.chmodSync(elsewhere, 0o700)
    const link = path.join(parent, 'child')
    fs.symlinkSync(elsewhere, link)
    const r = mkdirWithParentBits(link, 0o1777)
    expect(r).toMatchObject({ ok: false, phase: 'not-directory', created: false })
    expect(bits(elsewhere)).toBe(0o700)
  })

  it('reports the bits as exact when nothing interferes (control for the swap tests)', () => {
    const parent = parentWith(0o1777)
    const r = mkdirWithParentBits(path.join(parent, 'child'), 0o1777)
    expect(r.ok && r.bitsApplied).toEqual({ state: 'exact' })
  })

  it('an existing directory records that no bits were applied', () => {
    const parent = parentWith(0o755) // was 1777: the 0755 child made below would be non-sticky
    const child = path.join(parent, 'child')
    fs.mkdirSync(child)
    const r = mkdirWithParentBits(child, 0o755)
    expect(r.ok && r.bitsApplied).toEqual({
      state: 'not-applied',
      reason: 'existing-directory',
      errno: null,
      actual: 0o755,
    })
    expect(r.ok && r.warnings).toEqual([])
  })

  it('refuses a regular file in the way', () => {
    const parent = parentWith(0o755)
    const file = path.join(parent, 'child')
    fs.writeFileSync(file, 'x')
    expect(mkdirWithParentBits(file, 0o755)).toMatchObject({ ok: false, phase: 'not-directory' })
  })

  it('reports a mkdir that fails, with the errno and created false', () => {
    const r = mkdirWithParentBits(path.join(base, 'missing', 'child'), 0o755)
    expect(r).toMatchObject({ ok: false, phase: 'mkdir', errno: 'ENOENT', created: false })
  })
})

describe('the bits are applied through a no-follow descriptor, never by path', () => {
  it('a symlink swapped in between the check and the open: the victim keeps its mode, the swap is reported', () => {
    const parent = parentWith(0o1777)
    const victim = fs.mkdtempSync(path.join(base, 'victim-'))
    fs.chmodSync(victim, 0o700)
    const child = path.join(parent, 'child')
    const chmodByPath = vi.spyOn(fs, 'chmodSync')
    const r = mkdirWithParentBits(child, 0o1777, {
      beforeOpen: () => {
        fs.rmdirSync(child)
        fs.symlinkSync(victim, child)
      },
    })
    expect(bits(victim)).toBe(0o700)
    expect(r).toMatchObject({ ok: false, phase: 'changed', created: true })
    expect(chmodByPath).not.toHaveBeenCalled()
  })

  it('a filesystem that refuses chmod (EPERM, ENOTSUP, EROFS) is recorded and the call still succeeds when the directory is only narrower', () => {
    for (const code of ['EPERM', 'ENOTSUP', 'EROFS']) {
      // 0777 under umask 022 is made 0755: narrower than the parent, nothing wider.
      const parent = parentWith(0o777)
      const spy = vi.spyOn(fs, 'fchmodSync').mockImplementation(() => {
        throw Object.assign(new Error(`${code}: injected`), { code })
      })
      const r = mkdirWithParentBits(path.join(parent, 'child'), 0o777)
      spy.mockRestore()
      expect(r.ok).toBe(true)
      expect(r.ok && r.created).toBe(true)
      expect(r.ok && r.bitsApplied).toEqual({
        state: 'not-applied',
        reason: 'chmod-refused',
        errno: code,
        actual: 0o755,
      })
    }
  })

  it('any other fchmod failure is still a failure, with its errno', () => {
    const parent = parentWith(0o755)
    vi.spyOn(fs, 'fchmodSync').mockImplementation(() => {
      throw Object.assign(new Error('EIO: injected'), { code: 'EIO' })
    })
    const r = mkdirWithParentBits(path.join(parent, 'child'), 0o755)
    expect(r).toMatchObject({ ok: false, phase: 'chmod', errno: 'EIO', created: true })
  })

  it('a platform without O_NOFOLLOW/O_DIRECTORY never chmods at all and says so', () => {
    const parent = parentWith(0o777)
    const child = path.join(parent, 'child')
    const byPath = vi.spyOn(fs, 'chmodSync')
    const byFd = vi.spyOn(fs, 'fchmodSync')
    setNoFollowConstantsForTests({ O_RDONLY: 0 })
    const r = mkdirWithParentBits(child, 0o777)
    expect(byPath).not.toHaveBeenCalled()
    expect(byFd).not.toHaveBeenCalled()
    expect(r.ok && r.bitsApplied).toEqual({
      state: 'not-applied',
      reason: 'no-nofollow-open',
      errno: null,
      actual: 0o755,
    })
    expect(bits(child)).not.toBe(0o777) // the umask-filtered bits stay
  })
})

/** Run the real `fchmod`, but with `mode` instead of the requested one (what a filesystem or kernel may do). */
function fchmodLeaving(mode: number | ((wanted: number) => number)): void {
  const real = fs.fchmodSync.bind(fs)
  vi.spyOn(fs, 'fchmodSync').mockImplementation((fd, wanted) =>
    real(fd, typeof mode === 'function' ? mode(Number(wanted)) : mode)
  )
}

const refused = (code: string): Error => Object.assign(new Error(`${code}: injected`), { code })

describe('the permission policy: wider or sticky-less fails closed, narrower succeeds with a warning', () => {
  it('a filesystem that leaves wider bits (0777 under a 0755 parent) is mode-unsafe, with both modes and the reasons, and no command', () => {
    const parent = parentWith(0o755)
    const child = path.join(parent, 'child')
    fchmodLeaving(0o777)
    const r = mkdirWithParentBits(child, 0o755)
    expect(r).toMatchObject({
      ok: false,
      phase: 'mode-unsafe',
      errno: null,
      created: true,
      wanted: 0o755,
      actual: 0o777,
    })
    expect(!r.ok && r.phase === 'mode-unsafe' && r.reasons.join(' ')).toContain('group write')
    expect(JSON.stringify(r)).not.toMatch(/chmod|remedy/i)
  })

  it('a lost sticky bit under a 1777 parent is mode-unsafe, though no bit is wider', () => {
    const parent = parentWith(0o1777)
    fchmodLeaving(0o777)
    const r = mkdirWithParentBits(path.join(parent, 'child'), 0o1777)
    expect(r).toMatchObject({ ok: false, phase: 'mode-unsafe', wanted: 0o1777, actual: 0o777 })
  })

  it('chmod refused, leaving wider bits, is mode-unsafe (the mode is read before the descriptor is closed)', () => {
    const parent = parentWith(0o755)
    const real = fs.fchmodSync.bind(fs)
    vi.spyOn(fs, 'fchmodSync').mockImplementation((fd) => {
      real(fd, 0o777) // the bits change, and the call still reports a refusal
      throw refused('EPERM')
    })
    const r = mkdirWithParentBits(path.join(parent, 'child'), 0o755)
    expect(r).toMatchObject({ ok: false, phase: 'mode-unsafe', wanted: 0o755, actual: 0o777 })
  })

  it('chmod refused, with the sticky bit lost, is mode-unsafe', () => {
    const parent = parentWith(0o1777)
    const real = fs.fchmodSync.bind(fs)
    vi.spyOn(fs, 'fchmodSync').mockImplementation((fd) => {
      real(fd, 0o777)
      throw refused('EPERM')
    })
    const r = mkdirWithParentBits(path.join(parent, 'child'), 0o1777)
    expect(r).toMatchObject({ ok: false, phase: 'mode-unsafe', wanted: 0o1777, actual: 0o777 })
  })

  it('a platform with no no-follow open never refuses on mode: wider bits seen by the final lstat are recorded and warned', () => {
    const parent = parentWith(0o755)
    const child = path.join(parent, 'child')
    const real = fs.lstatSync
    let calls = 0
    vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
      const st = (real as (...a: unknown[]) => fs.BigIntStats)(p, o)
      calls += 1
      if (calls < 2 || String(p) !== child) return st // the second lstat is the final one
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
        mode: (st.mode & ~0o7777n) | 0o777n,
      })
    }) as typeof fs.lstatSync)
    setNoFollowConstantsForTests({ O_RDONLY: 0 })
    const r = mkdirWithParentBits(child, 0o755)
    expect(r.ok && r.bitsApplied).toEqual({
      state: 'not-applied',
      reason: 'no-nofollow-open',
      errno: null,
      actual: 0o777,
    })
    expect(r.ok && r.warnings).toEqual([
      `${child} has mode 0777; its parent's 0755 could not be verified on this platform ` +
        "(this platform has no no-follow directory open, so the parent's bits were not applied)",
    ])
  })

  it('setgid dropped under a 2777 parent succeeds, as a mismatch, with a warning naming setgid', () => {
    const parent = parentWith(0o2777)
    const child = path.join(parent, 'child')
    fchmodLeaving((wanted) => wanted & ~0o2000) // the kernel clears setgid for a group we are not in
    const r = mkdirWithParentBits(child, 0o2777)
    expect(r.ok && r.bitsApplied).toEqual({ state: 'mismatch', wanted: 0o2777, actual: 0o777 })
    expect(r.ok && r.warnings).toEqual([
      `${child} has mode 0777, not its parent's 2777; missing: setgid ` +
        '(chmod ran, but the filesystem or kernel left these bits unset)',
    ])
  })

  it('chmod refused with the umask narrower than the parent succeeds, with a warning naming group and other write', () => {
    const parent = parentWith(0o777)
    const child = path.join(parent, 'child')
    vi.spyOn(fs, 'fchmodSync').mockImplementation(() => {
      throw refused('EPERM')
    })
    const r = mkdirWithParentBits(child, 0o777)
    expect(r.ok && r.bitsApplied).toEqual({
      state: 'not-applied',
      reason: 'chmod-refused',
      errno: 'EPERM',
      actual: 0o755,
    })
    expect(r.ok && r.warnings).toEqual([
      `${child} has mode 0755, not its parent's 0777; missing: group write, other write ` +
        '(the filesystem refused chmod: EPERM)',
    ])
  })

  it('a platform without a no-follow open, with the umask narrower than the parent, says the bits could not be verified', () => {
    const parent = parentWith(0o777)
    const child = path.join(parent, 'child')
    setNoFollowConstantsForTests({ O_RDONLY: 0 })
    const r = mkdirWithParentBits(child, 0o777)
    expect(r.ok && r.warnings).toEqual([
      `${child} has mode 0755; its parent's 0777 could not be verified on this platform ` +
        "(this platform has no no-follow directory open, so the parent's bits were not applied)",
    ])
  })

  it('control: the exact case has no warnings', () => {
    const parent = parentWith(0o1777)
    const r = mkdirWithParentBits(path.join(parent, 'child'), 0o1777)
    expect(r.ok && r.warnings).toEqual([])
  })

  it('control: chmod refused where the made mode already equals the parent’s warns of nothing', () => {
    const parent = parentWith(0o755)
    vi.spyOn(fs, 'fchmodSync').mockImplementation(() => {
      throw refused('EPERM')
    })
    const r = mkdirWithParentBits(path.join(parent, 'child'), 0o755)
    expect(r.ok && r.bitsApplied).toMatchObject({ state: 'not-applied', actual: 0o755 })
    expect(r.ok && r.warnings).toEqual([])
  })
})

describe('a parent whose owner lacks read (0333)', () => {
  // As a non-root user (run this file with `docker exec -u node`) the first test fails
  // without the owner bits: the O_DIRECTORY open of a 0333 directory is EACCES. Root
  // reads anything, so there the second test is what pins the property.
  it('is made openable by this process: the directory ends with exactly the parent’s bits', () => {
    const parent = parentWith(0o333)
    const child = path.join(parent, 'child')
    try {
      const r = mkdirWithParentBits(child, 0o40333)
      expect(r).toMatchObject({ ok: true, created: true })
      expect(r.ok && r.bitsApplied).toEqual({ state: 'exact' })
      expect(bits(child)).toBe(0o333)
    } finally {
      fs.chmodSync(child, 0o755) // so the cleanup can read it
      fs.chmodSync(parent, 0o755)
    }
  })

  it('is created with owner read, write and execute added to the requested bits, the property that makes it openable', () => {
    const parent = parentWith(0o333)
    const child = path.join(parent, 'child')
    const mkdir = vi.spyOn(fs, 'mkdirSync')
    try {
      mkdirWithParentBits(child, 0o40333)
      const requested = (mkdir.mock.calls[0]?.[1] as { mode: number }).mode
      expect(requested & 0o700).toBe(0o700) // a non-root owner could not open a 0333 directory
      expect(requested & 0o077).toBe(0o033) // and nothing else is added
    } finally {
      fs.chmodSync(child, 0o755)
      fs.chmodSync(parent, 0o755)
    }
  })
})

describe('a failing fstat or close does not escape a result-typed function', () => {
  it('the identity fstat throwing EIO is a fstat failure, not a throw', () => {
    const parent = parentWith(0o755)
    vi.spyOn(fs, 'fstatSync').mockImplementation(() => {
      throw refused('EIO')
    })
    const r = mkdirWithParentBits(path.join(parent, 'child'), 0o755)
    expect(r).toMatchObject({ ok: false, phase: 'fstat', errno: 'EIO', created: true })
  })

  it('the fstat after fchmod throwing EIO is a fstat failure, not a throw', () => {
    const parent = parentWith(0o755)
    const real = fs.fstatSync
    let calls = 0
    vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number, o?: unknown) => {
      calls += 1
      if (calls >= 2) throw refused('EIO')
      return (real as (...a: unknown[]) => unknown)(fd, o)
    }) as typeof fs.fstatSync)
    const r = mkdirWithParentBits(path.join(parent, 'child'), 0o755)
    expect(calls).toBe(2) // the failure really came from the second fstat
    expect(r).toMatchObject({ ok: false, phase: 'fstat', errno: 'EIO', created: true })
  })

  it('a close that throws does not replace the ready result', () => {
    const parent = parentWith(0o755)
    const real = fs.closeSync.bind(fs)
    const close = vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
      real(fd) // really closed; only the report fails
      throw refused('EIO')
    })
    const r = mkdirWithParentBits(path.join(parent, 'child'), 0o755)
    expect(close).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ ok: true, created: true, bitsApplied: { state: 'exact' } })
  })

  it('a close that throws does not replace a refusal made inside the descriptor block either', () => {
    const parent = parentWith(0o755)
    const real = fs.closeSync.bind(fs)
    const close = vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
      real(fd)
      throw refused('EIO')
    })
    vi.spyOn(fs, 'fstatSync').mockImplementation(() => {
      throw refused('ENOMEM')
    })
    const r = mkdirWithParentBits(path.join(parent, 'child'), 0o755)
    expect(close).toHaveBeenCalledTimes(1) // the refusal really went through the close
    expect(r).toMatchObject({ ok: false, phase: 'fstat', errno: 'ENOMEM' })
  })
})

describe('ensureParkedRoot carries the parent bits (SMI-7149)', () => {
  it.each([
    ['0777', 0o777],
    ['1777', 0o1777],
    ['0755', 0o755],
  ])('a %s parent gives the parked area exactly that mode', (_label, mode) => {
    const parent = parentWith(mode)
    const r = ensureParkedRoot(parent)
    expect(r.ok && r.created).toBe(true)
    expect(bits(path.join(parent, PARKED_DIR_NAME))).toBe(mode)
  })

  it('an exact area carries no warnings', () => {
    const r = ensureParkedRoot(parentWith(0o1777))
    expect(r.ok && r.warnings).toEqual([])
  })

  it('surfaces why the area is narrower than the parent (setgid dropped under a 2777 parent)', () => {
    const parent = parentWith(0o2777)
    fchmodLeaving((wanted) => wanted & ~0o2000)
    const r = ensureParkedRoot(parent)
    expect(r.ok && r.bitsApplied).toEqual({ state: 'mismatch', wanted: 0o2777, actual: 0o777 })
    expect(r.ok && r.warnings).toEqual([
      `${path.join(parent, PARKED_DIR_NAME)} has mode 0777, not its parent's 2777; missing: setgid ` +
        '(chmod ran, but the filesystem or kernel left these bits unset)',
    ])
  })

  it('reports a failing fstat with its errno', () => {
    const parent = parentWith(0o755)
    vi.spyOn(fs, 'fstatSync').mockImplementation(() => {
      throw refused('EIO')
    })
    expect(ensureParkedRoot(parent)).toEqual({
      ok: false,
      errno: 'EIO',
      detail: null,
      created: true,
    })
  })

  it('an existing parked area is left with its own bits and reported not created', () => {
    const parent = parentWith(0o777) // was 1777: a sticky parent now refuses a non-sticky area
    const area = path.join(parent, PARKED_DIR_NAME)
    fs.mkdirSync(area)
    fs.chmodSync(area, 0o700)
    const r = ensureParkedRoot(parent)
    expect(r.ok && r.created).toBe(false)
    expect(bits(area)).toBe(0o700)
  })

  it('a symlinked parked area is still refused as trash-unusable, with created false', () => {
    const parent = parentWith(0o755)
    const elsewhere = fs.mkdtempSync(path.join(base, 'elsewhere-'))
    fs.symlinkSync(elsewhere, path.join(parent, PARKED_DIR_NAME))
    expect(ensureParkedRoot(parent)).toMatchObject({
      ok: false,
      detail: 'trash-unusable',
      created: false,
    })
  })
})
