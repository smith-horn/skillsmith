/**
 * SMI-6531 (#3209 retro): a refusal's detail names another action only when
 * that action is offered for the same class, names every action that is, and
 * says so when none is (owner decision 2026-10-29: `--unsafe-unverified-owner`
 * is computed; `--accept-identity` is named by a fixed clause, not computed).
 *
 * Every property runs over every fixture (`recovery.plan.fixtures.ts`, built
 * through the real classifier) and every action it refuses, through the public
 * `planAction` only. The hint's words are written out here, not imported, so a
 * change to them fails these tests.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { planAction, RECOVERY_ACTIONS } from '../../../../src/services/skill-recovery.plan.js'
import type {
  RecoveryAction,
  RecoveryClass,
} from '../../../../src/services/skill-recovery.types.js'
import { useTmpCleanup } from '../skill-swap.helpers.js'
import { useOtherDeviceCleanup } from '../skill-swap.xdev.helpers.js'
import { allFixtures } from './recovery.plan.fixtures.js'
import type { PlanFixture } from './recovery.plan.fixtures.js'

useTmpCleanup()
useOtherDeviceCleanup()

const OFFERED = 'offered here: '
const UNSAFE =
  'with --unsafe-unverified-owner (only if you are sure no update is still using this op dir): '
const NONE = 'no other action is offered here'
const IDENTITY =
  "add --accept-identity to the action you want to run: it waives the identity check, and that action's plan is printed before any change"
const UNSAFE_OPT = { unsafeUnverifiedOwner: true }

const ACTION_TOKEN = /--(apply|undo|abandon|clean-staging|park)\b/g
const ANY_FLAG = /--[a-z][a-z-]*/g

const tokensIn = (s: string): RecoveryAction[] =>
  [...s.matchAll(ACTION_TOKEN)].map((m) => m[1] as RecoveryAction)

interface Parsed {
  /** The detail with the hint stripped from its end. */
  base: string
  /** The actions the hint says are offered here. */
  offered: RecoveryAction[]
  /** The actions the hint says are offered with `--unsafe-unverified-owner`. */
  unsafe: RecoveryAction[]
  none: boolean
  identity: boolean
}

/**
 * The hint is a suffix of `; `-separated segments: an optional "offered here"
 * segment, then an optional unsafe-owner segment, or else the "no other
 * action" segment; then, for identity-changed, the identity clause. Parsed
 * from the end, so a base that repeats a hint segment is left in the base.
 */
function parse(detail: string): Parsed {
  const seg = detail.split('; ')
  const out: Parsed = { base: '', offered: [], unsafe: [], none: false, identity: false }
  if (seg.length > 1 && seg.at(-1) === IDENTITY) {
    out.identity = true
    seg.pop()
  }
  const last = (): string => (seg.length > 1 ? (seg.at(-1) ?? '') : '')
  let any = false
  if (last().startsWith(UNSAFE)) {
    out.unsafe = tokensIn(seg.pop()!.slice(UNSAFE.length))
    any = true
  }
  if (last().startsWith(OFFERED)) {
    out.offered = tokensIn(seg.pop()!.slice(OFFERED.length))
    any = true
  }
  if (!any && last() === NONE) {
    seg.pop()
    out.none = true
  }
  out.base = seg.join('; ')
  return out
}

const offeredPlain = (cls: RecoveryClass, a: RecoveryAction) => planAction(cls, a).offered
const offeredUnsafe = (cls: RecoveryClass, a: RecoveryAction) =>
  planAction(cls, a, UNSAFE_OPT).offered

/** Every (fixture, refused action, detail) the listing would show. */
function refusals(fixtures: PlanFixture[]) {
  const out: Array<{ f: PlanFixture; a: RecoveryAction; detail: string; p: Parsed }> = []
  for (const f of fixtures) {
    for (const a of RECOVERY_ACTIONS) {
      const plan = planAction(f.cls, a)
      if (!plan.offered) out.push({ f, a, detail: plan.detail, p: parse(plan.detail) })
    }
  }
  return out
}

