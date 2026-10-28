/**
 * SMI-6531 (A1 step 6b-i): `doctor recovery --park <opId>`, the only remedy
 * for `recovery-record-unreadable` (A1 plan §3.9, PLAN:2019; design
 * `step6b-design.md` § 1.1, § 6): T-R2's `--park` half end to end, T-J8, the
 * C3 narrowing, the guardability refusal (bf-1k0 Major 1, case a) and the
 * digest.
 *
 * Every refusal is paired with a positive from the same fixture shape, and
 * every "nothing changed" with a snapshot taken before.
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
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

import type { StatFact } from '../../../../src/services/skill-recovery.types.js'
import { executeRecovery } from '../../../../src/services/skill-recovery.exec.js'
import { planRecovery } from '../../../../src/services/skill-recovery.target.js'
import { refusedOf } from '../skill-swap.abort.helpers.js'
import { hashOf, makeFixture, OP_ID, useTmpCleanup } from '../skill-swap.helpers.js'
import type { Fixture } from '../skill-swap.helpers.js'
import { attempt, opIdN, otherSkill } from '../skill-swap.scan.helpers.js'
import { act, contentSnapshot, removedBy, requestOf } from './recovery.act.helpers.js'
import { opReport, s2 } from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'

useTmpCleanup()

afterEach(() => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
})

const file = () => makeFixture({ 'SKILL.md': '# v1\n' })

/** S2, then its record's bytes no longer match its hash (`hash-mismatch`): unreadable. */
async function corrupt(fx: Fixture = file()): Promise<State> {
  const st = await s2(fx)
  const rec = path.join(st.opDir, 'record.json')
  const body = JSON.parse(fs.readFileSync(rec, 'utf8')) as { pid: number }
  body.pid += 1
  fs.writeFileSync(rec, JSON.stringify(body))
  return st
}

/** `ST/.skillsmith-parked/<opId>/<opId>-<8 hex>`. */
const parkedRe = (fx: Fixture, opId: string): RegExp =>
  new RegExp(
    `^${path.join(fs.realpathSync(fx.staging), '.skillsmith-parked', opId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/${opId}-[0-9a-f]{8}$`
  )

const eio = (p: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`EIO: i/o error, open '${p}'`), { code: 'EIO' })

/** Every open and whole-file read of `target` fails `EIO`: the reader's and the walk's. */
function persistentEio(target: string): void {
  const realOpen = fs.openSync
  const realRead = fs.readFileSync
  vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
    if (String(p) === target) throw eio(target)
    return (realOpen as (...a: unknown[]) => number)(p, ...rest)
  }) as typeof fs.openSync)
  vi.spyOn(fs, 'readFileSync').mockImplementation(((
    p: fs.PathOrFileDescriptor,
    ...rest: unknown[]
  ) => {
    if (String(p) === target) throw eio(target)
    return (realRead as (...a: unknown[]) => unknown)(p, ...rest)
  }) as typeof fs.readFileSync)
  syncBuiltinESMExports()
}

const probesIn = (dir: string): string[] =>
  fs.readdirSync(dir).filter((n) => n.startsWith('.skillsmith-probe-'))

