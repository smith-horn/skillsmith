/**
 * SMI-6531 (#3209 retro): a refusal's detail names another action only when
 * that action is offered for the same class, names every action that is, and
 * says so when none is (owner decision 2026-10-29: `--unsafe-unverified-owner`
 * is computed; `--accept-identity` is named by a fixed clause, not computed,
 * and only on a refusal of `--apply` or `--undo`, the only actions it applies
 * to: the CLI and `planRecovery` refuse it with any other).
 *
 * Every property runs over every fixture (`recovery.plan.fixtures.ts`, built
 * through the real classifier) and every action it refuses, through the public
 * `planAction` only. The hint's words are written out here, not imported, so a
 * change to them fails these tests.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import {
  ACCEPT_IDENTITY_ACTIONS,
  acceptsIdentity,
  planAction,
  RECOVERY_ACTIONS,
} from '../../../../src/services/skill-recovery.plan.js'
import type {
  ActionPlan,
  PlanOptions,
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
const UNSAFE_CLAUSE =
  'with --unsafe-unverified-owner (only if you are sure no update is still using this op dir)'
const UNSAFE = `${UNSAFE_CLAUSE}: `
const NONE = 'no other action is offered here'
const IDENTITY =
  'with --accept-identity this action waives the identity check, and its plan is printed before any change'
const UNSAFE_OPT: PlanOptions = { unsafeUnverifiedOwner: true }
/** A refusal no flag gets past: another uid's op dir. */
const isOtherUser = (plan: ActionPlan): boolean =>
  !plan.offered && plan.reason === 'recovery-other-user'

/** The actions `--accept-identity` is accepted with (`doctor recovery`'s option). */
const IDENTITY_ACTIONS: readonly RecoveryAction[] = ['apply', 'undo']

/** Words only the hint may say: a base that says one is pretending to be a hint. */
const HINT_PHRASES = ['offered here:', NONE, UNSAFE_CLAUSE, IDENTITY]
/** The two flags the hint names: a base names neither. */
const HINT_FLAGS = ['--accept-identity', '--unsafe-unverified-owner']

const ACTION_TOKEN = /--(apply|undo|abandon|clean-staging|park)\b/g
const ONE_ACTION = /^--(apply|undo|abandon|clean-staging|park)$/

const tokensIn = (s: string): RecoveryAction[] =>
  [...s.matchAll(ACTION_TOKEN)].map((m) => m[1] as RecoveryAction)

/**
 * A hint segment's action list: `--a or --b`, action tokens and the ` or `
 * separator only, each action once, in `RECOVERY_ACTIONS` order. Null when
 * the list is anything else.
 */
function actionList(s: string): RecoveryAction[] | null {
  const out: RecoveryAction[] = []
  for (const part of s.split(' or ')) {
    const m = ONE_ACTION.exec(part)
    if (m === null) return null
    out.push(m[1] as RecoveryAction)
  }
  const inOrder = RECOVERY_ACTIONS.filter((a) => out.includes(a))
  return inOrder.length === out.length && inOrder.every((a, i) => a === out[i]) ? out : null
}

interface Parsed {
  /** The detail with the hint stripped from its end. */
  base: string
  /** The actions the hint says are offered here. */
  offered: RecoveryAction[]
  /** The actions the hint says are offered with `--unsafe-unverified-owner`. */
  unsafe: RecoveryAction[]
  none: boolean
  identity: boolean
  /** Hint segments that are not exactly a hint's shape (and a refusal with no hint). */
  malformed: string[]
}

/**
 * The hint is a suffix of `; `-separated segments: an optional "offered here"
 * segment, then an optional unsafe-owner segment, or else the "no other
 * action" segment; then, for a refusal of `--apply` or `--undo` of an
 * identity-changed class, the identity clause, exactly. Parsed from the end:
 * a segment out of that order stays in the base, where P3 finds it.
 */
