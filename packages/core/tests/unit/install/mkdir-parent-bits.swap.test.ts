/**
 * SMI-6531 / SMI-6676 (mutation hunt round 2): the descriptor guards of
 * `mkdirWithParentBits`, pinned by the property each one provides.
 *
 *  - an impostor directory swapped in before the open is never chmodded, and
 *    `fchmod` never runs on it (the identity check on the descriptor);
 *  - a swap right after the `fchmod` is caught by the final `lstat` and never
 *    comes back as an ok result;
 *  - a swap to a symlink or a regular file at the open fails the open with the
 *    errno the platform gives, which only the `O_DIRECTORY | O_NOFOLLOW` pair
 *    produces;
 *  - a directory owned by someone else is `not-ours`;
 *  - a platform missing either flag is never chmodded.
 *
 * Every refusal test has a control in this file proving the `fchmod` spy sees
 * a call when one happens, so "never called" cannot pass on a dead spy.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdirWithParentBits,
  setNoFollowConstantsForTests,
} from '../../../src/install/mkdir-parent-bits.js'

let prevUmask: number
let base: string

const bits = (p: string): number => fs.lstatSync(p).mode & 0o7777

function parentWith(mode: number): string {
  const parent = fs.mkdtempSync(path.join(base, 'parent-'))
  fs.chmodSync(parent, mode)
  return parent
}

/** Replace `dir` with an impostor directory of mode 0700, keeping the original aside. */
function swapInRealDirectory(dir: string): void {
  fs.renameSync(dir, `${dir}.away`)
  fs.mkdirSync(dir)
  fs.chmodSync(dir, 0o700)
}

beforeEach(() => {
  prevUmask = process.umask(0o022)
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mkdir-swap-')))
})

afterEach(() => {
  setNoFollowConstantsForTests(null)
  vi.restoreAllMocks()
  process.umask(prevUmask)
  fs.rmSync(base, { recursive: true, force: true })
})

describe('control: the fchmod spy sees the call when nothing is swapped', () => {
  it('a plain call runs fchmod once and reaches 0777', () => {
    const parent = parentWith(0o777)
    const child = path.join(parent, 'child')
    const fchmod = vi.spyOn(fs, 'fchmodSync')
    const r = mkdirWithParentBits(child, 0o777)
    expect(r.ok && r.bitsApplied).toEqual({ state: 'exact' })
    expect(fchmod).toHaveBeenCalledTimes(1)
    expect(bits(child)).toBe(0o777)
  })
})

describe('a real directory swapped in before the open is never chmodded', () => {
  it('is refused as changed, the impostor keeps its mode, and fchmod never ran', () => {
    const parent = parentWith(0o777)
    const child = path.join(parent, 'child')
    const fchmod = vi.spyOn(fs, 'fchmodSync')
    const r = mkdirWithParentBits(child, 0o777, { beforeOpen: () => swapInRealDirectory(child) })
    expect(r).toEqual({ ok: false, phase: 'changed', errno: null, created: true })
    expect(bits(child)).toBe(0o700)
    expect(fchmod).not.toHaveBeenCalled()
  })
})

describe('a swap right after the fchmod is caught by the final lstat', () => {
  /** Run the real fchmod, then swap `dir` in the same call, as a racing process would. */
  function swapAfterFchmod(dir: string, swap: (dir: string) => void): void {
    const real = fs.fchmodSync.bind(fs)
    vi.spyOn(fs, 'fchmodSync').mockImplementation((fd, mode) => {
      real(fd, mode)
      swap(dir)
    })
  }

  it('a real directory swapped in is changed, never an ok result for the impostor', () => {
    const parent = parentWith(0o777)
    const child = path.join(parent, 'child')
    swapAfterFchmod(child, swapInRealDirectory)
    const r = mkdirWithParentBits(child, 0o777)
    expect(fs.fchmodSync).toHaveBeenCalledTimes(1) // the swap really ran, after the chmod
    expect(r).toEqual({ ok: false, phase: 'changed', errno: null, created: true })
  })

  it('a symlink swapped in is changed', () => {
    const parent = parentWith(0o777)
    const child = path.join(parent, 'child')
    const elsewhere = fs.mkdtempSync(path.join(base, 'elsewhere-'))
    swapAfterFchmod(child, (dir) => {
      fs.renameSync(dir, `${dir}.away`)
      fs.symlinkSync(elsewhere, dir)
    })
    const r = mkdirWithParentBits(child, 0o777)
    expect(fs.fchmodSync).toHaveBeenCalledTimes(1)
    expect(r).toEqual({ ok: false, phase: 'changed', errno: null, created: true })
  })

  it('control: with no swap the same call is ok and carries the identity of the directory it made', () => {
    const parent = parentWith(0o777)
    const child = path.join(parent, 'child')
    swapAfterFchmod(child, () => undefined)
    const r = mkdirWithParentBits(child, 0o777)
    const st = fs.lstatSync(child, { bigint: true })
    expect(r.ok && r.identity).toMatchObject({ dev: st.dev, ino: st.ino })
  })
})