describe('T-R2 (--park half) and bf-1k0 Major 1 case b: --park unblocks the root', () => {
  it('a write refuses before, --park --yes parks OP whole, and the same write then commits', async () => {
    const fx = file()
    const other = otherSkill(fx, 'other-skill', { 'SKILL.md': '# other\n' })
    const st = await corrupt(fx)
    // Before: the control that the root is blocked, asserted in the same run.
    const before = refusedOf((await attempt(other, opIdN('c'))).result)
    expect(before.reason).toBe('recovery-record-unreadable')
    expect(before.detail).toContain(`--park ${OP_ID}`)

    const report = await opReport(st)
    expect(report.cls).toMatchObject({ kind: 'unreadable', why: 'hash-mismatch' })
    const observed = report.cls.kind === 'unreadable' ? report.cls.observed : null
    expect(observed?.hash.ok).toBe(true)
    const planHash = observed !== null && observed.hash.ok ? observed.hash.hash : ''
    const otherBefore = hashOf(other.realDir)

    const a = await act(st, 'park')
    expect(a.result.status).toBe('done')
    if (a.result.status !== 'done') return
    expect(a.result.warnings).toEqual([])
    const kept = a.result.kept
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatchObject({ tree: 'OP', kind: 'unreadable-record' })
    expect(kept[0]!.path).toMatch(parkedRe(fx, OP_ID))
    expect(fs.existsSync(st.opDir)).toBe(false)
    // The parked tree is the one the plan hashed, and its sidecar names the kind.
    expect(hashOf(kept[0]!.path)).toBe(planHash)
    const sidecar = JSON.parse(fs.readFileSync(`${kept[0]!.path}.json`, 'utf8')) as {
      kind: string
      client: string
    }
    // 6b-ii: the swap's owner.json carries O1's attribution, which validates: the park names its client.
    expect(sidecar).toMatchObject({ kind: 'unreadable-record', client: 'claude-code' })
    // ...and indexes in the attributed state root (the fixture's own).
    const index = fs.readFileSync(
      path.join(fs.realpathSync(fx.stateRoot), 'parked-index.jsonl'),
      'utf8'
    )
    expect(index).toContain('"kind":"unreadable-record"')
    // Nothing was removed: the park renamed OP; no tree entry was unlinked or rmdir'd.
    expect(removedBy(a.trace).filter((p) => p.startsWith(st.opDir))).toEqual([])
    expect(a.trace.some((t) => t.op === 'park' && t.path === st.opDir)).toBe(true)
    expect(hashOf(other.realDir)).toBe(otherBefore)
    // T-J8: no quarantine directory is ever made.
    expect(fs.existsSync(path.join(fx.staging, '.quarantine'))).toBe(false)

    // After: the same write commits.
    const after = await attempt(other, opIdN('d'))
    expect(after.result.status).toBe('committed')
  })
})

describe('T-J8: --park refuses a record that verifies, and a park that does not finish leaves the root blocked', () => {
  it('a readable record (a row) refuses --park with zero mutation; the corrupt one beside it is offered', async () => {
    const st = await s2(file())
    const before = contentSnapshot(st.fx.skillsDir, st.fx.stateRoot)
    const a = await act(st, 'park')
    expect(a.result).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
    expect(contentSnapshot(st.fx.skillsDir, st.fx.stateRoot)).toBe(before)
    // The positive: the same shape with its record corrupted is offered.
    const bad = await corrupt()
    expect((await planRecovery(requestOf(bad, 'park'))).status).toBe('planned')
  })

  it('a park forced to kept: done with removal-not-done, OP in place, and writes still refuse', async () => {
    const fx = file()
    const other = otherSkill(fx, 'other-skill', { 'SKILL.md': '# other\n' })
    const st = await corrupt(fx)
    const a = await act(
      st,
      'park',
      {},
      {
        swap: {
          park: async () =>
            ({ status: 'kept', reason: 'op-not-empty', path: null, errno: null }) as never,
        },
      }
    )
    expect(a.result.status).toBe('done')
    if (a.result.status !== 'done') return
    expect(a.result.kept).toEqual([])
    expect(a.result.warnings).toEqual([
      expect.objectContaining({
        code: 'removal-not-done',
        path: st.opDir,
        status: 'kept',
        reason: 'op-not-empty',
      }),
    ])
    expect(fs.existsSync(path.join(st.opDir, 'record.json'))).toBe(true)
    expect(refusedOf((await attempt(other, opIdN('e'))).result).reason).toBe(
      'recovery-record-unreadable'
    )
  })
})

