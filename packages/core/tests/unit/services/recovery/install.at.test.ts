/**
 * SMI-6531 (A1 step 8-i-a-3a, design § 1.6 and § 8 item 5): `installAt` with
 * no claim tells "nothing touched" from "the claim may be left" through
 * `claimLeftBy`, runs `check` immediately before the claim's `mkdir` and again
 * in claimPublish's `beforeRename` (not its test seam), and stops
 * `write-failed` when the parent the folder left (OP) fails its sync. Every
 * state is a real install record's (`install.helpers.ts`) run under lock 1
 * with `recoveryState`, as doctor runs it. `syncDirectory` is wrapped for the
 * module: it delegates to the real sync unless one directory is chosen to fail.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// `failDir` fails its next `failTimes` syncs, then the real sync runs again.
const sync = vi.hoisted(() => ({ failDir: null as string | null, failTimes: 0, failed: 0 }))
vi.mock('../../../../src/install/dir-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/install/dir-sync.js')>()
  return {
    ...actual,
    syncDirectory: async (dir: string) => {
      if (dir === sync.failDir && sync.failed < sync.failTimes) {
        sync.failed++
        return { outcome: 'failed', code: 'EDQUOT', error: new Error('EDQUOT') }
      }
      return actual.syncDirectory(dir)
    },
  }
})

const { bindIdentity } = await import('../../../../src/install/park-tree.identity.js')
const { claimLeftBy, installAt } = await import('../../../../src/services/skill-recovery.resume.js')
const { recoveryState } = await import('../../../../src/services/skill-recovery.state.js')
const { SwapFault } = await import('../../../../src/services/skill-swap.ops.js')
const { bindSkillsRootReadOnly, withSkillWriteLock } =
  await import('../../../../src/services/skill-write-lock.js')
const { hashOf, useTmpCleanup } = await import('../skill-swap.helpers.js')
const { fi0, idOf, installFixture } = await import('./install.helpers.js')
type IState = import('./install.helpers.js').IState
type SwapHooks = NonNullable<
  import('../../../../src/services/skill-swap.types.js').SwapOptions['hooks']
>

useTmpCleanup()
afterEach(() => {
  sync.failDir = null
  sync.failTimes = 0
  sync.failed = 0
  vi.restoreAllMocks()
})

/**
 * Runs `installAt(N, no claim)` under lock 1 as doctor does; returns what it
 * threw (or null), with `before` run under the lock just before the call.
 */
async function runAt(
  st: IState,
  o: { hooks?: SwapHooks; before?: () => void } = {}
): Promise<unknown> {
  const binding = await bindSkillsRootReadOnly(st.fx.skillsDir)
  if (binding === null) throw new Error('no binding')
  const id = bindIdentity(st.newDir)
  if (!id.ok) throw new Error('N has no identity')
  const r = await withSkillWriteLock(binding, 'test installAt', async (ctx) => {
    const s = recoveryState({
      record: st.record,
      binding: ctx,
      ctx,
      options: o.hooks === undefined ? {} : { hooks: o.hooks },
    })
    o.before?.()
    try {
      await installAt(s, st.newDir, null, { identity: id, hash: st.record.postTree })
      return null
    } catch (err) {
      return err
    }
  })
  if (!r.ok) throw new Error(`lock 1 refused: ${JSON.stringify(r)}`)
  return r.value
}

const reasonOf = (err: unknown): string =>
  err instanceof SwapFault ? err.reason : `not a fault: ${String(err)}`
const isEmptyDir = (p: string): boolean =>
  fs.lstatSync(p).isDirectory() && fs.readdirSync(p).length === 0

/** Replaces the root's lock-1 file by another inode: `check` under the lock refuses it. */
function replaceLockFile(root: string): void {
  const locks = fs.readdirSync(root).filter((n) => n.endsWith('.lock'))
  expect(locks).toHaveLength(1)
  const p = path.join(root, locks[0]!)
  const bytes = fs.readFileSync(p)
  fs.renameSync(p, `${p}.aside`)
  fs.writeFileSync(p, bytes)
}