function parse(detail: string): Parsed {
  const seg = detail.split('; ')
  const out: Parsed = {
    base: '',
    offered: [],
    unsafe: [],
    none: false,
    identity: false,
    malformed: [],
  }
  // The base is never empty: at least one segment stays.
  const last = (): string | null => (seg.length > 1 ? (seg.at(-1) ?? null) : null)
  const list = (prefix: string, into: 'offered' | 'unsafe'): void => {
    const s = seg.pop() ?? ''
    const actions = actionList(s.slice(prefix.length))
    if (actions === null) out.malformed.push(s)
    else out[into] = actions
  }
  if (last() === IDENTITY) {
    out.identity = true
    seg.pop()
  }
  if (last()?.startsWith(UNSAFE) === true) list(UNSAFE, 'unsafe')
  if (last()?.startsWith(OFFERED) === true) list(OFFERED, 'offered')
  const listed = out.offered.length > 0 || out.unsafe.length > 0 || out.malformed.length > 0
  if (!listed && last() === NONE) {
    seg.pop()
    out.none = true
  }
  if (!listed && !out.none) out.malformed.push('(no hint)')
  out.base = seg.join('; ')
  return out
}

const offeredWith = (cls: RecoveryClass, a: RecoveryAction, opts: PlanOptions = {}): boolean =>
  planAction(cls, a, opts).offered
const offeredPlain = (cls: RecoveryClass, a: RecoveryAction) => offeredWith(cls, a)
const offeredUnsafe = (cls: RecoveryClass, a: RecoveryAction) => offeredWith(cls, a, UNSAFE_OPT)

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

/** The detail of `a`'s refusal for the fixture named `name` (throws when it is offered). */
function refusalOf(fixtures: PlanFixture[], name: string, a: RecoveryAction): string {
  const f = fixtures.find((x) => x.name === name)
  if (f === undefined) throw new Error(`no fixture ${name}`)
  const plan = planAction(f.cls, a)
  if (plan.offered) throw new Error(`${name}: --${a} is offered`)
  return plan.detail
}

/** The words an offered plan says beside its steps' dispositions: its notes, step notes and what is left. */
const wordsOf = (plan: Extract<ActionPlan, { offered: true }>): string[] => [
  ...plan.notes,
  ...plan.steps.map((s) => s.note),
  ...plan.remaining,
]

let fixtures: PlanFixture[] = []

beforeAll(async () => {
  fixtures = await allFixtures()
}, 120_000)

describe('the action tables the properties iterate, written out', () => {
  // Every property below iterates `RECOVERY_ACTIONS`, so an action dropped from
  // it would shrink the suite silently: these literals are the independent oracle.
  it('RECOVERY_ACTIONS is exactly the five actions, in listing order', () => {
    expect(RECOVERY_ACTIONS).toEqual(['apply', 'undo', 'abandon', 'clean-staging', 'park'])
  })

  it('ACCEPT_IDENTITY_ACTIONS is exactly --apply and --undo, and acceptsIdentity agrees', () => {
    expect(ACCEPT_IDENTITY_ACTIONS).toEqual(['apply', 'undo'])
    expect(IDENTITY_ACTIONS).toEqual(['apply', 'undo'])
    const literal: RecoveryAction[] = ['apply', 'undo', 'abandon', 'clean-staging', 'park']
    expect(literal.filter(acceptsIdentity)).toEqual(['apply', 'undo'])
  })
})

