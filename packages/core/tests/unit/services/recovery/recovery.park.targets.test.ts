/**
 * SMI-6531 (A1 step 6b-i): `--park`'s race between the guardability check and
 * the park (bf-1k0 Major 1, C13), O3b (OP's uid), and the targeting shared by
 * the 6b actions: O3a's `already-parked`, the empty-target plan, T-J12's
 * ambiguity and T-X18 (e)'s sweep (design `step6b-design.md` § 6).
 */
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** Every request for lock 1 (`withSkillWriteLock`), counted through a pass-through mock. */
const locks = vi.hoisted(() => ({ n: 0 }))
vi.mock('../../../../src/services/skill-write-lock.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../src/services/skill-write-lock.js')>()
  return {
    ...actual,
    withSkillWriteLock: (...a: Parameters<typeof actual.withSkillWriteLock>) => {
      locks.n++
      return actual.withSkillWriteLock(...a)
    },
  }
})

import { planRecovery } from '../../../../src/services/skill-recovery.target.js'
import type { RecoveryAction } from '../../../../src/services/skill-recovery.types.js'
import { refusedOf } from '../skill-swap.abort.helpers.js'
import { makeFixture, useTmpCleanup } from '../skill-swap.helpers.js'
import type { Fixture } from '../skill-swap.helpers.js'
import { attempt, opDirOf, opIdN, otherSkill } from '../skill-swap.scan.helpers.js'
import { act, contentSnapshot, removedBy, requestOf } from './recovery.act.helpers.js'
import { s2 } from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'

useTmpCleanup()

afterEach(() => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
})

const file = () => makeFixture({ 'SKILL.md': '# v1\n' })
const SIX_B: RecoveryAction[] = ['park', 'clean-staging', 'abandon']

async function corrupt(fx: Fixture = file()): Promise<State> {
  const st = await s2(fx)
  const rec = path.join(st.opDir, 'record.json')
  const body = JSON.parse(fs.readFileSync(rec, 'utf8')) as { pid: number }
  body.pid += 1
  fs.writeFileSync(rec, JSON.stringify(body))
  return st
}

/** From now on, whole-file reads of `target` fail `EIO` (the guard walk's read). */
function unreadableFrom(target: string): void {
  const real = fs.readFileSync
  vi.spyOn(fs, 'readFileSync').mockImplementation(((
    p: fs.PathOrFileDescriptor,
    ...rest: unknown[]
  ) => {
    if (String(p) === target) {
      throw Object.assign(new Error(`EIO: i/o error, read '${target}'`), { code: 'EIO' })
    }
    return (real as (...a: unknown[]) => unknown)(p, ...rest)
  }) as typeof fs.readFileSync)
  syncBuiltinESMExports()
}

const probesIn = (dir: string): string[] =>
  fs.readdirSync(dir).filter((n) => n.startsWith('.skillsmith-probe-'))

describe('the race between the check and the park (bf-1k0 Major 1, C13): a walk that fails late stops with nothing moved', () => {
  const CASES = [
    ['after the re-plan, before the gate hashes', 'bind-failed'],
    ["after the gate, before the port's own walk", 'guard-unreadable'],
  ] as const
  for (const [when, reason] of CASES) {
    it(`${when}: stopped/${reason}, OP at its origin, the root still blocked; a rerun refuses at plan time`, async () => {
      const fx = file()
      const other = otherSkill(fx, 'other-skill', { 'SKILL.md': '# other\n' })
      const st = await corrupt(fx)
      const victim = path.join(st.opDir, 'old', 'SKILL.md')
      const fire = (): void => unreadableFrom(victim)
      const a = await act(
        st,
        'park',
        {},
        reason === 'bind-failed' ? { afterReplan: fire } : { swap: { hooks: { beforePark: fire } } }
      )
      expect(a.result.status).toBe('done')
      if (a.result.status !== 'done') return
      expect(a.result.kept).toEqual([])
      expect(a.result.warnings).toEqual([
        expect.objectContaining({
          code: 'removal-not-done',
          path: st.opDir,
          status: 'stopped',
          reason,
          errno: 'EIO',
        }),
      ])
      // Nothing moved and no tree entry was removed (only the gate's own probes).
      expect(fs.existsSync(path.join(st.opDir, 'record.json'))).toBe(true)
      expect(fs.existsSync(path.join(st.opDir, 'old', 'SKILL.md'))).toBe(true)
      expect(removedBy(a.trace).filter((p) => p.startsWith(st.opDir))).toEqual([])
      expect(
        a.trace.some((t) => t.op === 'park' && (t as { status?: string }).status === 'parked')
      ).toBe(false)
      // The rerun, with the device still failing, refuses at plan time naming the error.
      const again = await planRecovery(requestOf(st, 'park'))
      expect(again).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
      expect(again.status === 'refused' ? again.detail : '').toContain(`${victim} (EIO)`)
      vi.restoreAllMocks()
      syncBuiltinESMExports()
      expect(refusedOf((await attempt(other, opIdN('c'))).result).reason).toBe(
        'recovery-record-unreadable'
      )
    })
  }

  it('the control: the same run with no failure parks OP', async () => {
    const st = await corrupt()
    const a = await act(st, 'park', {}, { afterReplan: () => undefined })
    expect(a.result.status).toBe('done')
    expect(fs.existsSync(st.opDir)).toBe(false)
  })
})

