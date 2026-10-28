/**
 * SMI-6531 (A1 step 6b-ii): `doctor recovery --clean-staging` on one device
 * (A1 plan §3.9, PLAN:2018; design `step6b-design.md` § 1.2, § 6): T-J7, the
 * owner verdict, the owner-last order (a kill after each metadata unlink,
 * rerun without the flag), O2's refusals, C2, and T-X15's tail.
 *
 * Every state is one a real update left (`recovery.clean.helpers.ts`). Each
 * refusal asserts zero mutation (a content snapshot of the skills root, the
 * state root and the temp home) beside a positive that proves the same setup
 * acts; each "only metadata removed" assertion is paired with the exact list
 * of what was removed in the same run.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultOwnerProbe } from '../../../../src/services/skill-recovery.owner.js'
import { executeRecovery } from '../../../../src/services/skill-recovery.exec.js'
import { planAction } from '../../../../src/services/skill-recovery.plan.js'
import { planRecovery } from '../../../../src/services/skill-recovery.target.js'
import { contentOf } from '../skill-swap.abort.helpers.js'
import { areaOf, hashOf, OP_ID, useTmpCleanup } from '../skill-swap.helpers.js'
import { attempt, opIdN } from '../skill-swap.scan.helpers.js'
import { act, contentSnapshot, done, killAt, removedBy, requestOf } from './recovery.act.helpers.js'
import { opReport } from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'
import {
  abortLeft,
  ALIVE,
  dead,
  DEAD,
  EDIT,
  editOwner,
  keptAt,
  opNames,
  sidecarAt,
} from './recovery.clean.helpers.js'

useTmpCleanup()

const world = (st: State): string => contentSnapshot(st.fx.skillsDir, st.fx.stateRoot, st.fx.base)
const owner = (st: State): string => path.join(st.opDir, 'owner.json')

/** Plans `--clean-staging` with `over`; requires a refusal with `reason` naming `words`, nothing changed. */
async function refusedWith(
  st: State,
  over: Parameters<typeof act>[2],
  reason: string,
  ...words: string[]
): Promise<void> {
  const before = world(st)
  const a = await act(st, 'clean-staging', over)
  expect(a.result).toMatchObject({ status: 'refused', reason })
  const detail = a.result.status === 'refused' ? a.result.detail : ''
  for (const w of words) expect(detail).toContain(w)
  expect(a.trace).toEqual([])
  expect(world(st)).toBe(before)
}

describe('T-J7: an op dir left before the update began (owner.json and new/, no record)', () => {
  it('blocks nothing: a later update of the same skill commits', async () => {
    const st = await abortLeft('abortAfterCheck')
    expect(opNames(st)).toEqual(['new', 'owner.json'])
    const later = await attempt(st.fx, opIdN('c'))
    expect(later.result.status).toBe('committed')
    // The left op dir is still there, untouched: it blocked nothing and nothing touched it.
    expect(opNames(st)).toEqual(['new', 'owner.json'])
  })

  for (const editN of [false, true]) {
    it(`a same-host dead owner: new/ kept as unrecorded-new${editN ? ' with its edit' : ''}; only owner.json and the op dir removed`, async () => {
      const st = await abortLeft('abortAfterCheck', { editN })
      const n = path.join(st.opDir, 'new')
      const want = contentOf(n)
      const nHash = hashOf(n)
      const t = contentOf(st.fx.realDir)
      const a = await done(st, 'clean-staging', dead)
      const dest = keptAt(st.fx, 'unrecorded-new')
      expect(a.result.kept).toEqual([{ tree: 'N', kind: 'unrecorded-new', path: dest }])
      expect(contentOf(dest)).toEqual(want)
      expect(hashOf(dest)).toBe(nHash)
      if (editN) expect(contentOf(dest)['a.txt']).toContain(EDIT)
      expect(sidecarAt(dest)).toMatchObject({
        opId: OP_ID,
        kind: 'unrecorded-new',
        treeHash: nHash,
      })
      // Exactly the metadata (the keep's own sidecar temp, owner.json) and the emptied op dir
      // were removed: the presence half of "no tree was removed".
      expect(removedBy(a.trace)).toEqual([`${dest}.json.tmp`, owner(st), st.opDir])
      expect(fs.existsSync(st.opDir)).toBe(false)
      expect(contentOf(st.fx.realDir)).toEqual(t)
      expect(a.result.manifest).toBe('untouched')
      expect(a.result.warnings).toEqual([])
    })
  }

  it('a same-host owner still running (the real probe: this process): refused, nothing changed; the flag acts', async () => {
    const st = await abortLeft('abortAfterCheck')
    await refusedWith(
      st,
      {},
      'recovery-not-offered',
      'same-host-alive',
      '--unsafe-unverified-owner'
    )
    const a = await done(st, 'clean-staging', { unsafeUnverifiedOwner: true })
    expect(a.result.kept.map((k) => k.kind)).toEqual(['unrecorded-new'])
    expect(a.planned.status === 'planned' ? a.planned.plan.notes.join('\n') : '').toContain(
      '--unsafe-unverified-owner'
    )
  })
})

