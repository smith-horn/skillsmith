/**
 * SMI-6531 (A1 step 2): the permission policy as a case table. P is the
 * parent's mode, A the directory's actual mode. Each row states the verdict the
 * rule gives and, for a non-exact verdict, a fragment the explanation must carry.
 *
 * The promise is parity with the parent through the mode bits. A class REACHES
 * the directory through the parent: other when P gives other execute, group when
 * P gives group OR other execute. Only a reaching class is judged; owner bits
 * and setuid never are, and setgid, which grants nothing by itself, is only a
 * warning.
 */
import { describe, expect, it } from 'vitest'
import {
  judgeMode,
  modeProblemOf,
  modeUnsafeMessage,
} from '../../../src/install/mkdir-parent-bits.policy.js'

type Kind = 'exact' | 'unsafe' | 'narrower'
/** [label, P, A, kind, a fragment the reasons/missing/added text must contain (or null)] */
const ROWS: Array<[string, number, number, Kind, string | null]> = [
  ['exact 0755', 0o755, 0o755, 'exact', null],
  ['exact 1777', 0o1777, 0o1777, 'exact', null],
  ['exact 2775', 0o2775, 0o2775, 'exact', null],
  ['wider group, group reaching', 0o755, 0o775, 'unsafe', 'group write'],
  // The group reaches through the parent's OTHER execute bit: its group can differ from the parent's.
  ['wider group, group reaching only through other execute', 0o705, 0o775, 'unsafe', 'group read'],
  ['wider group, P 0701 (other execute only)', 0o701, 0o770, 'unsafe', 'group read'],
  ['wider group, nobody reaches (P 0700)', 0o700, 0o770, 'exact', null],
  ['wider other, other reaching', 0o751, 0o757, 'unsafe', 'other read'],
  ['wider other, other not reaching', 0o750, 0o757, 'exact', null],
  ['wider other, only group reaches (P 0710)', 0o710, 0o717, 'exact', null],
  ['extra owner bits', 0o555, 0o755, 'exact', null],
  ['owner bits differ, group and other equal', 0o777, 0o077, 'exact', null],
  ['extra setuid', 0o755, 0o4755, 'exact', null],
  // Setgid grants no access by itself: a warning, never unsafe, reaching or not.
  ['extra setgid, group reaching', 0o755, 0o2755, 'narrower', 'setgid'],
  ['extra setgid, same group bits (P 0750)', 0o750, 0o2750, 'narrower', 'setgid'],
  ['extra setgid, nobody reaches', 0o700, 0o2700, 'narrower', 'setgid'],
  ['lost setgid', 0o2755, 0o755, 'narrower', 'setgid'],
  ['lost setgid, group not reaching', 0o2705, 0o705, 'narrower', 'setgid'],
  ['lost sticky, a reaching writer', 0o1777, 0o777, 'unsafe', 'sticky'],
  ['lost sticky, a reaching writer (other only)', 0o1703, 0o703, 'unsafe', 'other can write'],
  ['lost sticky, no reaching writer (1777 vs 0755)', 0o1777, 0o755, 'narrower', 'sticky'],
  ['lost sticky, no reaching writer (1755 vs 0755)', 0o1755, 0o755, 'narrower', 'sticky'],
  ['lost sticky, nobody reaches', 0o1700, 0o777, 'narrower', 'sticky'],
  ['extra sticky', 0o755, 0o1755, 'narrower', 'sticky'],
  ['narrower group write', 0o775, 0o755, 'narrower', 'group write'],
  ['narrower group and other write', 0o777, 0o755, 'narrower', 'other write'],
  ['reaching class loses a bit it had', 0o750, 0o740, 'narrower', 'group execute'],
  ['non-reaching class lacks bits the parent gives it', 0o606, 0o600, 'exact', null],
  ['tightened root: P 0700, A 0755', 0o700, 0o755, 'exact', null],
  ['tightened root: P 0700, A 0777', 0o700, 0o777, 'exact', null],
  ['P 0333, A 0733', 0o333, 0o733, 'exact', null],
  ['P 0333, A 0711', 0o333, 0o711, 'narrower', 'group write'],
]

