/**
 * SMI-6531 (A1 step 6d-ii, pre-merge gate): `executeRestore` trusts nothing a
 * caller wrote into its plan. Under the lock the plan is re-derived and must
 * agree on target, lock, type, copy identity and record identity; execution
 * then uses the re-derived plan. The parked folder must still be the planned one
 * before the claim and again before the rename (design note §5.2 D1).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ParkedLockChanged, runLockedForTests } from '../../../src/config/file-lock.parked.js'
import { executeRestore, executeRestoreWith } from '../../../src/services/skill-restore.exec.js'
import { replanUnderLock } from '../../../src/services/skill-restore.js'
import type { RestoreHooks, RestorePlan } from '../../../src/services/skill-restore.types.js'
import { indexKind, mkEnv, parkEntry, planOk, type Env } from './skill-restore.helpers.js'

let env: Env
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(env.base, { recursive: true, force: true })
})

type Result = Awaited<ReturnType<typeof executeRestoreWith>>
const planChanged = (r: Result): void => {
  expect(r.status).toBe('refused')
  if (r.status !== 'restored') {
    expect(r.reason).toBe('plan-changed')
    expect(r.changed).toBe(false)
  }
}

describe('a plan with a field the caller changed is plan-changed, with nothing written', () => {
  const swapped: Array<[string, (p: RestorePlan, e: Env) => RestorePlan]> = [
    ['target', (p, e) => ({ ...p, target: path.join(e.base, 'elsewhere') })],
    [
      'lock',
      (p, e) => ({
        ...p,
        lock: { kind: 'lock1', root: e.root2, path: path.join(e.root2, '.skillsmith-writes.lock') },
      }),
    ],
    ['type', (p) => ({ ...p, type: 'symlink' })],
    ['sidecarIno', (p) => ({ ...p, sidecarIno: p.sidecarIno + 1n })],
    ['sidecarBytes', (p) => ({ ...p, sidecarBytes: Buffer.from('not the record') })],
    [
      'rootIdentity',
      (p) => ({ ...p, rootIdentity: { ...p.rootIdentity, ino: p.rootIdentity.ino + 1n } }),
    ],
  ]
  for (const [field, swap] of swapped) {
    it(field, async () => {
      env = mkEnv()
      const m = parkEntry(env.root, 'f.txt', { type: 'file' })
      const plan = await planOk(m.copyPath, env.opts)
      const r = await executeRestoreWith(swap(plan, env))
      planChanged(r)
      expect(fs.existsSync(m.origin)).toBe(false)
      expect(fs.existsSync(path.join(env.base, 'elsewhere'))).toBe(false)
      expect(fs.existsSync(m.copyPath)).toBe(true)
      expect(fs.existsSync(m.sidecarPath)).toBe(true)
    })
  }
})

describe('the plan own test seams are not read', () => {
  it('the public executeRestore ignores plan.options.discovery: a plan that needs it is plan-changed', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'skill-a')
    const plan = await planOk(m.copyPath, env.opts)
    expect(plan.options.discovery).toBeDefined()
    planChanged(await executeRestore(plan))
    expect(fs.existsSync(m.origin)).toBe(false)
  })

  it('replanUnderLock reads discovery only from its seams argument', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'skill-a')
    const plan = await planOk(m.copyPath, env.opts)
    const without = await replanUnderLock(plan)
    expect(without.status).toBe('refused')
    const withSeam = await replanUnderLock(plan, { discovery: env.opts.discovery! })
    expect(withSeam.status).toBe('planned')
  })
})

describe('the parked folder is still the planned one (§5.2 D1)', () => {
  /** Puts an impostor folder at the parked name, the real one aside. */
  const swapCopy = (copyPath: string): void => {
    fs.renameSync(copyPath, `${copyPath}.real`)
    fs.mkdirSync(copyPath)
    fs.writeFileSync(path.join(copyPath, 'SKILL.md'), 'impostor')
  }

  it('swapped before the claim: plan-changed, nothing claimed, the record kept', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'skill-a')
    const plan = await planOk(m.copyPath, env.opts)
    const r = await executeRestoreWith(plan, { beforeClaim: () => swapCopy(m.copyPath) })
    planChanged(r)
    expect(fs.existsSync(m.origin)).toBe(false)
    expect(fs.readFileSync(path.join(m.copyPath, 'SKILL.md'), 'utf8')).toBe('impostor')
    expect(fs.existsSync(`${m.copyPath}.real`)).toBe(true)
    expect(fs.existsSync(m.sidecarPath)).toBe(true)
  })

  it('swapped between the claim and the rename: the claim is left and reported, nothing restored', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'skill-a')
    const plan = await planOk(m.copyPath, env.opts)
    let n = 0
    // checks: 1 initial, 2 before the claim, 3 immediately before the rename
    const wrapCheck: RestoreHooks['wrapCheck'] = (real) => () => {
      if (++n === 3) swapCopy(m.copyPath)
      real()
    }
    const r = await executeRestoreWith(plan, { wrapCheck })
    expect(r.status).toBe('stopped')
    if (r.status === 'restored') return
    expect(r.reason).toBe('claim-left')
    expect(r.changed).toBe(true)
    expect(r.message).toContain('rmdir')
    expect(fs.readdirSync(m.origin)).toEqual([])
    expect(fs.readFileSync(path.join(m.copyPath, 'SKILL.md'), 'utf8')).toBe('impostor')
    expect(fs.existsSync(`${m.copyPath}.real`)).toBe(true)
    expect(fs.existsSync(m.sidecarPath)).toBe(true)
  })
})