describe('a swap at the open fails the open, and only the flag pair gives the errno', () => {
  it('a symlink swapped in: changed with the platform’s errno, the decoy untouched', () => {
    const parent = parentWith(0o777)
    const child = path.join(parent, 'child')
    const decoy = fs.mkdtempSync(path.join(base, 'decoy-'))
    fs.chmodSync(decoy, 0o700)
    const fchmod = vi.spyOn(fs, 'fchmodSync')
    const r = mkdirWithParentBits(child, 0o777, {
      beforeOpen: () => {
        fs.renameSync(child, `${child}.away`)
        fs.symlinkSync(decoy, child)
      },
    })
    expect(r).toMatchObject({ ok: false, phase: 'changed', created: true })
    if (process.platform === 'linux') {
      // O_DIRECTORY | O_NOFOLLOW on a symlink: ENOTDIR. O_NOFOLLOW alone would say ELOOP,
      // and O_DIRECTORY alone would follow the link and give no errno at all.
      expect(!r.ok && r.errno).toBe('ENOTDIR')
    } else {
      expect(['ELOOP', 'ENOTDIR']).toContain(!r.ok && r.errno)
    }
    expect(bits(decoy)).toBe(0o700)
    expect(fchmod).not.toHaveBeenCalled()
  })

  it('a regular file swapped in: changed with ENOTDIR, which only O_DIRECTORY produces', () => {
    const parent = parentWith(0o777)
    const child = path.join(parent, 'child')
    const fchmod = vi.spyOn(fs, 'fchmodSync')
    const r = mkdirWithParentBits(child, 0o777, {
      beforeOpen: () => {
        fs.rmdirSync(child)
        fs.writeFileSync(child, 'x')
      },
    })
    expect(r).toEqual({ ok: false, phase: 'changed', errno: 'ENOTDIR', created: true })
    expect(fchmod).not.toHaveBeenCalled()
  })
})

describe('a directory owned by someone else is not ours', () => {
  function foreignOwnerOnFirstLstat(child: string): void {
    const real = fs.lstatSync
    const foreign = BigInt((process.getuid?.() ?? 0) + 1)
    let seen = 0
    vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
      const st = (real as (...a: unknown[]) => fs.BigIntStats)(p, o)
      if (String(p) !== child) return st
      seen += 1
      if (seen > 1) return st // only the first lstat after the mkdir is told a lie
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: foreign })
    }) as typeof fs.lstatSync)
  }

  it.skipIf(typeof process.getuid !== 'function')(
    'is refused as not-ours with no errno, created true, and nothing chmodded',
    () => {
      const parent = parentWith(0o777)
      const child = path.join(parent, 'child')
      const fchmod = vi.spyOn(fs, 'fchmodSync')
      foreignOwnerOnFirstLstat(child)
      const r = mkdirWithParentBits(child, 0o777)
      expect(r).toEqual({ ok: false, phase: 'not-ours', errno: null, created: true })
      expect(fchmod).not.toHaveBeenCalled()
    }
  )
})

describe('a platform missing either open flag is never chmodded', () => {
  const flags = fs.constants
  it.each([
    ['O_NOFOLLOW', { O_RDONLY: 0, O_DIRECTORY: flags.O_DIRECTORY }],
    ['O_DIRECTORY', { O_RDONLY: 0, O_NOFOLLOW: flags.O_NOFOLLOW }],
  ])('without only %s: no-nofollow-open, no fchmod, no chmod by path', (_missing, constants) => {
    const parent = parentWith(0o777)
    const child = path.join(parent, 'child')
    const byFd = vi.spyOn(fs, 'fchmodSync')
    const byPath = vi.spyOn(fs, 'chmodSync')
    setNoFollowConstantsForTests(constants)
    const r = mkdirWithParentBits(child, 0o777)
    expect(r.ok && r.bitsApplied).toEqual({
      state: 'not-applied',
      reason: 'no-nofollow-open',
      errno: null,
      actual: 0o755,
    })
    expect(byFd).not.toHaveBeenCalled()
    expect(byPath).not.toHaveBeenCalled()
  })
})