describe('C3: an op dir whose own listing fails is not offered --park', () => {
  it('readdir of OP fails EIO: refused recovery-not-offered naming EIO; the control lists and offers', async () => {
    const st = await corrupt()
    expect((await planRecovery(requestOf(st, 'park'))).status).toBe('planned')
    const realReaddir = fs.readdirSync
    vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p) === st.opDir) throw eio(st.opDir)
      return (realReaddir as (...a: unknown[]) => unknown)(p, ...rest)
    }) as typeof fs.readdirSync)
    syncBuiltinESMExports()
    const r = await planRecovery(requestOf(st, 'park'))
    expect(r).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
    expect(r.status === 'refused' ? r.detail : '').toContain('EIO')
  })
})

describe('bf-1k0 Major 1 case a: an op dir the guard walk cannot read is refused at plan time', () => {
  it('a persistent EIO on record.json refuses, naming EIO and its path; nothing changes, no probe, lock 1 never taken', async () => {
    const st = await corrupt()
    const rec = path.join(st.opDir, 'record.json')
    const before = contentSnapshot(st.fx.skillsDir, st.fx.stateRoot)
    persistentEio(rec)
    locks.n = 0
    // `act` runs the action whenever the plan is offered, so lock 1 is reached exactly then.
    const a = await act(st, 'park')
    const refusedLocks = locks.n
    vi.restoreAllMocks()
    syncBuiltinESMExports()
    expect(a.result).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
    const detail = a.result.status === 'refused' ? a.result.detail : ''
    for (const word of ['EIO', rec, 'guard-unreadable', 'by hand']) expect(detail).toContain(word)
    expect(refusedLocks).toBe(0)
    expect(contentSnapshot(st.fx.skillsDir, st.fx.stateRoot)).toBe(before)
    expect(probesIn(st.fx.staging)).toEqual([])
    // The control: without the EIO the same op dir is offered, and running it takes lock 1.
    locks.n = 0
    const ok = await act(st, 'park')
    expect(ok.result.status).toBe('done')
    expect(locks.n).toBe(1)
  })

  it('an entry whose own lstat fails is refused at plan time naming it and its errno; unmasked, it is offered', async () => {
    const st = await corrupt()
    const old = path.join(st.opDir, 'old')
    const reader = {
      statOverride: (p: string, real: StatFact): StatFact =>
        p === old ? { ok: false, errno: 'EIO' } : real,
    }
    const before = contentSnapshot(st.fx.skillsDir, st.fx.stateRoot)
    locks.n = 0
    const a = await act(st, 'park', { reader })
    expect(a.result).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
    expect(a.result.status === 'refused' ? a.result.detail : '').toContain(
      `${old} could not be inspected (EIO)`
    )
    expect(locks.n).toBe(0)
    expect(contentSnapshot(st.fx.skillsDir, st.fx.stateRoot)).toBe(before)
    expect((await planRecovery(requestOf(st, 'park'))).status).toBe('planned')
  })

  it('a FIFO at record.json refuses, naming guard-unsupported-type; a regular corrupt one is offered', async () => {
    const st = await s2(file())
    const rec = path.join(st.opDir, 'record.json')
    fs.rmSync(rec)
    execFileSync('mkfifo', [rec])
    expect((await opReport(st)).cls).toMatchObject({ kind: 'unreadable', why: 'not-a-file' })
    const before = contentSnapshot(st.fx.skillsDir, st.fx.stateRoot)
    const r = await planRecovery(requestOf(st, 'park'))
    expect(r).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
    const detail = r.status === 'refused' ? r.detail : ''
    expect(detail).toContain('guard-unsupported-type')
    expect(detail).toContain(rec)
    expect(contentSnapshot(st.fx.skillsDir, st.fx.stateRoot)).toBe(before)
    expect(probesIn(st.fx.staging)).toEqual([])
    const ok = await corrupt()
    expect((await planRecovery(requestOf(ok, 'park'))).status).toBe('planned')
  })
})