describe('F3 binds the parked name to the planned entry', () => {
  it('both names replaced by hard links to a foreign file: link-stopped, changed, the record kept', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'f.txt', { type: 'file' })
    const plan = await planOk(m.copyPath, env.opts)
    const foreign = path.join(env.base, 'foreign.txt')
    fs.writeFileSync(foreign, 'a foreign file')
    const r = await executeRestoreWith(plan, {
      afterLink: () => {
        fs.unlinkSync(m.origin)
        fs.unlinkSync(m.copyPath)
        fs.linkSync(foreign, m.origin)
        fs.linkSync(foreign, m.copyPath)
      },
    })
    expect(r.status).toBe('stopped')
    if (r.status === 'restored') return
    expect(r.reason).toBe('link-stopped')
    expect(r.changed).toBe(true)
    expect(fs.existsSync(m.sidecarPath)).toBe(true)
    expect(fs.readFileSync(m.copyPath, 'utf8')).toBe('a foreign file')
  })
})

describe('a symlink stop says the links, not the entry', () => {
  const LINKS = 'Both are links with the same text'

  it('RS2-unlink-fails for a symlink', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'lnk', { type: 'symlink', linkText: 'some-target' })
    const plan = await planOk(m.copyPath, env.opts)
    const orig = fs.unlinkSync.bind(fs)
    vi.spyOn(fs, 'unlinkSync').mockImplementation(((p: fs.PathLike) => {
      if (String(p) === m.copyPath) throw Object.assign(new Error('forced'), { code: 'EACCES' })
      return orig(p)
    }) as never)
    const r = await executeRestoreWith(plan)
    expect(r.status).toBe('stopped')
    if (r.status === 'restored') return
    expect(r.reason).toBe('unlink-failed')
    expect(r.message).toContain(LINKS)
    expect(r.message).not.toContain('same entry')
  })

  it('a lock that stops holding between the link and the parked unlink, for a symlink', async () => {
    env = mkEnv()
    const p = path.join(env.base, 'proj-outside')
    const m = parkEntry(p, 'lnk', {
      caller: 'init-rollback',
      type: 'symlink',
      linkText: 'some-target',
    })
    indexKind(env.stateRoot, m.copyPath, m.opId, 'init-rollback')
    const plan = await planOk(m.copyPath, env.opts)
    const runLock: NonNullable<RestoreHooks['runLock']> = (lockPath, label, fn, options) => {
      let n = 0
      return runLockedForTests(
        lockPath,
        label,
        (ctx) =>
          fn({
            recheck: () => {
              if (++n === 3) throw new ParkedLockChanged(env.stateRoot, 'test swap')
              ctx.recheck()
            },
          }),
        options ?? {}
      ) as ReturnType<NonNullable<RestoreHooks['runLock']>>
    }
    const r = await executeRestoreWith(plan, { runLock })
    expect(r.status).toBe('stopped')
    if (r.status === 'restored') return
    expect(r.reason).toBe('unlink-failed')
    expect(r.message).toContain(LINKS)
    expect(r.message).not.toContain('same entry')
  })
})

