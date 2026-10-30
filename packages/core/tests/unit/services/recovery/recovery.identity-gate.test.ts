/**
 * SMI-6531 (PR 3213 gate, owner decision 2026-10-29): `--accept-identity` is
 * given with `--apply` or `--undo` only (A1 plan §3.9), and core enforces it.
 * `planRecovery` refuses a request carrying `acceptIdentity: true` with any
 * other action before it lists or classifies a root, with zero mutation; with
 * `--apply` or `--undo` it plans, the waiver applied, and `executeRecovery`
 * performs it, its re-plan classified with the same waiver. `executeRecovery`
 * refuses a plan carrying the flag for another action before binding the root.
 * The public listing (`listRoot`, `listRecovery`) takes no action, so it
 * cannot express the waiver: its options have no such field (a type-level
 * test), and a JS caller passing `acceptIdentity: true` anyway has no effect.
 *
 * The op is identity-changed (its `old/` replaced by a copy of itself), the
 * one class the flag reclassifies, so a missing guard would let `--abandon`,
 * `--park` and `--clean-staging` plan against a class the flag rewrote. The
 * listing and the classifier are counted through pass-through mocks of
 * `listRootWith` (what `planRecovery` lists through) and `classifyOp`, so
 * "nothing was classified" and "planning ran" come from the same counters.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ listRoot: 0, classify: 0 }))
vi.mock('../../../../src/services/skill-recovery.classify.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../src/services/skill-recovery.classify.js')>()
  return {
    ...actual,
    classifyOp: (...a: Parameters<typeof actual.classifyOp>) => {
      calls.classify++
      return actual.classifyOp(...a)
    },
  }
})
vi.mock('../../../../src/services/skill-recovery.listing.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../src/services/skill-recovery.listing.js')>()
  return {
    ...actual,
    listRootWith: (...a: Parameters<typeof actual.listRootWith>) => {
      calls.listRoot++
      return actual.listRootWith(...a)
    },
  }
})

import { executeRecovery } from '../../../../src/services/skill-recovery.exec.js'
import { listRecovery, listRoot } from '../../../../src/services/skill-recovery.listing.js'
import { planRecovery } from '../../../../src/services/skill-recovery.target.js'
import type { RecoveryAction } from '../../../../src/services/skill-recovery.types.js'
import { makeFixture, useTmpCleanup } from '../skill-swap.helpers.js'
import { contentSnapshot, requestOf } from './recovery.act.helpers.js'
import { opReport, s2 } from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'

useTmpCleanup()

beforeEach(() => {
  calls.listRoot = 0
  calls.classify = 0
})

const reset = (): void => {
  calls.listRoot = 0
  calls.classify = 0
}

const world = (st: State): string => contentSnapshot(st.fx.skillsDir, st.fx.stateRoot, st.fx.base)

/** S2 whose `old/` is a copy of itself: the right content, not the folder written. */
async function identityChanged(): Promise<State> {
  const st = await s2(makeFixture({ 'SKILL.md': '# v1\n', 'docs/a.md': 'a\n' }))
  const old = path.join(st.opDir, 'old')
  fs.cpSync(old, `${old}.c`, { recursive: true })
  fs.rmSync(old, { recursive: true })
  fs.renameSync(`${old}.c`, old)
  expect((await opReport(st)).cls.kind).toBe('identity-changed')
  return st
}

/** Written out, not read from core's table: the oracle is independent of it. */
const REFUSED: readonly RecoveryAction[] = ['abandon', 'park', 'clean-staging']
const TAKEN: readonly RecoveryAction[] = ['apply', 'undo']

describe('planRecovery: --accept-identity outside --apply and --undo', () => {
  for (const action of REFUSED) {
    it(`--${action} with acceptIdentity is refused before any root is listed, zero mutation`, async () => {
      const st = await identityChanged()
      reset()
      const before = world(st)
      const r = await planRecovery(requestOf(st, action, { acceptIdentity: true }))
      expect(r).toEqual({
        status: 'refused',
        reason: 'recovery-not-offered',
        detail: `--accept-identity applies only with --apply or --undo, not --${action}`,
        paths: [],
      })
      expect(calls.listRoot).toBe(0)
      expect(calls.classify).toBe(0)
      expect(world(st)).toBe(before)
    })

    it(`the control: --${action} without the flag is listed and classified`, async () => {
      const st = await identityChanged()
      reset()
      const r = await planRecovery(requestOf(st, action))
      expect(calls.listRoot).toBe(1)
      expect(calls.classify).toBe(1)
      if (r.status !== 'planned') expect(r.detail).not.toContain('--accept-identity applies only')
    })
  }

  for (const action of TAKEN) {
    it(`--${action} with acceptIdentity is listed, classified with the waiver, and planned`, async () => {
      const st = await identityChanged()
      reset()
      const before = world(st)
      const r = await planRecovery(requestOf(st, action, { acceptIdentity: true }))
      expect(calls.listRoot).toBe(1)
      expect(calls.classify).toBe(1)
      expect(r).toMatchObject({ status: 'planned', plan: { offered: true, action } })
      if (r.status === 'planned') expect(r.report.cls.kind).toBe('state')
      expect(world(st)).toBe(before)
    })
  }
})