describe('installAt without a claim: nothing touched', () => {
  it('control: N is published at the skill path, and no error', async () => {
    const st = fi0(installFixture())
    expect(await runAt(st)).toBeNull()
    expect(idOf(st.fx.realDir)).toEqual(st.record.newIdentity)
    expect(fs.existsSync(st.newDir)).toBe(false)
  })

  it('something at the skill path: target-changed, claimLeftBy false, the entry and N untouched', async () => {
    const st = fi0(installFixture())
    fs.mkdirSync(st.fx.realDir)
    fs.writeFileSync(path.join(st.fx.realDir, 'mine.txt'), 'user\n')
    const before = idOf(st.fx.realDir)
    const err = await runAt(st)
    expect(reasonOf(err)).toBe('target-changed')
    expect(claimLeftBy(err)).toBe(false)
    expect(idOf(st.fx.realDir)).toEqual(before)
    expect(hashOf(st.newDir)).toBe(st.record.postTree)
  })

  it('the claim mkdir fails: write-failed, claimLeftBy false, the skill path absent', async () => {
    const st = fi0(installFixture())
    const mkdir = fs.promises.mkdir
    const spy = vi
      .spyOn(fs.promises, 'mkdir')
      .mockImplementation(((p: fs.PathLike, ...rest: never[]) =>
        String(p) === st.fx.realDir
          ? Promise.reject(Object.assign(new Error('forced'), { code: 'EACCES' }))
          : mkdir(p, ...rest)) as typeof fs.promises.mkdir)
    const err = await runAt(st)
    expect(spy).toHaveBeenCalledWith(st.fx.realDir)
    expect(reasonOf(err)).toBe('write-failed')
    expect(String((err as Error).message)).toContain('claim-failed')
    expect(claimLeftBy(err)).toBe(false)
    expect(fs.existsSync(st.fx.realDir)).toBe(false)
    expect(hashOf(st.newDir)).toBe(st.record.postTree)
  })

  it('the root changed before the call: check refuses before the claim; claimLeftBy false, no claim', async () => {
    const st = fi0(installFixture())
    const err = await runAt(st, { before: () => replaceLockFile(st.fx.skillsDir) })
    expect(err).not.toBeNull()
    expect(claimLeftBy(err)).toBe(false)
    expect(fs.existsSync(st.fx.realDir)).toBe(false)
    expect(hashOf(st.newDir)).toBe(st.record.postTree)
  })
})

describe('installAt without a claim: the claim may be left', () => {
  it('the rename fails: write-failed, claimLeftBy true, the empty claim and N in place', async () => {
    const st = fi0(installFixture())
    vi.spyOn(fs.promises, 'rename').mockRejectedValue(
      Object.assign(new Error('forced'), { code: 'EIO' })
    )
    const err = await runAt(st)
    expect(reasonOf(err)).toBe('write-failed')
    expect(String((err as Error).message)).toContain('rename-failed')
    expect(claimLeftBy(err)).toBe(true)
    expect(isEmptyDir(st.fx.realDir)).toBe(true)
    expect(hashOf(st.newDir)).toBe(st.record.postTree)
  })

  it('N edited between the claim and the rename: staging-unsafe, claimLeftBy true, the claim empty', async () => {
    const st = fi0(installFixture())
    const err = await runAt(st, {
      hooks: { afterClaim: () => fs.writeFileSync(path.join(st.newDir, 'SKILL.md'), '# edited\n') },
    })
    expect(reasonOf(err)).toBe('staging-unsafe')
    expect(claimLeftBy(err)).toBe(true)
    expect(isEmptyDir(st.fx.realDir)).toBe(true)
    expect(fs.existsSync(path.join(st.newDir, 'SKILL.md'))).toBe(true)
  })

  it('lock 1 replaced between the claim and the rename: check in beforeRename refuses; N not published', async () => {
    const st = fi0(installFixture())
    const err = await runAt(st, { hooks: { afterClaim: () => replaceLockFile(st.fx.skillsDir) } })
    expect(err).not.toBeNull()
    expect(claimLeftBy(err)).toBe(true)
    expect(isEmptyDir(st.fx.realDir)).toBe(true)
    expect(hashOf(st.newDir)).toBe(st.record.postTree)
  })

  it('OP fails its sync after the publish: write-failed naming OP, claimLeftBy true, N published', async () => {
    const st = fi0(installFixture())
    // Only claimPublish's source sync fails (the first sync of OP): the
    // failure it reports must stop the run, though OP would sync again later.
    sync.failDir = st.opDir
    sync.failTimes = 1
    const err = await runAt(st)
    expect(sync.failed).toBe(1)
    expect(reasonOf(err)).toBe('write-failed')
    expect((err as InstanceType<typeof SwapFault>).detail).toBe(
      `${st.opDir} could not be synced (EDQUOT)`
    )
    expect(claimLeftBy(err)).toBe(true)
    expect(idOf(st.fx.realDir)).toEqual(st.record.newIdentity)
    expect(fs.existsSync(st.newDir)).toBe(false)
  })

  it('an unknown throw answers true (fail closed)', () => {
    expect(claimLeftBy(new Error('anything'))).toBe(true)
    expect(claimLeftBy('a string')).toBe(true)
    expect(claimLeftBy(null)).toBe(true)
  })
})