describe('F3 and S4 bind the parked name by birthtime as well', () => {
  /** Reports `copyPath` with the bound dev, ino and mode but another birthtime, once armed. */
  const lstatWithOtherBirthtime = (copyPath: string, armed: () => boolean): void => {
    const orig = fs.lstatSync.bind(fs) as (a: fs.PathLike, b?: unknown) => unknown
    vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, o?: { bigint?: boolean }) => {
      const st = orig(p, o) as fs.BigIntStats
      if (armed() && String(p) === copyPath && o?.bigint === true) {
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
          birthtimeNs: st.birthtimeNs + 1n,
        })
      }
      return st
    }) as never)
  }

  for (const type of ['file', 'symlink'] as const) {
    it(`${type}: the same dev, ino and mode with a different birthtime is link-stopped, changed, record kept`, async () => {
      env = mkEnv()
      const m = parkEntry(env.root, 'thing', { type })
      const plan = await planOk(m.copyPath, env.opts)
      let armed = false
      lstatWithOtherBirthtime(m.copyPath, () => armed)
      const r = await executeRestoreWith(plan, {
        afterLink: () => {
          armed = true
        },
      })
      expect(r.status).toBe('stopped')
      if (r.status === 'restored') return
      expect(r.reason).toBe('link-stopped')
      expect(r.changed).toBe(true)
      expect(fs.existsSync(m.sidecarPath)).toBe(true)
      expect(fs.lstatSync(m.copyPath, { throwIfNoEntry: false })).toBeDefined()
    })
  }

  it('a real inode-number reuse: both names re-linked to a new file that took the freed inode is link-stopped', async (ctx) => {
    env = mkEnv()
    const m = parkEntry(env.root, 'f.txt', { type: 'file' })
    const plan = await planOk(m.copyPath, env.opts)
    let reused = false
    const r = await executeRestoreWith(plan, {
      afterLink: () => {
        const ino = fs.lstatSync(m.copyPath, { bigint: true }).ino
        fs.unlinkSync(m.origin)
        fs.unlinkSync(m.copyPath)
        for (let i = 0; i < 500 && !reused; i++) {
          const f = path.join(path.dirname(m.copyPath), `reuse-${i}`)
          fs.writeFileSync(f, 'FOREIGN-REUSED')
          if (fs.lstatSync(f, { bigint: true }).ino === ino) {
            fs.linkSync(f, m.origin)
            fs.linkSync(f, m.copyPath)
            reused = true
          }
          fs.unlinkSync(f)
        }
      },
    })
    // The filesystem chooses inode numbers; the test is only meaningful when it reused one. Without
    // reuse both names are simply gone, which proves nothing about the birthtime check, so skip (as
    // prune.walk.binding does). The spy tests above pin the property on every filesystem.
    if (!reused) ctx.skip('no inode reuse this run')
    expect(r.status).toBe('stopped')
    if (r.status === 'restored') return
    expect(r.reason).toBe('link-stopped')
    expect(fs.existsSync(m.sidecarPath)).toBe(true)
  })
})

describe('the public executeRestore works for a plan made without any test seam', () => {
  it('with HOME set to the fixture, a lock 1prime copy restores through the public entry', async () => {
    env = mkEnv()
    const home = process.env['HOME']
    process.env['HOME'] = env.base
    try {
      expect(os.homedir()).toBe(env.base)
      const p = path.join(env.base, 'proj-outside')
      const m = parkEntry(p, 'thing', { caller: 'init-rollback', type: 'file' })
      indexKind(env.stateRoot, m.copyPath, m.opId, 'init-rollback')
      const plan = await planOk(m.copyPath, { stateRoot: env.stateRoot })
      expect(plan.options.discovery).toBeUndefined()
      expect(plan.lock.kind).toBe('lock1prime')
      const r = await executeRestore(plan)
      expect(r.status).toBe('restored')
      expect(fs.readFileSync(m.origin, 'utf8')).toBe('file thing\n')
    } finally {
      if (home === undefined) delete process.env['HOME']
      else process.env['HOME'] = home
    }
  })
})
