/**
 * SMI-6531 (A1 step 2): `bindSkillsRoot` and the single-uid half of T-K2.
 *
 * Phase 1 of lock 1, outside any lock: resolve and bind R, create or verify and
 * bind `.skillsmith-staging/` with R's permission bits. The real `.gitignore` hint
 * runs (in a non-git temp dir it answers null); `skill-write-lock.hint.test.ts`
 * owns its timing.
 *
 * T-K2 (single-uid half): ST made under a `0777` and a `1777` root carries
 * exactly the root's bits under umask 022. The two-uid half (another user
 * staging in it) needs a second uid in a container and is filed separately.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setLockTrackerEnabledForTests } from '../../../src/config/lock-tracker.js'
import {
  bindSkillsRoot,
  SKILL_WRITE_LOCK_BASENAME,
  skillsRootLockPaths,
  SkillWriteStop,
  STAGING_DIR_NAME,
  withSkillWriteLock,
} from '../../../src/services/skill-write-lock.js'

let base: string
let prevUmask: number
const bits = (p: string): number => fs.statSync(p).mode & 0o7777

function makeRoot(name: string, mode = 0o755): string {
  const root = path.join(base, name)
  fs.mkdirSync(root)
  fs.chmodSync(root, mode)
  return root
}

async function stopOf(p: Promise<unknown>): Promise<SkillWriteStop> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(SkillWriteStop)
    return err as SkillWriteStop
  }
  throw new Error('expected a SkillWriteStop, but the call resolved')
}

beforeEach(() => {
  setLockTrackerEnabledForTests(true)
  prevUmask = process.umask(0o022)
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-write-lock-bind-')))
})

afterEach(() => {
  vi.restoreAllMocks()
  process.umask(prevUmask)
  fs.rmSync(base, { recursive: true, force: true })
})

describe('bindSkillsRoot: the root', () => {
  it('a missing root is root-unsafe and nothing is created', async () => {
    const missing = path.join(base, 'nope')
    const stop = await stopOf(bindSkillsRoot(missing))
    expect(stop.code).toBe('root-unsafe')
    expect(fs.readdirSync(base)).toEqual([])
  })

  it('a root that is a regular file is root-unsafe', async () => {
    const file = path.join(base, 'file')
    fs.writeFileSync(file, 'x')
    expect((await stopOf(bindSkillsRoot(file))).code).toBe('root-unsafe')
    expect(fs.readdirSync(base)).toEqual(['file'])
  })

  it('binds R as the native realpath, with the identity of that directory', async () => {
    const real = makeRoot('real')
    const link = path.join(base, 'link')
    fs.symlinkSync(real, link)
    const b = await bindSkillsRoot(link)
    expect(b.skillsDir).toBe(link)
    expect(b.root).toBe(fs.realpathSync.native(real))
    const st = fs.lstatSync(real, { bigint: true })
    expect(b.rootIdentity).toMatchObject({ ok: true, dev: st.dev, ino: st.ino })
    // The staging directory is made in the real root, not through the link's own entry.
    expect(fs.existsSync(path.join(real, STAGING_DIR_NAME))).toBe(true)
  })
})

describe('bindSkillsRoot: .skillsmith-staging/', () => {
  it('creates it, reports that this call made it, and binds its identity', async () => {
    const root = makeRoot('r')
    const b = await bindSkillsRoot(root)
    const st = fs.lstatSync(path.join(root, STAGING_DIR_NAME), { bigint: true })
    expect(st.isDirectory()).toBe(true)
    expect(b.stagingDir).toBe(path.join(root, STAGING_DIR_NAME))
    expect(b.stagingCreated).toBe(true)
    expect(b.stagingIdentity).toMatchObject({ ok: true, dev: st.dev, ino: st.ino })
    // R was synced after the create; a filesystem that cannot sync a directory is recorded, not hidden.
    expect(b.rootSync).not.toBeNull()
    expect(['synced', 'unsupported']).toContain(b.rootSync?.outcome)
  })

  it('a second bind finds it (EEXIST): not created, same identity, no sync', async () => {
    const root = makeRoot('r')
    const first = await bindSkillsRoot(root)
    const second = await bindSkillsRoot(root)
    expect(first.stagingCreated).toBe(true)
    expect(second.stagingCreated).toBe(false)
    expect(second.rootSync).toBeNull()
    expect(second.stagingIdentity).toEqual(first.stagingIdentity)
  })

  it('a symlink in its place is staging-unsafe and is not followed', async () => {
    const root = makeRoot('r')
    const elsewhere = makeRoot('elsewhere', 0o700)
    fs.symlinkSync(elsewhere, path.join(root, STAGING_DIR_NAME))
    const stop = await stopOf(bindSkillsRoot(root))
    expect(stop.code).toBe('staging-unsafe')
    expect(fs.readdirSync(elsewhere)).toEqual([])
    expect(bits(elsewhere)).toBe(0o700)
  })

  it('a regular file in its place is staging-unsafe', async () => {
    const root = makeRoot('r')
    fs.writeFileSync(path.join(root, STAGING_DIR_NAME), 'x')
    expect((await stopOf(bindSkillsRoot(root))).code).toBe('staging-unsafe')
  })

  it('is never removed by a write, and the lock file exists only while lock 1 is held', async () => {
    const root = makeRoot('r')
    const b = await bindSkillsRoot(root)
    const [lock] = skillsRootLockPaths(b.root)
    let seenDuring = false
    const r = await withSkillWriteLock(b, 'test', async (ctx) => {
      seenDuring = fs.existsSync(lock as string)
      expect(ctx.lockPath).toBe(lock)
      return 'done'
    })
    expect(r).toMatchObject({ ok: true, value: 'done' })
    expect(seenDuring).toBe(true)
    expect(fs.existsSync(lock as string)).toBe(false)
    expect(fs.lstatSync(b.stagingDir).isDirectory()).toBe(true)
  })
})

describe('T-K2 (single uid): staging takes the root permission bits, sticky included', () => {
  it.each([
    ['0777', 0o777],
    ['1777', 0o1777],
    ['0755', 0o755],
    ['0770', 0o770],
  ])('under a %s root, ST has exactly the root bits', async (_label, mode) => {
    const root = makeRoot('r', mode)
    expect(bits(root)).toBe(mode)
    const b = await bindSkillsRoot(root)
    expect(b.stagingCreated).toBe(true)
    expect(bits(b.stagingDir)).toBe(mode)
  })

  it.each([
    ['0777', 0o777],
    ['1777', 0o1777],
  ])(
    'control: a plain mkdir under umask 022 for a %s root would NOT give those bits',
    (_l, mode) => {
      const plain = path.join(base, 'plain')
      fs.mkdirSync(plain, { mode })
      expect(bits(plain)).not.toBe(mode)
    }
  )

  it('an existing ST keeps its own bits (only a created one takes the root bits)', async () => {
    const root = makeRoot('r', 0o777) // was 1777: a sticky root now refuses a non-sticky ST
    const st = path.join(root, STAGING_DIR_NAME)
    fs.mkdirSync(st)
    fs.chmodSync(st, 0o700)
    const b = await bindSkillsRoot(root)
    expect(b.stagingCreated).toBe(false)
    expect(bits(st)).toBe(0o700)
    expect(b.warnings).toHaveLength(1) // narrower than the root, so it is said
  })

  describe('an existing ST is judged by the permission policy too', () => {
    const planted = (rootMode: number, stMode: number): string => {
      const root = makeRoot('r', rootMode)
      const st = path.join(root, STAGING_DIR_NAME)
      fs.mkdirSync(st)
      fs.chmodSync(st, stMode)
      return root
    }

    it('wider than the root is staging-unsafe, and the stop names both modes and the reasons, with no command', async () => {
      const root = planted(0o755, 0o777)
      const stop = await stopOf(bindSkillsRoot(root))
      expect(stop.code).toBe('staging-unsafe')
      expect(stop.detail).toContain('mode 0777')
      expect(stop.detail).toContain('skills root has 0755')
      expect(stop.detail).toContain('group write is allowed')
      expect(stop.detail).toContain('must not give other users more access than the skills root')
      expect(stop.detail).not.toMatch(/chmod/i)
    })

    it('under a tightened root (0700) an older 0755 ST is accepted with no warning', async () => {
      const b = await bindSkillsRoot(planted(0o700, 0o755))
      expect(b.stagingCreated).toBe(false)
      expect(b.warnings).toEqual([])
    })

    it('non-sticky under a 1777 root is staging-unsafe', async () => {
      const stop = await stopOf(bindSkillsRoot(planted(0o1777, 0o777)))
      expect(stop.code).toBe('staging-unsafe')
      expect(stop.detail).toContain('skills root has 1777')
    })

    it('narrower than the root succeeds, with the warning on the binding and the result', async () => {
      const root = planted(0o777, 0o755)
      const b = await bindSkillsRoot(root)
      const expected = [
        `${b.stagingDir} has mode 0755, not its parent's 0777; missing: group write, other write ` +
          '(the directory already existed and was left as it is)',
      ]
      expect(b.stagingCreated).toBe(false)
      expect(b.warnings).toEqual(expected)
      expect(await withSkillWriteLock(b, 't', async () => 'ran')).toMatchObject({
        ok: true,
        warnings: expected,
      })
    })

    it('a ST left behind by a mode-unsafe refusal is refused by the next bind too', async () => {
      const root = makeRoot('r', 0o755)
      fchmodLeaving(() => 0o777)
      const first = await stopOf(bindSkillsRoot(root))
      vi.restoreAllMocks()
      expect(first.code).toBe('staging-unsafe')
      expect(fs.existsSync(path.join(root, STAGING_DIR_NAME))).toBe(true) // left behind
      const second = await stopOf(bindSkillsRoot(root))
      expect(second.code).toBe('staging-unsafe')
      expect(second.detail).toContain('mode 0777')
    })
  })
})

/** Real `fchmod`, but leaving `mode(wanted)` (a kernel that clears setgid, a filesystem that adds bits). */
function fchmodLeaving(mode: (wanted: number) => number): void {
  const real = fs.fchmodSync.bind(fs)
  vi.spyOn(fs, 'fchmodSync').mockImplementation((fd, wanted) => real(fd, mode(Number(wanted))))
}