describe('judgeMode: the case table', () => {
  it.each(ROWS)('%s', (_label, p, a, kind, fragment) => {
    const verdict = judgeMode(p, a)
    expect(verdict.kind).toBe(kind)
    if (verdict.kind === 'exact') {
      expect(fragment).toBeNull()
      return
    }
    const text =
      verdict.kind === 'unsafe'
        ? verdict.reasons.join(' | ')
        : [...verdict.missing, ...verdict.added].join(' | ')
    expect(text.length).toBeGreaterThan(0) // a verdict that says nothing is not a warning
    expect(text).toContain(fragment)
  })

  it('the table covers all three verdicts', () => {
    expect(new Set(ROWS.map((r) => r[3]))).toEqual(new Set(['exact', 'unsafe', 'narrower']))
  })

  it('an extra sticky is reported as added, not missing', () => {
    expect(judgeMode(0o755, 0o1755)).toEqual({ kind: 'narrower', missing: [], added: ['sticky'] })
  })

  it('an added setgid is a warning that says so, never a refusal', () => {
    expect(judgeMode(0o750, 0o2750)).toEqual({ kind: 'narrower', missing: [], added: ['setgid'] })
    expect(judgeMode(0o755, 0o2777).kind).toBe('unsafe') // the wider bits are what refuse it
  })

  it('names every missing bit of a reaching class and no bit of a non-reaching one', () => {
    // other does not reach (P other has no execute): its read is not named. Group reaches.
    expect(judgeMode(0o754, 0o700)).toEqual({
      kind: 'narrower',
      missing: ['group read', 'group execute'],
      added: [],
    })
    // P 0741: group has no execute of its own but reaches through other's, so its read IS named
    // (it was not, before the group class was allowed to reach through the other execute bit).
    expect(judgeMode(0o741, 0o700)).toEqual({
      kind: 'narrower',
      missing: ['group read', 'other execute'],
      added: [],
    })
  })

  it('PROPERTY: unless the verdict is unsafe, a reaching class never has a bit the parent lacks', () => {
    const groupReaches = (p: number): boolean => (p & 0o011) !== 0
    const otherReaches = (p: number): boolean => (p & 0o001) !== 0
    let checked = 0
    for (let p = 0; p <= 0o7777; p += 1) {
      for (let a = 0; a <= 0o777; a += 1) {
        const wider =
          (groupReaches(p) && ((a >> 3) & ~(p >> 3) & 0o7) !== 0) ||
          (otherReaches(p) && (a & ~p & 0o7) !== 0)
        const kind = judgeMode(p, a).kind
        if (wider && kind !== 'unsafe') throw new Error(`P=${p.toString(8)} A=${a.toString(8)}`)
        if (!wider && kind === 'unsafe' && (p & 0o1000) === 0) {
          throw new Error(`refused without a wider bit: P=${p.toString(8)} A=${a.toString(8)}`)
        }
        checked += 1
      }
    }
    expect(checked).toBe(4096 * 512)
  })
})

describe('the refusal text', () => {
  const args = {
    subject: '.skillsmith-staging',
    parent: 'the skills root',
    wanted: 0o755,
    actual: 0o777,
    reasons: ['group write is allowed where the parent does not allow it', 'other read is x'],
  }

  it('names both modes and the reasons, and what must hold', () => {
    const message = modeUnsafeMessage(args)
    expect(message).toContain('mode 0777')
    expect(message).toContain('the skills root has 0755')
    expect(message).toContain('group write is allowed')
    expect(message).toContain('other read is x')
    expect(message).toContain('must not give other users more access than the skills root does')
  })

  it('prints no command to copy: a symlink swapped in before it runs would be followed', () => {
    const message = modeUnsafeMessage(args)
    expect(message).not.toMatch(/chmod/i)
    expect(message).not.toMatch(/run:/i)
  })

  it('the ModeProblem carries the same fields and message', () => {
    expect(modeProblemOf(args)).toEqual({
      wanted: 0o755,
      actual: 0o777,
      reasons: args.reasons,
      message: modeUnsafeMessage(args),
    })
    expect(Object.keys(modeProblemOf(args)).sort()).toEqual([
      'actual',
      'message',
      'reasons',
      'wanted',
    ])
  })
})