let fixtures: PlanFixture[] = []

beforeAll(async () => {
  fixtures = await allFixtures()
}, 120_000)

describe('derived refusal hints: every fixture, every refused action', () => {
  it('P1: every action a refusal names is offered (under the unsafe-owner clause: only with it)', () => {
    const bad: string[] = []
    for (const { f, a, detail, p } of refusals(fixtures)) {
      const named = [...tokensIn(p.base).filter((t) => t !== a), ...p.offered]
      for (const t of named) {
        if (!offeredPlain(f.cls, t)) {
          bad.push(`${f.name} | --${a} | names --${t}, which is refused | ${detail}`)
        }
      }
      for (const t of p.unsafe) {
        if (offeredPlain(f.cls, t) || !offeredUnsafe(f.cls, t)) {
          bad.push(`${f.name} | --${a} | names --${t} under the unsafe-owner clause | ${detail}`)
        }
      }
    }
    expect(bad).toEqual([])
  })

  it('P2: every other offered action is named; the unsafe-only ones under the clause; nothing offered says so; identity only for identity-changed', () => {
    const bad: string[] = []
    for (const { f, a, detail, p } of refusals(fixtures)) {
      const others = RECOVERY_ACTIONS.filter((x) => x !== a && offeredPlain(f.cls, x))
      const unsafeOnly = RECOVERY_ACTIONS.filter(
        (x) => !offeredPlain(f.cls, x) && offeredUnsafe(f.cls, x)
      )
      for (const x of others) {
        if (!p.offered.includes(x)) bad.push(`${f.name} | --${a} | omits --${x} | ${detail}`)
      }
      for (const x of unsafeOnly) {
        if (!p.unsafe.includes(x)) {
          bad.push(`${f.name} | --${a} | omits --${x} from the unsafe-owner clause | ${detail}`)
        }
      }
      if (others.length === 0 && unsafeOnly.length === 0 && !p.none) {
        bad.push(`${f.name} | --${a} | does not say "${NONE}" | ${detail}`)
      }
      if (p.identity !== (f.kind === 'identity-changed')) {
        bad.push(
          `${f.name} | --${a} | identity clause ${p.identity ? 'present' : 'missing'} | ${detail}`
        )
      }
    }
    expect(bad).toEqual([])
  })

  it('P3: with the hint stripped, the detail names no other action and no flag', () => {
    const bad: string[] = []
    for (const { f, a, detail, p } of refusals(fixtures)) {
      const flags = (p.base.match(ANY_FLAG) ?? []).filter((t) => t !== `--${a}`)
      if (flags.length > 0) {
        bad.push(`${f.name} | --${a} | base names ${flags.join(', ')} | ${detail}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('is not vacuous: each action offered and refused somewhere; an unsafe-only offer; a fixture offering nothing', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(35)
    for (const a of RECOVERY_ACTIONS) {
      expect(
        fixtures.some((f) => offeredPlain(f.cls, a)),
        `--${a} offered somewhere`
      ).toBe(true)
      expect(
        fixtures.some((f) => !offeredPlain(f.cls, a)),
        `--${a} refused somewhere`
      ).toBe(true)
    }
    const unsafeOnly = fixtures.filter((f) =>
      RECOVERY_ACTIONS.some((a) => !offeredPlain(f.cls, a) && offeredUnsafe(f.cls, a))
    )
    expect(unsafeOnly.map((f) => f.name)).toContain('no-record, owner alive')
    const nothing = fixtures.filter((f) =>
      RECOVERY_ACTIONS.every((a) => !offeredPlain(f.cls, a) && !offeredUnsafe(f.cls, a))
    )
    expect(nothing.length).toBeGreaterThan(0)
    expect(refusals(fixtures).length).toBeGreaterThan(100)
  })
})