describe("O3b: --park refuses when OP's lstat uid is not the effective uid, before any lock", () => {
  it('another euid: recovery-other-user, no probe, lock 1 never taken; as its owner it runs and takes lock 1', async () => {
    const st = await corrupt()
    const euid = (process.geteuid?.() ?? 0) + 1
    const before = contentSnapshot(st.fx.skillsDir, st.fx.stateRoot)
    locks.n = 0
    // `act` runs the action whenever the plan is offered, so lock 1 is reached exactly then.
    const a = await act(st, 'park', { euid })
    expect(a.result).toMatchObject({ status: 'refused', reason: 'recovery-other-user' })
    expect(a.result.status === 'refused' ? a.result.detail : '').toContain(
      String(process.geteuid?.() ?? 0)
    )
    expect(locks.n).toBe(0)
    expect(contentSnapshot(st.fx.skillsDir, st.fx.stateRoot)).toBe(before)
    expect(probesIn(st.fx.staging)).toEqual([])
    const ok = await act(st, 'park')
    expect(ok.result.status).toBe('done')
    expect(locks.n).toBe(1)
  })
})

describe('O3a: already-parked is report-only for every 6b action; an op dir elsewhere makes it ambiguous', () => {
  for (const action of SIX_B) {
    it(`--${action}: no op dir and a parked copy is already-parked with nothing changed`, async () => {
      const st = await corrupt()
      const parked = path.join(st.fx.staging, '.skillsmith-parked', opIdN('p'))
      fs.mkdirSync(path.join(parked, `${opIdN('p')}-00000000`), { recursive: true })
      const before = contentSnapshot(st.fx.skillsDir, st.fx.stateRoot)
      const r = await planRecovery(requestOf({ fx: st.fx, opId: opIdN('p') }, action))
      expect(r).toMatchObject({
        status: 'refused',
        reason: 'already-parked',
        paths: [fs.realpathSync(parked)],
      })
      expect(contentSnapshot(st.fx.skillsDir, st.fx.stateRoot)).toBe(before)
      // The pair: an op dir of that opId in another scanned root is ambiguous, not parked.
      const fx2 = file()
      await s2(fx2, opIdN('p'))
      const both = await planRecovery(
        requestOf({ fx: st.fx, opId: opIdN('p') }, action, {
          roots: [fs.realpathSync(st.fx.skillsDir), fs.realpathSync(fx2.skillsDir)],
        })
      )
      expect(both).toMatchObject({ status: 'refused', reason: 'recovery-ambiguous' })
    })
  }
})

describe('the empty-target plan is shared by every action (Q1)', () => {
  for (const action of SIX_B) {
    it(`--${action} removes an empty target op dir with one rmdir`, async () => {
      const st = await s2(file())
      const empty = opDirOf(st.fx, opIdN('e'))
      fs.mkdirSync(empty)
      const a = await act({ fx: st.fx, opId: opIdN('e') }, action)
      expect(a.result).toMatchObject({ status: 'done', from: 'empty-op-dir' })
      expect(a.trace.filter((t) => t.op === 'rmdir' && t.path === empty)).toHaveLength(1)
      expect(fs.existsSync(empty)).toBe(false)
      // Only the empty op dir went: the crashed op beside it is untouched.
      expect(fs.existsSync(path.join(st.opDir, 'record.json'))).toBe(true)
    })
  }
})

describe('T-J12 for the 6b actions: the same opId in two roots is ambiguous; --root picks one', () => {
  for (const action of SIX_B) {
    it(`--${action}`, async () => {
      const a = await corrupt()
      const b = await corrupt()
      const roots = [fs.realpathSync(a.fx.skillsDir), fs.realpathSync(b.fx.skillsDir)]
      const r = await planRecovery(requestOf(a, action, { roots }))
      expect(r).toMatchObject({ status: 'refused', reason: 'recovery-ambiguous' })
      expect(r.status === 'refused' ? r.paths.sort() : []).toEqual([a.opDir, b.opDir].sort())
      const picked = await planRecovery(requestOf(a, action, { roots, root: b.fx.skillsDir }))
      if (action === 'park') {
        expect(picked).toMatchObject({ status: 'planned', opDir: b.opDir })
      } else {
        // Targeted to the picked root's op dir, which is unreadable: only --park acts on it.
        expect(picked).toMatchObject({
          status: 'refused',
          reason: 'recovery-not-offered',
          paths: [b.opDir],
        })
        expect(picked.status === 'refused' ? picked.detail : '').toContain('--park is offered')
      }
    })
  }
})

describe('T-X18 (e) under --park: the listed probes are swept, a later one survives', () => {
  it('a probe the plan listed is removed with one rmdir; one made after confirmation stays', async () => {
    const st = await corrupt()
    const listed = path.join(st.fx.staging, `.skillsmith-probe-${opIdN('q')}-1`)
    fs.mkdirSync(listed)
    const late = path.join(st.fx.staging, `.skillsmith-probe-${opIdN('r')}-1`)
    const a = await act(st, 'park', {}, { afterReplan: () => fs.mkdirSync(late) })
    expect(a.result.status).toBe('done')
    if (a.result.status !== 'done') return
    expect(a.result.swept.removed).toContain(listed)
    expect(a.trace.filter((t) => t.op === 'rmdir' && t.path === listed)).toHaveLength(1)
    expect(fs.existsSync(listed)).toBe(false)
    expect(fs.existsSync(late)).toBe(true)
    expect(fs.existsSync(st.opDir)).toBe(false)
  })
})
