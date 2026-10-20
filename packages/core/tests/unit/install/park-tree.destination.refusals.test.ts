/**
 * SMI-6531 / SMI-6676 (mutation hunt round 2): how `ensureParkedRoot` reports
 * each way `mkdirWithParentBits` can stop, and the same-device check.
 *
 * The errno phases (`chmod`, `open`, ...) come back with their errno, no
 * `detail`, and `created` true when this call's mkdir made the area. The
 * verdict phases (`changed`, `not-ours`) have no errno and come back as
 * `trash-unusable`, with `created` true as well. A parked area on another
 * device than its parent is `trash-other-mount`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureParkedRoot, PARKED_DIR_NAME } from '../../../src/install/park-tree.destination.js'

let prevUmask: number
let base: string

function parentWith(mode: number): string {
  const parent = fs.mkdtempSync(path.join(base, 'parent-'))
  fs.chmodSync(parent, mode)
  return parent
}

const injected = (code: string): Error => Object.assign(new Error(`${code}: injected`), { code })

beforeEach(() => {
  prevUmask = process.umask(0o022)
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'park-dest-')))
})

afterEach(() => {
  vi.restoreAllMocks()
  process.umask(prevUmask)
  fs.rmSync(base, { recursive: true, force: true })
})

describe('control: an untouched parent gives an ok area on the parent’s device', () => {
  it('is ok, created, and reports the parent’s own device', () => {
    const parent = parentWith(0o755)
    const r = ensureParkedRoot(parent)
    expect(r.ok && r.created).toBe(true)
    expect(r.ok && r.parentDev).toBe(BigInt(fs.statSync(parent).dev))
  })
})

describe('an errno phase comes back with its errno, no detail, and created true', () => {
  it('a fchmod failing with EIO (not a refusal errno) is { errno: EIO, detail: null }', () => {
    const parent = parentWith(0o755)
    vi.spyOn(fs, 'fchmodSync').mockImplementation(() => {
      throw injected('EIO')
    })
    expect(ensureParkedRoot(parent)).toEqual({
      ok: false,
      errno: 'EIO',
      detail: null,
      created: true,
    })
  })

  it('an open of the new area failing with EACCES is { errno: EACCES, detail: null }', () => {
    const parent = parentWith(0o755)
    const area = path.join(parent, PARKED_DIR_NAME)
    const real = fs.openSync
    vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p) === area) throw injected('EACCES')
      return (real as (...a: unknown[]) => number)(p, ...rest)
    }) as typeof fs.openSync)
    expect(ensureParkedRoot(parent)).toEqual({
      ok: false,
      errno: 'EACCES',
      detail: null,
      created: true,
    })
  })
})

describe('a verdict phase after this call’s own mkdir is trash-unusable with created true', () => {
  it('an area replaced between the check and the open (changed)', () => {
    const parent = parentWith(0o755)
    const area = path.join(parent, PARKED_DIR_NAME)
    const real = fs.openSync
    vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p) === area) {
        fs.renameSync(area, `${area}.away`)
        fs.mkdirSync(area)
      }
      return (real as (...a: unknown[]) => number)(p, ...rest)
    }) as typeof fs.openSync)
    expect(ensureParkedRoot(parent)).toEqual({
      ok: false,
      errno: null,
      detail: 'trash-unusable',
      created: true,
    })
  })

  it.skipIf(typeof process.getuid !== 'function')(
    'an area owned by someone else (not-ours)',
    () => {
      const parent = parentWith(0o755)
      const area = path.join(parent, PARKED_DIR_NAME)
      const real = fs.lstatSync
      const foreign = BigInt((process.getuid?.() ?? 0) + 1)
      vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
        const st = (real as (...a: unknown[]) => fs.BigIntStats)(p, o)
        if (String(p) !== area) return st
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: foreign })
      }) as typeof fs.lstatSync)
      expect(ensureParkedRoot(parent)).toEqual({
        ok: false,
        errno: null,
        detail: 'trash-unusable',
        created: true,
      })
    }
  )
})

describe('an area on another device than its parent is trash-other-mount', () => {
  it('is refused, with created true, when the area’s device differs from the parent’s', () => {
    const parent = parentWith(0o755)
    const real = fs.statSync
    vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
      const st = (real as (...a: unknown[]) => fs.Stats)(p, o)
      if (String(p) !== parent) return st
      // The parent reports a device the area (made inside it, so on the real one) is not on.
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { dev: st.dev + 1 })
    }) as typeof fs.statSync)
    expect(ensureParkedRoot(parent)).toEqual({
      ok: false,
      errno: null,
      detail: 'trash-other-mount',
      created: true,
    })
  })
})
