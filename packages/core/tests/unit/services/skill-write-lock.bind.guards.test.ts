/**
 * SMI-6531 / SMI-6676 (mutation hunt round 2): two guards of the skills-root
 * binding that no other test constrains.
 *
 *  - a root that disappears after the bind makes `check()` refuse with
 *    `root-changed` (not `root-unsafe`, which is the bind-time code for a root
 *    that was never there), carrying the resolve error as its cause;
 *  - a staging directory whose `realpath` is spelled differently than the path
 *    it was made at is `staging-unsafe` ("resolves to"), so a staging area
 *    reached through a symlinked or bind-mounted component is never trusted.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  bindSkillsRoot,
  checkSkillsRootBinding,
  SkillWriteStop,
  STAGING_DIR_NAME,
  withSkillWriteLock,
} from '../../../src/services/skill-write-lock.js'

let base: string

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-write-lock-guards-')))
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(base, { recursive: true, force: true })
})

function thrownBy(f: () => void): unknown {
  try {
    f()
  } catch (err) {
    return err
  }
  return null
}

describe('the skills root removed after the bind', () => {
  it('check() refuses with root-changed, the resolve error as its cause', async () => {
    const root = path.join(base, 'skills')
    fs.mkdirSync(root)
    const binding = await bindSkillsRoot(root)
    fs.rmSync(root, { recursive: true })
    const err = thrownBy(() => checkSkillsRootBinding(binding))
    expect(err).toBeInstanceOf(SkillWriteStop)
    expect((err as SkillWriteStop).code).toBe('root-changed')
    expect((err as SkillWriteStop).detail).toContain('no longer resolves')
    expect(((err as SkillWriteStop).cause as NodeJS.ErrnoException).code).toBe('ENOENT')
  })

  it('withSkillWriteLock reports the same code and never runs fn', async () => {
    const root = path.join(base, 'skills')
    fs.mkdirSync(root)
    const binding = await bindSkillsRoot(root)
    fs.rmSync(root, { recursive: true })
    const fn = vi.fn(async () => 'ran')
    const r = await withSkillWriteLock(binding, 't', fn)
    expect(!r.ok && r.stop.code).toBe('root-changed')
    expect(fn).not.toHaveBeenCalled()
  })

  it('control: before the root is removed, check() does not throw', async () => {
    const root = path.join(base, 'skills')
    fs.mkdirSync(root)
    const binding = await bindSkillsRoot(root)
    expect(thrownBy(() => checkSkillsRootBinding(binding))).toBeNull()
  })
})

describe('a staging directory that resolves to another spelling', () => {
  function realpathSpellingStagingElsewhere(staging: string, spelled: string): () => number {
    const real = fs.promises.realpath
    let hits = 0
    vi.spyOn(fs.promises, 'realpath').mockImplementation(((p: fs.PathLike, o?: unknown) => {
      if (String(p) === staging) {
        hits += 1
        return Promise.resolve(spelled)
      }
      return (real as (...a: unknown[]) => Promise<string>)(p, o)
    }) as typeof fs.promises.realpath)
    return () => hits
  }

  it('is staging-unsafe, naming where it resolves to, and the bind does not succeed', async () => {
    const root = path.join(base, 'skills')
    fs.mkdirSync(root)
    const staging = path.join(fs.realpathSync(root), STAGING_DIR_NAME)
    const spelled = path.join(base, 'elsewhere', STAGING_DIR_NAME)
    const hits = realpathSpellingStagingElsewhere(staging, spelled)
    const err = await bindSkillsRoot(root).then(
      () => null,
      (e: unknown) => e
    )
    expect(hits()).toBe(1) // the mock really stood in for the staging realpath
    expect(err).toBeInstanceOf(SkillWriteStop)
    expect((err as SkillWriteStop).code).toBe('staging-unsafe')
    expect((err as SkillWriteStop).detail).toContain(`resolves to ${spelled}`)
  })

  it('control: with the real realpath the same bind succeeds', async () => {
    const root = path.join(base, 'skills')
    fs.mkdirSync(root)
    const binding = await bindSkillsRoot(root)
    expect(binding.stagingDir).toBe(path.join(fs.realpathSync(root), STAGING_DIR_NAME))
  })
})