describe('the owner verdict', () => {
  const cases: Array<[string, (st: State) => void, string]> = [
    ['another host', (st) => editOwner(st, { host: 'elsewhere.example' }), 'other-host'],
    ['an unparseable owner.json', (st) => fs.writeFileSync(owner(st), '{ not json'), 'unparseable'],
    ['a pid that is not a positive integer', (st) => editOwner(st, { pid: -1 }), 'unparseable'],
    ['no owner.json', (st) => fs.rmSync(owner(st)), 'absent'],
  ]
  for (const [label, arrange, verdict] of cases) {
    it(`${label}: ${verdict}, refused without the flag; with it, acts`, async () => {
      const st = await abortLeft('abortAfterCheck')
      arrange(st)
      const cls = (await opReport(st, { ownerProbe: DEAD })).cls
      expect(cls).toMatchObject({ kind: 'no-record', clean: { verdict } })
      await refusedWith(st, dead, 'recovery-not-offered', verdict, '--unsafe-unverified-owner')
      const a = await done(st, 'clean-staging', { ...dead, unsafeUnverifiedOwner: true })
      expect(a.result.kept.map((k) => k.kind)).toEqual(['unrecorded-new'])
    })
  }

  it('EPERM from kill(pid, 0) counts as alive; ESRCH is dead (the shared probePidAlive)', async () => {
    const st = await abortLeft('abortAfterCheck')
    const throwing = (code: string) =>
      (() => {
        throw Object.assign(new Error(code), { code })
      }) as unknown as typeof process.kill
    const eperm = defaultOwnerProbe(throwing('EPERM'))
    const esrch = defaultOwnerProbe(throwing('ESRCH'))
    expect((await opReport(st, { ownerProbe: eperm })).cls).toMatchObject({
      clean: { verdict: 'same-host-alive' },
    })
    await refusedWith(st, { ownerProbe: eperm }, 'recovery-not-offered', 'same-host-alive')
    // The positive: the same op dir with ESRCH is offered, and acts.
    const a = await done(st, 'clean-staging', { ownerProbe: esrch })
    expect(a.result.kept.map((k) => k.kind)).toEqual(['unrecorded-new'])
  })

  it('is in the digest: a pid that dies between the plan and the lock is plan-changed, nothing changed', async () => {
    const st = await abortLeft('abortAfterCheck')
    let alive = true
    const probe = { host: os.hostname(), alive: () => alive }
    const req = requestOf(st, 'clean-staging', { ownerProbe: probe, unsafeUnverifiedOwner: true })
    const planned = await planRecovery(req)
    expect(planned.status).toBe('planned')
    if (planned.status !== 'planned') return
    alive = false
    const before = world(st)
    const r = await executeRecovery(planned)
    expect(r).toMatchObject({ status: 'refused', reason: 'plan-changed' })
    expect(world(st)).toBe(before)
    // The control: the same plan, with the verdict unchanged, acts.
    alive = true
    const again = await executeRecovery(planned)
    expect(again.status).toBe('done')
  })
})

