/**
 * SMI-6531 (A1 step 6a-ii): the core half of the confirmation contract (§3.9
 * items 6-7) and the root sweep: the re-plan under lock 1 compares a digest of
 * everything the classifier read, so an edit between confirmation and lock is
 * `plan-changed` with zero mutation (T-J15's `plan-changed` case, T-J6's
 * in-place rewrites); another user's record is refused before lock 1 (T-K2's
 * unit case); listed probes and empty op dirs are removed with one `rmdir`,
 * and only those (T-X18 (e)).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LockOrderError } from '../../../../src/config/lock-tracker.js'
import { executeRecovery } from '../../../../src/services/skill-recovery.run.js'
import { planRecovery } from '../../../../src/services/skill-recovery.target.js'
import { withSkillWriteLock } from '../../../../src/services/skill-write-lock.js'
import { makeFixture, useTmpCleanup } from '../skill-swap.helpers.js'
import { keepTree, report, s2, s3 } from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'
import { act, contentSnapshot, done, requestOf } from './recovery.act.helpers.js'

useTmpCleanup()

const file = () => makeFixture({ 'SKILL.md': '# v1\n', 'docs/a.md': 'a\n' })

const world = (st: State): string => contentSnapshot(st.fx.skillsDir, st.fx.stateRoot, st.fx.base)

/** Plans, runs `between` (the gap between the prompt and lock 1), then executes. */
async function withGap(st: State, between: () => void) {
  const planned = await planRecovery(requestOf(st, 'apply'))
  if (planned.status !== 'planned') throw new Error(`not planned: ${JSON.stringify(planned)}`)
  between()
  const before = world(st)
  const result = await executeRecovery(planned)
  return { result, before }
}

/** Rewrites a JSON file in place (same inode) with other whitespace: same meaning, new bytes. */
function rewriteInPlace(p: string): void {
  const ino = fs.lstatSync(p).ino
  const v: unknown = JSON.parse(fs.readFileSync(p, 'utf8'))
  fs.writeFileSync(p, JSON.stringify(v))
  expect(fs.lstatSync(p).ino).toBe(ino)
}

describe('re-plan under lock 1: plan-changed with zero mutation', () => {
  it('O edited between confirmation and lock (the no-re-plan control acts on the edited O)', async () => {
    const st = await s2(file())
    const { result, before } = await withGap(st, () =>
      fs.writeFileSync(path.join(st.opDir, 'old', 'SKILL.md'), '# edited after the prompt\n')
    )
    expect(result).toMatchObject({ status: 'refused', reason: 'plan-changed' })
    expect(world(st)).toBe(before)
  })

  it('record.json rewritten in place (same inode, new bytes) between confirmation and lock', async () => {
    const st = await s2(file())
    const { result, before } = await withGap(st, () =>
      rewriteInPlace(path.join(st.opDir, 'record.json'))
    )
    expect(result).toMatchObject({ status: 'refused', reason: 'plan-changed' })
    expect(world(st)).toBe(before)
  })

  it('a sidecar rewritten in place between confirmation and lock', async () => {
    const st = await s3(file())
    const dest = keepTree(st, 'old', 'backup', { move: false })
    const { result, before } = await withGap(st, () => rewriteInPlace(`${dest}.json`))
    expect(result).toMatchObject({ status: 'refused', reason: 'plan-changed' })
    expect(world(st)).toBe(before)
  })

  it('the positive: nothing changed in the gap, and the same plan runs', async () => {
    const st = await s2(file())
    const { result } = await withGap(st, () => undefined)
    expect(result.status).toBe('done')
  })

  it('owner.json rewritten in place between the re-plan and its unlink: refused, untouched', async () => {
    const st = await s2(file())
    const owner = path.join(st.opDir, 'owner.json')
    const a = await act(
      st,
      'apply',
      {},
      {
        swap: { hooks: { beforeMetadataCleanup: () => rewriteInPlace(owner) } },
      }
    )
    expect(a.result).toMatchObject({ status: 'stopped', reason: 'staging-unsafe' })
    const text = fs.readFileSync(owner, 'utf8')
    expect(text.includes('\n')).toBe(false)
    expect(fs.existsSync(path.join(st.opDir, 'record.json'))).toBe(true)
    // The rerun reads the rewritten bytes and adopts them: it finishes.
    const again = await done(st, 'apply')
    expect(again.trace).toContainEqual({ op: 'unlink', path: owner })
  })
})