describe('derived refusal hints: every fixture, every refused action', () => {
  it('the properties run over the seam-built C3 and other-user fixtures, beside the two literals', () => {
    const kinds = new Map(fixtures.map((f) => [f.name, f.kind]))
    expect(
      Object.fromEntries(
        [
          'unreadable (C3: the op dir cannot be inspected, through the seam)',
          'unreadable (C3: the op dir cannot be listed, through the seam)',
          'unreadable (C3: the op dir cannot be listed)',
          'other-user (EACCES on the op dir, through the seam)',
          'other-user (EACCES)',
        ].map((n) => [n, kinds.get(n)])
      )
    ).toEqual({
      'unreadable (C3: the op dir cannot be inspected, through the seam)': 'unreadable',
      'unreadable (C3: the op dir cannot be listed, through the seam)': 'unreadable',
      'unreadable (C3: the op dir cannot be listed)': 'unreadable',
      'other-user (EACCES on the op dir, through the seam)': 'other-user',
      'other-user (EACCES)': 'other-user',
    })
    // Every action is refused for each, so each contributes refusals to P1-P3.
    for (const n of kinds.keys()) {
      if (!/C3|EACCES/.test(n)) continue
      const f = fixtures.find((x) => x.name === n)!
      expect(
        RECOVERY_ACTIONS.filter((a) => planAction(f.cls, a).offered),
        n
      ).toEqual([])
    }
  })

  it('P1: every hint segment is well formed, and every action a refusal names is offered (under the unsafe-owner clause: only with it)', () => {
    const bad: string[] = []
    for (const { f, a, detail, p } of refusals(fixtures)) {
      for (const m of p.malformed) bad.push(`${f.name} | --${a} | malformed hint ${m} | ${detail}`)
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

  it('P2: every other offered action is named; the unsafe-only ones under the clause; nothing offered says so; identity only for --apply/--undo of identity-changed', () => {
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
      // An other-user refusal never carries it: no flag gets past another uid's op dir.
      const wantIdentity =
        f.kind === 'identity-changed' &&
        IDENTITY_ACTIONS.includes(a) &&
        !isOtherUser(planAction(f.cls, a))
      if (p.identity !== wantIdentity) {
        bad.push(
          `${f.name} | --${a} | identity clause ${p.identity ? 'present' : 'missing'} | ${detail}`
        )
      }
    }
    expect(bad).toEqual([])
  })

  /**
   * The base may mention the refused action itself, and any flag that is not
   * an action and not one the hint names (`--state-root <dir>`, which names
   * where to keep, not what to run). It names no other action, neither hint
   * flag, and none of the hint's own phrases.
   */
  it('P3: with the hint stripped, the base names no other action, neither hint flag and no hint phrase', () => {
    const bad: string[] = []
    for (const { f, a, detail, p } of refusals(fixtures)) {
      const actions = tokensIn(p.base).filter((t) => t !== a)
      if (actions.length > 0) {
        bad.push(
          `${f.name} | --${a} | base names ${actions.map((t) => `--${t}`).join(', ')} | ${detail}`
        )
      }
      for (const flag of HINT_FLAGS) {
        if (p.base.includes(flag)) bad.push(`${f.name} | --${a} | base names ${flag} | ${detail}`)
      }
      for (const phrase of HINT_PHRASES) {
        if (p.base.includes(phrase)) {
          bad.push(`${f.name} | --${a} | base says the hint phrase "${phrase}" | ${detail}`)
        }
      }
    }
    expect(bad).toEqual([])
  })

  it('P4: every action an offered plan names in its words is offered for that class too', () => {
    const bad: string[] = []
    let checked = 0
    for (const f of fixtures) {
      for (const opts of [{}, UNSAFE_OPT]) {
        for (const a of RECOVERY_ACTIONS) {
          const plan = planAction(f.cls, a, opts)
          if (!plan.offered) continue
          for (const line of wordsOf(plan)) {
            for (const t of tokensIn(line).filter((x) => x !== a)) {
              checked++
              if (!offeredWith(f.cls, t, opts)) {
                bad.push(`${f.name} | --${a} offered | names --${t}, which is refused | ${line}`)
              }
            }
          }
        }
      }
    }
    expect(bad).toEqual([])
    // The notes that name another action are reached ("`--apply` and `--undo` are the same here").
    expect(checked).toBeGreaterThan(0)
  })

  it('is not vacuous: each action offered and refused somewhere; an unsafe-only offer; a fixture offering nothing', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(40)
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

describe('the branches that used to write their own hint are reached, and say only why', () => {
  const baseOf = (name: string, a: RecoveryAction): string =>
    parse(refusalOf(fixtures, name, a)).base

  it('S1 --apply of an edited new/ (it used to add "--undo is offered")', () => {
    expect(refusalOf(fixtures, 'S1, new/ edited after the build', 'apply')).toBe(
      'the new folder no longer hashes to what was built; offered here: --undo'
    )
  })

  it("--clean-staging with no state root names --state-root, which is not an action (the base's one flag)", () => {
    expect(refusalOf(fixtures, 'no-record, no state root', 'clean-staging')).toBe(
      'no state root to keep into: give the state root with --state-root <dir>; ' + NONE
    )
  })

  it('parkPlan: a failed guard walk and a failed lstat each refuse --park', () => {
    expect(baseOf('unreadable (a FIFO at record.json)', 'park')).toMatch(
      /^the op dir cannot be guarded: its guard walk failed \(guard-unsupported-type\) at /
    )
    expect(baseOf('unreadable (an entry whose lstat fails)', 'park')).toMatch(
      /^the op dir cannot be guarded: .*\/old could not be inspected \(EIO\), so it is not set aside unverified; /
    )
  })

  it("a blocked move-source intent: every action refuses with the intent's block", () => {
    const name = 'no-record, a blocked move-source intent'
    for (const a of ['apply', 'undo', 'abandon', 'park'] as const) {
      expect(baseOf(name, a)).toMatch(
        /^there is no record \(its state root .* is not one doctor discovered or was given\)$/
      )
    }
    expect(baseOf(name, 'clean-staging')).toMatch(
      /^its park-intent\.json verifies, but its park cannot be finished: its state root /
    )
  })

  it('groupsBlocked: --clean-staging refuses while the backup area cannot be listed', () => {
    expect(baseOf('no-record, the backup area cannot be listed', 'clean-staging')).toMatch(
      /^the backup area could not be listed \(.*: ENOTDIR\); nothing was changed$/
    )
  })

  it('C4: --abandon of an op dir entry that is not a directory, exactly', () => {
    expect(
      refusalOf(fixtures, 'anything-else, a regular file at the op dir path (no facts)', 'abandon')
    ).toBe(
      'the op dir entry is not a directory, so no record verifies: --abandon acts only on a ' +
        'verified record; move it out of the op dir by hand, and run the command again; ' +
        NONE
    )
  })

  it('a verified record: --clean-staging and --park each say what they act on', () => {
    expect(refusalOf(fixtures, 'S2 post-keep', 'clean-staging')).toBe(
      'its record verifies; --clean-staging acts only on an op dir with no record; offered here: --apply'
    )
    expect(refusalOf(fixtures, 'S2 post-keep', 'park')).toBe(
      'its record verifies; --park acts only on an unreadable record; offered here: --apply'
    )
  })

  it('identity-changed: the identity clause on --apply and --undo only', () => {
    const name = 'identity-changed S2'
    for (const a of IDENTITY_ACTIONS) {
      expect(refusalOf(fixtures, name, a)).toBe(
        'a tree has the right content but is not the folder that was written (a copy, or a remount); ' +
          `offered here: --abandon; ${IDENTITY}`
      )
    }
    for (const a of ['clean-staging', 'park'] as const) {
      expect(refusalOf(fixtures, name, a)).not.toContain('--accept-identity')
    }
  })

  it('identity-changed with another uid: the other-user refusal names no flag', () => {
    const name = 'identity-changed S2, another uid'
    for (const a of IDENTITY_ACTIONS) {
      const detail = refusalOf(fixtures, name, a)
      // Presence from the same run: the refusal is the other-user one, for this fixture.
      expect(detail).toMatch(
        /^the update was started by uid \d+, not this user: run doctor as that user; /
      )
      expect(detail).not.toContain('--accept-identity')
    }
  })
})