describe('owner.json is unlinked last: a kill after each metadata unlink, rerun without the flag', () => {
  /** The left op dir plus a provable record.json.tmp (an empty file with one link: a kill in step 5). */
  async function withTemp(): Promise<State> {
    const st = await abortLeft('abortAfterCheck')
    fs.writeFileSync(path.join(st.opDir, 'record.json.tmp'), '')
    return st
  }

  it('the order: the temp, sync OP, owner.json, sync OP, rmdir OP, sync ST', async () => {
    const st = await withTemp()
    const a = await done(st, 'clean-staging', dead)
    const tmpFile = path.join(st.opDir, 'record.json.tmp')
    const at = (pred: (t: (typeof a.trace)[number]) => boolean, from = 0): number =>
      a.trace.findIndex((t, i) => i >= from && pred(t))
    const u1 = at((t) => t.op === 'unlink' && t.path === tmpFile)
    const s1 = at((t) => t.op === 'dirsync' && t.path === st.opDir, u1)
    const u2 = at((t) => t.op === 'unlink' && t.path === owner(st), s1)
    const s2 = at((t) => t.op === 'dirsync' && t.path === st.opDir, u2)
    const r = at((t) => t.op === 'rmdir' && t.path === st.opDir, s2)
    const s3 = at((t) => t.op === 'dirsync' && t.path === st.fx.staging, r)
    expect([u1, s1, u2, s2, r, s3].every((i) => i > -1)).toBe(true)
    const sidecarTmp = `${keptAt(st.fx, 'unrecorded-new')}.json.tmp`
    expect(removedBy(a.trace)).toEqual([sidecarTmp, tmpFile, owner(st), st.opDir])
  })

  it('killed after the temp went: OP holds owner.json alone, and the same command finishes it', async () => {
    const st = await withTemp()
    const first = await act(st, 'clean-staging', dead, killAt('afterTempUnlink'))
    expect(first.result.status).toBe('stopped')
    expect(opNames(st)).toEqual(['owner.json'])
    const again = await done(st, 'clean-staging', dead)
    expect(again.result.kept).toEqual([])
    expect(fs.existsSync(st.opDir)).toBe(false)
    expect(fs.existsSync(keptAt(st.fx, 'unrecorded-new'))).toBe(true)
  })

  it('killed after owner.json went: an empty op dir, which the same command removes', async () => {
    const st = await withTemp()
    const first = await act(st, 'clean-staging', dead, killAt('afterOwnerUnlink'))
    expect(first.result.status).toBe('stopped')
    expect(opNames(st)).toEqual([])
    const again = await done(st, 'clean-staging', { ownerProbe: ALIVE })
    expect(again.result.swept.removed).toEqual([st.opDir])
    expect(fs.existsSync(st.opDir)).toBe(false)
  })
})

describe('O2: an entry doctor cannot prove it wrote refuses, naming it, with zero mutation', () => {
  const cases: Array<[string, (st: State) => string]> = [
    [
      'a partly written record.json.tmp',
      (st) => {
        fs.writeFileSync(path.join(st.opDir, 'record.json.tmp'), '{"schema":1,"op":"upd')
        return 'record.json.tmp'
      },
    ],
    [
      "a park-intent.json.tmp that is not this op's",
      (st) => {
        fs.writeFileSync(path.join(st.opDir, 'park-intent.json.tmp'), '{"kind":"abort-new"}')
        return 'park-intent.json.tmp'
      },
    ],
    [
      'a park-intent.json that does not verify',
      (st) => {
        fs.writeFileSync(path.join(st.opDir, 'park-intent.json'), '{"schema":3}')
        return 'park-intent.json'
      },
    ],
    [
      'a non-directory at old',
      (st) => {
        fs.writeFileSync(path.join(st.opDir, 'old'), 'not a folder\n')
        return 'old'
      },
    ],
    [
      'an old/ folder with no record',
      (st) => {
        fs.mkdirSync(path.join(st.opDir, 'old'))
        return 'old'
      },
    ],
    [
      'a stray file',
      (st) => {
        fs.writeFileSync(path.join(st.opDir, 'stray.txt'), 'stray\n')
        return 'stray.txt'
      },
    ],
  ]
  for (const [label, plant] of cases) {
    it(`${label}: refused with and without the flag; move it out by hand`, async () => {
      const st = await abortLeft('abortAfterCheck')
      const name = plant(st)
      const where = path.join(st.opDir, name)
      await refusedWith(st, dead, 'recovery-not-offered', where, 'by hand')
      await refusedWith(st, { ...dead, unsafeUnverifiedOwner: true }, 'recovery-not-offered', where)
      // The positive: moved out by hand, the same command acts.
      fs.renameSync(where, path.join(st.fx.base, `${name}.aside`))
      const a = await done(st, 'clean-staging', dead)
      expect(a.result.kept.map((k) => k.kind)).toEqual(['unrecorded-new'])
    })
  }

  it('a provable temp (empty, one link) is not refused: it is adopted and unlinked', async () => {
    const st = await abortLeft('abortAfterCheck')
    fs.writeFileSync(path.join(st.opDir, 'park-intent.json.tmp'), '')
    const a = await done(st, 'clean-staging', dead)
    expect(removedBy(a.trace)).toContain(path.join(st.opDir, 'park-intent.json.tmp'))
  })
})