describe("Q7 (C9): the write path's advice for a record this user may not open", () => {
  it('EACCES on record.json names "run doctor as that user", not --park; a corrupt record names --park', async () => {
    const fx = file()
    const other = otherSkill(fx, 'other-skill', { 'SKILL.md': '# other\n' })
    const st = await corrupt(fx)
    const rec = path.join(st.opDir, 'record.json')
    // The control first: the same root with a readable-but-corrupt record names --park.
    const plain = refusedOf((await attempt(other, opIdN('c'))).result)
    expect(plain.detail).toContain(`--park ${OP_ID}`)
    const promises = fs.promises
    const realOpen = promises.open.bind(promises)
    vi.spyOn(promises, 'open').mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p) === rec) {
        throw Object.assign(new Error(`EACCES: permission denied, open '${rec}'`), {
          code: 'EACCES',
        })
      }
      return (realOpen as (...a: unknown[]) => Promise<fs.promises.FileHandle>)(p, ...rest)
    }) as typeof promises.open)
    syncBuiltinESMExports()
    const denied = refusedOf((await attempt(other, opIdN('d'))).result)
    expect(denied.reason).toBe('recovery-record-unreadable')
    expect(denied.detail).toContain(`${OP_ID} is another user's update`)
    expect(denied.detail).toContain('run `skillsmith doctor recovery` as that user')
    expect(denied.detail).not.toContain('--park')
  })
})

describe('the write path names every kind of blocking record', () => {
  it('a denied record and a moved one, with none to park: both are named, the moved one by id', async () => {
    const fx = file()
    const other = otherSkill(fx, 'other-skill', { 'SKILL.md': '# other\n' })
    const st = await s2(fx)
    // A verified record copied into another op dir is `foreign-op-dir`: moved.
    const moved = opIdN('9')
    fs.mkdirSync(path.join(fx.staging, moved))
    fs.copyFileSync(path.join(st.opDir, 'record.json'), path.join(fx.staging, moved, 'record.json'))
    const rec = path.join(st.opDir, 'record.json')
    const promises = fs.promises
    const realOpen = promises.open.bind(promises)
    vi.spyOn(promises, 'open').mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p) === rec) {
        throw Object.assign(new Error(`EACCES: permission denied, open '${rec}'`), {
          code: 'EACCES',
        })
      }
      return (realOpen as (...a: unknown[]) => Promise<fs.promises.FileHandle>)(p, ...rest)
    }) as typeof promises.open)
    syncBuiltinESMExports()
    const r = refusedOf((await attempt(other, opIdN('d'))).result)
    expect(r.reason).toBe('recovery-record-unreadable')
    expect(r.detail).toContain(`${OP_ID} is another user's update`)
    expect(r.detail).toContain(`Run \`skillsmith doctor recovery\` for ${moved}.`)
    expect(r.detail).not.toContain('--park')
  })
})

describe('the digest covers what --park moves', () => {
  it('a file added inside OP after the plan is plan-changed with zero mutation; unchanged, the same plan parks', async () => {
    const st = await corrupt()
    const planned = await planRecovery(requestOf(st, 'park'))
    expect(planned.status).toBe('planned')
    if (planned.status !== 'planned') return
    fs.writeFileSync(path.join(st.opDir, 'old', 'added.txt'), 'late\n')
    const before = contentSnapshot(st.fx.skillsDir, st.fx.stateRoot)
    const r = await executeRecovery(planned)
    expect(r).toMatchObject({ status: 'refused', reason: 'plan-changed' })
    expect(contentSnapshot(st.fx.skillsDir, st.fx.stateRoot)).toBe(before)
    expect(probesIn(st.fx.staging)).toEqual([])
    // The positive: a fresh plan of the changed op dir parks it.
    const again = await act(st, 'park')
    expect(again.result.status).toBe('done')
    expect(fs.existsSync(st.opDir)).toBe(false)
  })
})
