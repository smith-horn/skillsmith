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
import { mkdirWithParentBits, PARENT_BITS_MASK } from '../../../src/install/mkdir-parent-bits.js'
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
    const parent = parentWith(0o1777)
    const child = path.join(parent, 'child')
    fs.mkdirSync(child)
    fs.chmodSync(child, 0o750)
    const r = mkdirWithParentBits(child, 0o1777)
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
    const parent = parentWith(0o1777)
    const child = path.join(parent, 'child')
    fs.mkdirSync(child)
    const r = mkdirWithParentBits(child, 0o1777)
    expect(r.ok && r.bitsApplied).toEqual({
      state: 'not-applied',
      reason: 'existing-directory',
      errno: null,
    })
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

  it('a filesystem that refuses chmod (EPERM, ENOTSUP, EROFS) is recorded and the call still succeeds', () => {
    for (const code of ['EPERM', 'ENOTSUP', 'EROFS']) {
      const parent = parentWith(0o1777)
      const spy = vi.spyOn(fs, 'fchmodSync').mockImplementation(() => {
        throw Object.assign(new Error(`${code}: injected`), { code })
      })
      const r = mkdirWithParentBits(path.join(parent, 'child'), 0o1777)
      spy.mockRestore()
      expect(r.ok).toBe(true)
      expect(r.ok && r.created).toBe(true)
      expect(r.ok && r.bitsApplied).toEqual({
        state: 'not-applied',
        reason: 'chmod-refused',
        errno: code,
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

  it('bits other than the wanted ones after fchmod are reported as a mismatch with the actual bits', () => {
    const parent = parentWith(0o1777)
    const real = fs.fchmodSync.bind(fs)
    vi.spyOn(fs, 'fchmodSync').mockImplementation((fd, _mode) => real(fd, 0o750))
    const r = mkdirWithParentBits(path.join(parent, 'child'), 0o1777)
    expect(r.ok).toBe(true)
    expect(r.ok && r.bitsApplied).toEqual({ state: 'mismatch', wanted: 0o1777, actual: 0o750 })
  })

  it('a platform without O_NOFOLLOW/O_DIRECTORY never chmods at all and says so', () => {
    const parent = parentWith(0o1777)
    const child = path.join(parent, 'child')
    const byPath = vi.spyOn(fs, 'chmodSync')
    const byFd = vi.spyOn(fs, 'fchmodSync')
    const r = mkdirWithParentBits(child, 0o1777, { constants: { O_RDONLY: 0 } })
    expect(byPath).not.toHaveBeenCalled()
    expect(byFd).not.toHaveBeenCalled()
    expect(r.ok && r.bitsApplied).toEqual({
      state: 'not-applied',
      reason: 'no-nofollow-open',
      errno: null,
    })
    expect(bits(child)).not.toBe(0o1777) // the umask-filtered bits stay
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

  it('an existing parked area is left with its own bits and reported not created', () => {
    const parent = parentWith(0o1777)
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