describe('C2: a verifying abort-new intent wins over a fresh keep', () => {
  it('plans the intent park, not unrecorded-new keeps; and the run parks OP with N and the intent', async () => {
    const st = await abortLeft('afterIntent')
    expect(opNames(st)).toEqual(['new', 'owner.json', 'park-intent.json'])
    const cls = (await opReport(st, { ownerProbe: DEAD })).cls
    const plan = planAction(cls, 'clean-staging')
    expect(plan.offered).toBe(true)
    if (!plan.offered) return
    expect(plan.steps.map((s) => s.disposition)).toEqual([{ kind: 'kept', as: 'abort-new' }])
    expect(JSON.stringify(plan.steps)).not.toContain('unrecorded-new')
    const a = await done(st, 'clean-staging', dead)
    expect(a.result.kept).toMatchObject([{ tree: 'OP', kind: 'abort-new' }])
    expect(fs.existsSync(areaOf(st.fx))).toBe(false)
  })
})

describe('T-X18 (e) and T-J12 under --clean-staging', () => {
  it('a probe the plan listed is removed with one rmdir; one made after confirmation stays', async () => {
    const st = await abortLeft('abortAfterCheck')
    const listed = path.join(st.fx.staging, `.skillsmith-probe-${opIdN('q')}-1`)
    fs.mkdirSync(listed)
    const late = path.join(st.fx.staging, `.skillsmith-probe-${opIdN('r')}-1`)
    const a = await act(st, 'clean-staging', dead, { afterReplan: () => fs.mkdirSync(late) })
    expect(a.result.status).toBe('done')
    if (a.result.status !== 'done') return
    expect(a.result.swept.removed).toEqual([listed])
    expect(a.trace.filter((t) => t.op === 'rmdir' && t.path === listed)).toHaveLength(1)
    expect(fs.existsSync(late)).toBe(true)
    expect(fs.existsSync(st.opDir)).toBe(false)
  })

  it('the same opId in two roots is recovery-ambiguous; --root picks one, which is planned', async () => {
    const a = await abortLeft('abortAfterCheck')
    const b = await abortLeft('abortAfterCheck')
    const roots = [fs.realpathSync(a.fx.skillsDir), fs.realpathSync(b.fx.skillsDir)]
    const stateRoots = [fs.realpathSync(a.fx.stateRoot), fs.realpathSync(b.fx.stateRoot)]
    const both = await planRecovery(requestOf(a, 'clean-staging', { ...dead, roots, stateRoots }))
    expect(both).toMatchObject({ status: 'refused', reason: 'recovery-ambiguous' })
    const picked = await planRecovery(
      requestOf(a, 'clean-staging', { ...dead, roots, stateRoots, root: b.fx.skillsDir })
    )
    expect(picked).toMatchObject({ status: 'planned', opDir: b.opDir })
  })
})

describe('T-X15 (busy-twice tail): the left op dir is kept with its edit', () => {
  it('N, edited after the build, is kept as unrecorded-new with the edit; nothing else changes', async () => {
    const st = await abortLeft('abortAfterCompare', { editN: true })
    const a = await done(st, 'clean-staging', dead)
    const dest = keptAt(st.fx, 'unrecorded-new')
    expect(a.result.kept).toEqual([{ tree: 'N', kind: 'unrecorded-new', path: dest }])
    expect(contentOf(dest)['a.txt']).toBe(`a\n${EDIT}`)
    expect(removedBy(a.trace)).toEqual([`${dest}.json.tmp`, owner(st), st.opDir])
  })
})