describe('the public listing cannot express the waiver', () => {
  it('acceptIdentity is not an option of listRoot or listRecovery (type level)', async () => {
    const st = await identityChanged()
    const root = fs.realpathSync(st.fx.skillsDir)
    // A regression that re-adds the field leaves these directives unused, which fails typecheck.
    // @ts-expect-error -- the listing takes no action, so it has no acceptIdentity
    const one = await listRoot(root, { acceptIdentity: true })
    // @ts-expect-error -- the listing takes no action, so it has no acceptIdentity
    const all = await listRecovery([root], { acceptIdentity: true })
    expect(one.ops.map((o) => o.cls.kind)).toEqual(['identity-changed'])
    expect(all.flatMap((r) => r.ops.map((o) => o.cls.kind))).toEqual(['identity-changed'])
  })

  it('an untyped acceptIdentity: true has no effect: the op stays identity-changed', async () => {
    const st = await identityChanged()
    const root = fs.realpathSync(st.fx.skillsDir)
    reset()
    const before = world(st)
    const one = await listRoot(root, { acceptIdentity: true } as never)
    const [all] = await listRecovery([root], { acceptIdentity: true } as never)
    expect(calls.classify).toBe(2)
    expect(one.ops.map((o) => o.cls.kind)).toEqual(['identity-changed'])
    expect(all?.ops.map((o) => o.cls.kind)).toEqual(['identity-changed'])
    expect(world(st)).toBe(before)
  })

  it('the control: without the flag the same root is listed and its op classified', async () => {
    const st = await identityChanged()
    reset()
    const [r] = await listRecovery([fs.realpathSync(st.fx.skillsDir)])
    expect(calls.classify).toBe(1)
    expect(r?.ops.map((o) => o.cls.kind)).toEqual(['identity-changed'])
  })
})

describe('executeRecovery: --apply and --undo with --accept-identity re-plan with the waiver', () => {
  for (const action of TAKEN) {
    it(`--${action}: the re-plan under lock classifies with the waiver, and the plan is performed`, async () => {
      const st = await identityChanged()
      const planned = await planRecovery(requestOf(st, action, { acceptIdentity: true }))
      if (planned.status !== 'planned') throw new Error(`not planned: ${JSON.stringify(planned)}`)
      reset()
      const r = await executeRecovery(planned)
      // Without the waiver the re-plan is identity-changed and its digest differs: plan-changed.
      expect(r, JSON.stringify(r)).toMatchObject({ status: 'done', action })
      expect(calls.classify).toBe(1)
    })
  }
})

describe('executeRecovery: a plan carrying --accept-identity outside --apply and --undo', () => {
  /** `--abandon`'s plan for the identity-changed op (offered there without the flag). */
  async function abandonPlan(st: State) {
    const planned = await planRecovery(requestOf(st, 'abandon'))
    if (planned.status !== 'planned') throw new Error(`not planned: ${JSON.stringify(planned)}`)
    return planned
  }

  it('is refused before the root is bound or locked, zero mutation', async () => {
    const st = await identityChanged()
    const planned = await abandonPlan(st)
    const forged = { ...planned, request: { ...planned.request, acceptIdentity: true } }
    reset()
    const before = world(st)
    const r = await executeRecovery(forged)
    expect(r).toEqual({
      status: 'refused',
      reason: 'recovery-not-offered',
      detail: '--accept-identity applies only with --apply or --undo, not --abandon',
      paths: [planned.opDir],
    })
    // The re-plan under lock 1 classifies the op: none ran.
    expect(calls.classify).toBe(0)
    expect(world(st)).toBe(before)
  })

  it('the control: the same plan without the flag is re-planned under lock and performed', async () => {
    const st = await identityChanged()
    const planned = await abandonPlan(st)
    reset()
    const r = await executeRecovery(planned)
    expect(calls.classify).toBe(1)
    expect(r.status).toBe('done')
    expect(fs.existsSync(st.opDir)).toBe(false)
  })
})
