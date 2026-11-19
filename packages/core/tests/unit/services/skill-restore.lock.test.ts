/**
 * SMI-6531 (A1 step 6d-ii): restore's use of its lock (design note §3.1 check 4,
 * §5.1): a recheck immediately before every write, a stranded-claim report, the
 * lock chosen from the origin's current skills root, and the disagreement with
 * prune's lock. The lock 1prime runner is replaced through `hooks.runLock`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ParkedLockChanged, runLockedForTests } from '../../../src/config/file-lock.parked.js'
import { executeRestoreWith } from '../../../src/services/skill-restore.exec.js'
import type { RestoreHooks } from '../../../src/services/skill-restore.types.js'
import { withSkillWriteLock } from '../../../src/services/skill-write-lock.js'
import {
  indexKind,
  mkEnv,
  parkEntry,
  planOk,
  type Env,
  type Made,
} from './skill-restore.helpers.js'

let env: Env
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(env.base, { recursive: true, force: true })
})

/** A parked entry outside every skills root, so restore takes lock 1prime. */
function outside(type: 'dir' | 'file' | 'symlink'): Made {
  const p = path.join(env.base, 'proj-outside')
  const m = parkEntry(p, 'thing', { caller: 'init-rollback', type })
  indexKind(env.stateRoot, m.copyPath, m.opId, 'init-rollback')
  return m
}

const spy = vi.spyOn as unknown as (
  t: object,
  k: string
) => { mockImplementation: (f: unknown) => void }

type RunLock = NonNullable<RestoreHooks['runLock']>

/** A lock 1prime runner that logs each `recheck()` and lets a test change what `recheck` does. */
function loggingRunner(events: string[], onRecheck?: (n: number) => void): RunLock {
  let n = 0
  return (lockPath, label, fn, options) =>
    runLockedForTests(
      lockPath,
      label,
      (ctx) =>
        fn({
          recheck: () => {
            n++
            events.push('recheck')
            onRecheck?.(n)
            ctx.recheck()
          },
        }),
      options ?? {}
    ) as ReturnType<RunLock>
}

describe('stranded lock claim', () => {
  it('a locks/ folder swapped after the claim is reported on the result, with no mutation', async () => {
    env = mkEnv()
    const m = outside('dir')
    const plan = await planOk(m.copyPath, env.opts)
    expect(plan.lock.kind).toBe('lock1prime')
    const locks = path.join(env.stateRoot, 'locks')
    const runLock: RunLock = (lockPath, label, fn, options) =>
      runLockedForTests(lockPath, label, fn, {
        ...(options ?? {}),
        hooks: {
          beforeFn: () => {
            fs.renameSync(locks, `${locks}.moved`)
            fs.mkdirSync(locks)
          },
        },
      }) as ReturnType<RunLock>
    const r = await executeRestoreWith(plan, { runLock })
    expect(r.status).toBe('refused')
    if (r.status === 'restored') return
    expect(r.reason).toBe('locks-dir-changed')
    expect(r.strandedLockClaim).toBeDefined()
    expect(r.strandedLockClaim?.lockName).toMatch(/^parked-[0-9a-f]{16}\.lock$/)
    expect(fs.existsSync(path.join(`${locks}.moved`, r.strandedLockClaim!.lockName))).toBe(true)
    expect(fs.existsSync(m.origin)).toBe(false)
    expect(fs.existsSync(m.copyPath)).toBe(true)
  })
})