describe('the permission policy reaches the caller (staging narrower or wider than the root)', () => {
  const dropSetgid = (wanted: number): number => wanted & ~0o2000

  it('ST narrower than R: the binding carries a warning, and so does every withSkillWriteLock result', async () => {
    const root = makeRoot('r', 0o2777)
    fchmodLeaving(dropSetgid)
    const b = await bindSkillsRoot(root)
    const expected = [
      `${b.stagingDir} has mode 0777, not its parent's 2777; missing: setgid ` +
        '(chmod ran, but the filesystem or kernel left these bits unset)',
    ]
    expect(b.stagingBits).toEqual({ state: 'mismatch', wanted: 0o2777, actual: 0o777 })
    expect(b.warnings).toEqual(expected)
    const ok = await withSkillWriteLock(b, 't', async () => 'ran')
    expect(ok).toMatchObject({ ok: true, value: 'ran', warnings: expected })
    // A refusal carries them too: the caller still has to be told.
    fs.writeFileSync(path.join(b.root, `${SKILL_WRITE_LOCK_BASENAME}.lock`), 'not a claim\n')
    const busy = await withSkillWriteLock(b, 't', async () => 'ran', { timeoutMs: 200 })
    expect(!busy.ok && busy.stop.code).toBe('busy')
    expect(busy.warnings).toEqual(expected)
  })

  it('given a path instead of a binding, the result still carries the warnings', async () => {
    const root = makeRoot('r', 0o2777)
    fchmodLeaving(dropSetgid)
    const r = await withSkillWriteLock(root, 't', async () => 'ran')
    expect(r.ok).toBe(true)
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings?.[0]).toContain('missing: setgid')
  })

  it('control: ST exact, no warnings, and the result has no warnings field at all', async () => {
    const root = makeRoot('r', 0o2777)
    const b = await bindSkillsRoot(root)
    const r = await withSkillWriteLock(b, 't', async () => 'ran')
    expect(b.warnings).toEqual([])
    expect('warnings' in r).toBe(false)
  })

  it('ST wider than R is staging-unsafe, and the stop names both modes and the reasons, with no command', async () => {
    const root = makeRoot('r', 0o755)
    fchmodLeaving(() => 0o777)
    const stop = await stopOf(bindSkillsRoot(root))
    expect(stop.code).toBe('staging-unsafe')
    expect(stop.detail).toContain('mode 0777')
    expect(stop.detail).toContain('skills root has 0755')
    expect(stop.detail).toContain('group write is allowed')
    expect(stop.detail).not.toMatch(/chmod/i)
  })
})