describe("T-K2 unit: another user's record is refused before lock 1", () => {
  it('recovery-other-user names the uid, and no lock 1 is requested', async () => {
    const st = await s2(file())
    const before = world(st)
    // Holding lock 1 for this root: a second request for it would throw `LockOrderError`.
    const r = await withSkillWriteLock(st.fx.skillsDir, 'test holder', async () =>
      act(st, 'apply', { euid: 424242 })
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.result).toMatchObject({ status: 'refused', reason: 'recovery-other-user' })
      if (r.value.result.status === 'refused') expect(r.value.result.detail).toContain('uid')
    }
    expect(world(st)).toBe(before)
  })

  it('the probe works: with the same uid under that hold, lock 1 is requested and throws', async () => {
    const st = await s2(file())
    let threw: unknown = null
    await withSkillWriteLock(st.fx.skillsDir, 'test holder', async () => {
      try {
        await act(st, 'apply')
      } catch (err) {
        threw = err
      }
    })
    expect(threw).toBeInstanceOf(LockOrderError)
  })
})

describe('T-X18 (e): leftover probes and empty op dirs', () => {
  it('a listed probe is removed with one rmdir; one holding a file stays, with its errno', async () => {
    const st = await s2(file())
    const probe = path.join(st.fx.staging, `.skillsmith-probe-${'c'.repeat(32)}-1`)
    const full = path.join(st.fx.staging, `.skillsmith-probe-${'d'.repeat(32)}-2`)
    const empty = path.join(st.fx.staging, 'e'.repeat(32))
    fs.mkdirSync(probe)
    fs.mkdirSync(full)
    fs.writeFileSync(path.join(full, 'x'), 'not a probe\n')
    fs.mkdirSync(empty)
    const a = await done(st, 'apply')
    expect(a.result.swept.removed.sort()).toEqual([empty, probe].sort())
    expect(a.result.swept.left).toEqual([{ path: full, errno: 'ENOTEMPTY' }])
    expect(fs.existsSync(probe)).toBe(false)
    expect(fs.readFileSync(path.join(full, 'x'), 'utf8')).toBe('not a probe\n')
  })

  it('a probe that appeared after confirmation survives and is listed next run', async () => {
    const st = await s2(file())
    const late = path.join(st.fx.staging, `.skillsmith-probe-${'f'.repeat(32)}-1`)
    const { result } = await withGap(st, () => fs.mkdirSync(late))
    expect(result.status).toBe('done')
    expect(fs.existsSync(late)).toBe(true)
    if (result.status === 'done') expect(result.swept.removed).not.toContain(late)
    const next = await report(st)
    expect(next.probes.map((p) => p.path)).toEqual([late])
  })
})

describe('sweepRoot: a listed probe swapped for another empty directory', () => {
  it('is left and reported IDENTITY_CHANGED; the listed one would have gone', async () => {
    const st = await s2(file())
    const probe = path.join(st.fx.staging, `.skillsmith-probe-${'c'.repeat(32)}-1`)
    fs.mkdirSync(probe)
    let swappedIno: bigint | null = null
    const { result } = await withGap(st, () => {
      const next = `${probe}.next`
      fs.mkdirSync(next)
      swappedIno = fs.lstatSync(next, { bigint: true }).ino
      fs.rmdirSync(probe)
      fs.renameSync(next, probe)
    })
    expect(result.status).toBe('done')
    if (result.status === 'done') {
      expect(result.swept.left).toEqual([{ path: probe, errno: 'IDENTITY_CHANGED' }])
      expect(result.swept.removed).toEqual([])
    }
    expect(fs.lstatSync(probe, { bigint: true }).ino).toBe(swappedIno)
  })
})