describe('a recheck immediately before every write', () => {
  const writesOf = (m: Made): Record<string, string[]> => ({
    dir: [`mkdir:${m.origin}`, `rename:${m.copyPath}`, `unlink:${m.sidecarPath}`],
    file: [`link:${m.copyPath}`, `unlink:${m.copyPath}`, `unlink:${m.sidecarPath}`],
    symlink: [`symlink:${m.origin}`, `unlink:${m.copyPath}`, `unlink:${m.sidecarPath}`],
  })

  for (const type of ['dir', 'file', 'symlink'] as const) {
    it(`${type}: each write is directly preceded by a recheck, and the writes are the expected ones`, async () => {
      env = mkEnv()
      const m = outside(type)
      const plan = await planOk(m.copyPath, env.opts)
      const events: string[] = []
      const watch = (name: string, target: object, key: string, argIdx: number[]): void => {
        const orig = (target as Record<string, (...a: unknown[]) => unknown>)[key]!
        spy(target, key).mockImplementation((...a: unknown[]) => {
          const hit = argIdx
            .map((i) => String(a[i]))
            .find((x) => [m.origin, m.copyPath, m.sidecarPath].includes(x))
          if (hit !== undefined) events.push(`write:${name}:${hit}`)
          return orig.apply(target, a)
        })
      }
      watch('mkdir', fs.promises, 'mkdir', [0])
      watch('rename', fs.promises, 'rename', [0])
      watch('link', fs, 'linkSync', [0])
      watch('symlink', fs, 'symlinkSync', [1])
      watch('unlink', fs, 'unlinkSync', [0])
      const r = await executeRestoreWith(plan, { runLock: loggingRunner(events) })
      expect(r.status).toBe('restored')
      const writes = events.filter((e) => e.startsWith('write:')).map((e) => e.slice(6))
      expect(writes).toEqual(writesOf(m)[type])
      events.forEach((e, i) => {
        if (e.startsWith('write:')) expect(events[i - 1], `before ${e}`).toBe('recheck')
      })
    })
  }

  it('a recheck that throws before the parked name is unlinked stops there: nothing further is written', async () => {
    env = mkEnv()
    const m = outside('file')
    const plan = await planOk(m.copyPath, env.opts)
    const unlink = vi.spyOn(fs, 'unlinkSync')
    const runLock = loggingRunner([], (n) => {
      if (n === 3) throw new ParkedLockChanged(env.stateRoot, 'test swap')
    })
    const r = await executeRestoreWith(plan, { runLock })
    expect(r.status).toBe('stopped')
    if (r.status === 'restored') return
    // After the link: reported as the F4 stop naming both paths (see skill-restore.guard.test.ts).
    expect(r.reason).toBe('unlink-failed')
    expect(r.changed).toBe(true)
    expect(fs.existsSync(m.origin)).toBe(true)
    expect(fs.existsSync(m.copyPath)).toBe(true)
    expect(fs.existsSync(m.sidecarPath)).toBe(true)
    expect(unlink.mock.calls.map((c) => String(c[0]))).not.toContain(m.copyPath)
    expect(unlink.mock.calls.map((c) => String(c[0]))).not.toContain(m.sidecarPath)
  })
})

describe('the lock follows the origin: (a1) and the disagreement with prune', () => {
  it('RS1-reclassified (a1): the area parent itself became a root; a writer holding its lock 1 makes restore busy', async () => {
    env = mkEnv()
    const p = path.join(env.base, 'proj-now-root')
    const m = parkEntry(p, 'skill-i', { caller: 'init-rollback' })
    indexKind(env.stateRoot, m.copyPath, m.opId, 'init-rollback')
    const plan = await planOk(m.copyPath, { ...env.opts, roots: [p] })
    expect(plan.lock.kind).toBe('lock1')
    expect(plan.lock.path).toBe(path.join(p, '.skillsmith-writes.lock'))
    // The area is now scanned, so prune names the same lock and there is nothing to disagree about.
    expect(plan.lockDisagreement).toBeNull()
    let release!: () => void
    const held = new Promise<void>((res) => (release = res))
    let acquired!: () => void
    const got = new Promise<void>((res) => (acquired = res))
    const holder = withSkillWriteLock(p, 'test writer', async () => {
      acquired()
      await held
    })
    await got
    const busy = await executeRestoreWith(plan, { lockTimeoutMs: 200 })
    expect(busy.status).toBe('refused')
    if (busy.status !== 'restored') expect(busy.reason).toBe('restore-busy')
    expect(fs.existsSync(m.origin)).toBe(false)
    expect(fs.existsSync(m.copyPath)).toBe(true)
    release()
    await holder
    expect((await executeRestoreWith(plan)).status).toBe('restored')
  })

  it('an ancestor that became a root: the disagreement is data as well as a note', async () => {
    env = mkEnv()
    const r = path.join(env.base, 'rproj')
    const m = parkEntry(path.join(r, 'proj'), 'skill-i', { caller: 'init-rollback' })
    indexKind(env.stateRoot, m.copyPath, m.opId, 'init-rollback')
    const plan = await planOk(m.copyPath, { ...env.opts, roots: [r] })
    expect(plan.lockDisagreement).not.toBeNull()
    expect(plan.lockDisagreement?.restore).toEqual(plan.lock)
    expect(plan.lockDisagreement?.prune?.kind).toBe('lock1prime')
  })
})
