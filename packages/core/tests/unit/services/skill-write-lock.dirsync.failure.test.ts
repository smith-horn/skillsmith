/**
 * SMI-6531 / SMI-6676 (mutation hunt round 2): what `syncDirectory` does when
 * the sync itself fails, and what that failure carries into
 * `bindSkillsRoot`'s stop.
 *
 *  - the directory handle is closed once even when `sync()` rejects;
 *  - an error with no `code` is reported with `String(err)` as its code, never
 *    an empty one;
 *  - a failed outcome carries the ORIGINAL error object, and the
 *    `staging-unsafe` stop `bindSkillsRoot` throws for it carries that same
 *    object as its `cause`.
 *
 * `fs/promises` is wrapped (as in `skill-write-lock.dirsync.test.ts`) so the
 * directory open can hand back a handle whose `sync()` fails.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type FakeHandle = { sync: () => Promise<void>; close: () => Promise<void> }
const inject = vi.hoisted(() => ({
  dir: null as string | null,
  handle: null as unknown,
  openError: null as unknown,
}))

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  const open = (async (...args: Parameters<typeof actual.open>) => {
    if (inject.dir !== null && String(args[0]) === inject.dir) {
      if (inject.openError !== null) throw inject.openError
      if (inject.handle !== null) return inject.handle
    }
    return actual.open(...args)
  }) as typeof actual.open
  return { ...actual, open, default: { ...actual, open } }
})

import { syncDirectory } from '../../../src/install/dir-sync.js'
import { bindSkillsRoot, SkillWriteStop } from '../../../src/services/skill-write-lock.js'

let base: string

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-write-lock-dsfail-')))
  inject.dir = base
  inject.handle = null
  inject.openError = null
})
afterEach(() => {
  inject.dir = null
  inject.handle = null
  inject.openError = null
  fs.rmSync(base, { recursive: true, force: true })
})

function handleWhoseSync(
  sync: () => Promise<void>
): FakeHandle & { close: ReturnType<typeof vi.fn> } {
  return { sync, close: vi.fn(async () => undefined) }
}

describe('the directory handle is always closed', () => {
  it('control: a sync that succeeds closes the handle once and reports synced', async () => {
    const handle = handleWhoseSync(async () => undefined)
    inject.handle = handle
    expect(await syncDirectory(base)).toEqual({ outcome: 'synced' })
    expect(handle.close).toHaveBeenCalledTimes(1)
  })

  it('a sync that rejects still closes the handle once, and the failure is reported', async () => {
    const boom = Object.assign(new Error('EIO: injected'), { code: 'EIO' })
    const handle = handleWhoseSync(async () => {
      throw boom
    })
    inject.handle = handle
    const r = await syncDirectory(base)
    expect(handle.close).toHaveBeenCalledTimes(1)
    expect(r).toEqual({ outcome: 'failed', code: 'EIO', error: boom })
  })
})

describe('an error with no code', () => {
  it('is reported with String(err) as its code, not an empty one', async () => {
    const boom = new Error('no errno here')
    inject.handle = handleWhoseSync(async () => {
      throw boom
    })
    const r = await syncDirectory(base)
    expect(r).toEqual({ outcome: 'failed', code: String(boom), error: boom })
    expect(r.outcome === 'failed' && r.code).not.toBe('')
  })
})

describe('a failed outcome carries the original error', () => {
  it('syncDirectory returns the very object the open threw', async () => {
    const boom = Object.assign(new Error('EIO: injected'), { code: 'EIO' })
    inject.openError = boom
    const r = await syncDirectory(base)
    expect(r.outcome === 'failed' && r.error).toBe(boom)
  })

  it('bindSkillsRoot’s staging-unsafe stop carries it as the cause', async () => {
    const root = path.join(base, 'r')
    fs.mkdirSync(root)
    const boom = Object.assign(new Error('EIO: injected'), { code: 'EIO' })
    inject.dir = fs.realpathSync(root)
    inject.openError = boom
    const err = await bindSkillsRoot(root).then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(SkillWriteStop)
    expect((err as SkillWriteStop).code).toBe('staging-unsafe')
    expect((err as SkillWriteStop).cause).toBe(boom)
  })
})
