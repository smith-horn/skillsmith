/**
 * SMI-6531 (A1 step 2, C13): the sync of R after `bindSkillsRoot` creates ST.
 * `unsupported` (a filesystem that cannot fsync a directory) is accepted and
 * recorded; any other failure stops the write, because the new entry may not
 * survive a crash. The directory open is failed by wrapping `fs/promises`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const inject = vi.hoisted(() => ({ dir: null as string | null, code: 'EIO', hits: 0 }))

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  const open = (async (...args: Parameters<typeof actual.open>) => {
    if (inject.dir !== null && String(args[0]) === inject.dir) {
      inject.hits += 1
      throw Object.assign(new Error(`${inject.code}: injected`), { code: inject.code })
    }
    return actual.open(...args)
  }) as typeof actual.open
  return { ...actual, open, default: { ...actual, open } }
})

import { syncDirectory } from '../../../src/install/dir-sync.js'
import { bindSkillsRoot, SkillWriteStop } from '../../../src/services/skill-write-lock.js'

let base: string

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-write-lock-dirsync-')))
  inject.dir = null
  inject.hits = 0
})
afterEach(() => {
  inject.dir = null
  fs.rmSync(base, { recursive: true, force: true })
})

describe('syncDirectory reports instead of deciding', () => {
  it('control: a real directory is synced', async () => {
    expect(await syncDirectory(base)).toEqual({ outcome: 'synced' })
  })

  it.each(['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR', 'ENOSYS'])('%s is unsupported', async (code) => {
    inject.dir = base
    inject.code = code
    expect(await syncDirectory(base)).toEqual({ outcome: 'unsupported', code })
  })

  it('any other code is failed, with the error', async () => {
    inject.dir = base
    inject.code = 'EIO'
    const r = await syncDirectory(base)
    expect(r).toMatchObject({ outcome: 'failed', code: 'EIO' })
  })
})

describe('bindSkillsRoot and the sync after creating ST', () => {
  it('unsupported is accepted and recorded', async () => {
    const root = path.join(base, 'r')
    fs.mkdirSync(root)
    inject.dir = fs.realpathSync(root)
    inject.code = 'EINVAL'
    const b = await bindSkillsRoot(root)
    expect(inject.hits).toBe(1)
    expect(b.stagingCreated).toBe(true)
    expect(b.rootSync).toEqual({ outcome: 'unsupported', code: 'EINVAL' })
  })

  it('a failed sync stops the write as staging-unsafe', async () => {
    const root = path.join(base, 'r')
    fs.mkdirSync(root)
    inject.dir = fs.realpathSync(root)
    inject.code = 'EIO'
    const err = await bindSkillsRoot(root).then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(SkillWriteStop)
    expect((err as SkillWriteStop).code).toBe('staging-unsafe')
    expect((err as SkillWriteStop).detail).toContain('EIO')
  })

  it('no sync is attempted when ST already existed', async () => {
    const root = path.join(base, 'r')
    fs.mkdirSync(path.join(root, '.skillsmith-staging'), { recursive: true })
    inject.dir = fs.realpathSync(root)
    const b = await bindSkillsRoot(root)
    expect(inject.hits).toBe(0)
    expect(b.rootSync).toBeNull()
  })
})