describe('withSkillWriteLock given a path', () => {
  it('binds first: a missing root comes back as a root-unsafe stop and creates nothing', async () => {
    const r = await withSkillWriteLock(path.join(base, 'nope'), 't', async () => 'ran')
    expect(r.ok).toBe(false)
    expect(!r.ok && r.stop.code).toBe('root-unsafe')
    expect(fs.readdirSync(base)).toEqual([])
  })

  it('runs fn under lock 1 with the context it bound', async () => {
    const root = makeRoot('r')
    let ctxLock = ''
    const r = await withSkillWriteLock(root, 't', async (ctx) => {
      ctxLock = ctx.lockPath
      const st = fs.lstatSync(ctx.lockPath, { bigint: true })
      expect(ctx.lockIdentity).toMatchObject({ ok: true, dev: st.dev, ino: st.ino })
      expect(ctx.root).toBe(fs.realpathSync.native(root))
      return 42
    })
    expect(r).toMatchObject({ ok: true, value: 42 })
    expect(ctxLock).toBe(
      path.join(fs.realpathSync.native(root), `${SKILL_WRITE_LOCK_BASENAME}.lock`)
    )
  })
})

describe('skillsRootLockPaths', () => {
  it('is the lock file and its reclaim lock, inside the root', () => {
    expect(skillsRootLockPaths('/x/skills')).toEqual([
      '/x/skills/.skillsmith-writes.lock',
      '/x/skills/.skillsmith-writes.lock.reclaim',
    ])
  })
})
