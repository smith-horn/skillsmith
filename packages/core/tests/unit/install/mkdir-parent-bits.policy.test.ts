/**
 * SMI-6531 (A1 step 2): the permission policy as a case table. P is the
 * parent's mode, A the directory's actual mode. Each row states the verdict the
 * rule gives and, for a non-exact verdict, a fragment the explanation must carry.
 *
 * A class REACHES the directory when P gives it execute. Only a reaching class
 * is judged; owner bits and setuid never are.
 */
import { describe, expect, it } from 'vitest'
import {
  judgeMode,
  modeUnsafeMessage,
  octal,
  remedyCommand,
  remedyMode,
} from '../../../src/install/mkdir-parent-bits.policy.js'

type Kind = 'exact' | 'unsafe' | 'narrower'
/** [label, P, A, kind, a fragment the reasons/missing/added text must contain (or null)] */
const ROWS: Array<[string, number, number, Kind, string | null]> = [
  ['exact 0755', 0o755, 0o755, 'exact', null],
  ['exact 1777', 0o1777, 0o1777, 'exact', null],
  ['exact 2775', 0o2775, 0o2775, 'exact', null],
  ['wider group, group reaching', 0o755, 0o775, 'unsafe', 'group write'],
  ['wider group, group not reaching', 0o705, 0o775, 'exact', null],
  ['wider other, other reaching', 0o751, 0o757, 'unsafe', 'other read'],
  ['wider other, other not reaching', 0o750, 0o757, 'exact', null],
  ['extra owner bits', 0o555, 0o755, 'exact', null],
  ['owner bits differ, group and other equal', 0o777, 0o077, 'exact', null],
  ['extra setuid', 0o755, 0o4755, 'exact', null],
  ['extra setgid, group reaching', 0o755, 0o2755, 'unsafe', 'setgid'],
  ['extra setgid, group not reaching', 0o705, 0o2705, 'exact', null],
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

  it('names every missing bit of a reaching class and no bit of a non-reaching one', () => {
    // group does not reach (P group has no execute): its read is not named.
    expect(judgeMode(0o741, 0o700)).toEqual({
      kind: 'narrower',
      missing: ['other execute'],
      added: [],
    })
  })
})

describe('the remedy', () => {
  it('satisfies the policy against every possible parent mode (owner bits and all)', () => {
    for (let p = 0; p <= 0o7777; p += 1) {
      expect(judgeMode(p, remedyMode(p)), `P=${octal(p)}`).toEqual({ kind: 'exact' })
    }
  })

  it('turns every unsafe row in the table into an exact directory', () => {
    for (const [label, p, a, kind] of ROWS) {
      if (kind !== 'unsafe') continue
      expect(judgeMode(p, a).kind, label).toBe('unsafe')
      expect(judgeMode(p, remedyMode(p)).kind, label).toBe('exact')
    }
  })

  it('is the parent’s permission, setgid and sticky bits with owner rwx, never setuid', () => {
    expect(remedyMode(0o1777)).toBe(0o1777)
    expect(remedyMode(0o2755)).toBe(0o2755)
    expect(remedyMode(0o4755)).toBe(0o755)
    expect(remedyMode(0o333)).toBe(0o733)
  })

  it('is an owner-only chmod command with a four-digit mode and the path', () => {
    expect(remedyCommand('/srv/skills/.skillsmith-staging', 0o755)).toBe(
      'chmod 0755 /srv/skills/.skillsmith-staging'
    )
    expect(remedyCommand('/srv/skills/.s', 0o1777)).toBe('chmod 1777 /srv/skills/.s')
  })

  it('quotes a path a shell would split or expand', () => {
    expect(remedyCommand('/a b/it’s', 0o755)).toBe(`chmod 0755 '/a b/it’s'`)
    expect(remedyCommand(`/a'b`, 0o755)).toBe(`chmod 0755 '/a'\\''b'`)
  })

  it('the refusal text names both modes, the reasons and the remedy', () => {
    const message = modeUnsafeMessage({
      subject: '.skillsmith-staging',
      parent: 'the skills root',
      wanted: 0o755,
      actual: 0o777,
      reasons: ['group write is allowed where the parent does not allow it'],
      remedy: 'chmod 0755 /r/.skillsmith-staging',
    })
    expect(message).toContain('mode 0777')
    expect(message).toContain('the skills root has 0755')
    expect(message).toContain('group write is allowed')
    expect(message).toContain('As its owner, run: chmod 0755 /r/.skillsmith-staging')
  })
})
