/**
 * SMI-6531 (A1 step 5): T-R2's swap half (an unreadable record blocks every
 * write in its skills root), its hook (the scan runs under lock 1, after the
 * build), a record from another root, and where the scan sits in the order.
 * T-R1 and T-R3 are in `skill-swap.scan.test.ts`.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { refusedOf } from './skill-swap.abort.helpers.js'
import {
  hashOf,
  makeFixture,
  modify,
  OP_ID,
  plan,
  run,
  useTmpCleanup,
} from './skill-swap.helpers.js'
import type { Fixture } from './skill-swap.helpers.js'
import {
  attempt,
  crashStopped,
  deepSnapshot,
  frozen,
  opDirOf,
  opIdN,
  otherSkill,
} from './skill-swap.scan.helpers.js'

useTmpCleanup()

/** How to make the crashed op dir's record unreadable; returns the opId that is now unreadable. */
type Corrupt = (fx: Fixture, opDir: string) => string
const record = (opDir: string): string => path.join(opDir, 'record.json')

const CORRUPTIONS: Array<[string, Corrupt]> = [
  [
    'truncated',
    (_fx, opDir) => {
      const text = fs.readFileSync(record(opDir), 'utf8')
      fs.writeFileSync(record(opDir), text.slice(0, Math.floor(text.length / 2)))
      return OP_ID
    },
  ],
  [
    'hash mismatch',
    (_fx, opDir) => {
      const rec = JSON.parse(fs.readFileSync(record(opDir), 'utf8')) as Record<string, unknown>
      rec.pid = (rec.pid as number) + 1
      fs.writeFileSync(record(opDir), JSON.stringify(rec))
      return OP_ID
    },
  ],
  [
    'symlinked',
    (fx, opDir) => {
      const real = path.join(fx.base, 'real-record.json')
      fs.renameSync(record(opDir), real)
      fs.symlinkSync(real, record(opDir))
      return OP_ID
    },
  ],
  [
    'a directory',
    (_fx, opDir) => {
      fs.unlinkSync(record(opDir))
      fs.mkdirSync(record(opDir))
      return OP_ID
    },
  ],
  [
    'a FIFO (opening it must not block)',
    (_fx, opDir) => {
      fs.unlinkSync(record(opDir))
      execFileSync('mkfifo', [record(opDir)])
      return OP_ID
    },
  ],
  [
    'not JSON',
    (_fx, opDir) => {
      fs.writeFileSync(record(opDir), 'not json at all')
      return OP_ID
    },
  ],
  [
    'wrong shape',
    (_fx, opDir) => {
      fs.writeFileSync(record(opDir), '{"schema":1}')
      return OP_ID
    },
  ],
  [
    'copied into another op dir',
    (fx, opDir) => {
      const bad = opIdN('9')
      fs.mkdirSync(opDirOf(fx, bad))
      fs.copyFileSync(record(opDir), record(opDirOf(fx, bad)))
      return bad
    },
  ],
]

describe('T-R2 (swap half): an unreadable record blocks every write in its root', () => {
  for (const [label, corrupt] of CORRUPTIONS) {
    it(`${label}: the named skill and another skill both refuse recovery-record-unreadable`, async () => {
      const fx = makeFixture({ 'SKILL.md': '# v1\n' })
      const other = otherSkill(fx, 'other-skill', { 'SKILL.md': '# other\n' })
      const crashed = await crashStopped(fx)
      const bad = corrupt(fx, crashed.opDir)
      const before = frozen(fx, crashed)
      const otherBefore = hashOf(other.realDir)

      for (const [skill, id] of [
        [fx, 'c'],
        [other, 'd'],
      ] as const) {
        const r = await attempt(skill, opIdN(id))
        const refused = refusedOf(r.result)
        expect(refused).toMatchObject({
          reason: 'recovery-record-unreadable',
          blockedBy: [bad],
          staged: 'parked',
        })
        if (label === 'copied into another op dir') {
          // A record that verifies but names another op dir is `recovery-moved` to doctor (Q6):
          // the advice is the listing, and parking it is not offered.
          expect(refused.detail).toContain('Run `skillsmith doctor recovery`.')
          expect(refused.detail).not.toContain('--park')
        } else {
          expect(refused.detail).toContain(`skillsmith doctor recovery --park ${bad}`)
          expect(refused.detail).not.toContain('Run `skillsmith doctor recovery`.')
        }
        expect(refused.detail).toContain(fx.skillsDir)
        expect(r.trace).toContainEqual({ op: 'record-scan', path: fx.staging })
        expect(r.p.manifest.writes).toBe(0)
      }
      expect(hashOf(other.realDir)).toBe(otherBefore)
      expect(frozen(fx, crashed)).toEqual(before)
    }, 10_000) // a FIFO that blocked the scan would hang here, so the bound is explicit
  }
})

describe('T-R2 hook: the scan runs under lock 1, after the build', () => {
  it('a record that becomes unreadable after one run built, before its lock 1, still refuses it', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const other = otherSkill(fx, 'other-skill', { 'SKILL.md': '# other\n' })
    const crashed = await crashStopped(fx)
    let corruptedAt = ''

    const r = await attempt(other, opIdN('c'), {
      hooks: {
        afterBuild: () => {
          // Outside lock 1: the record was fine when this run started its build.
          corruptedAt = 'afterBuild'
          fs.writeFileSync(record(crashed.opDir), 'corrupted between the build and lock 1')
        },
      },
    })

    expect(corruptedAt).toBe('afterBuild')
    expect(refusedOf(r.result)).toMatchObject({
      reason: 'recovery-record-unreadable',
      blockedBy: [OP_ID],
    })
    expect(r.p.manifest.writes).toBe(0)
  })

  it('control: the same run commits when the hook leaves the record alone and it names another skill', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const other = otherSkill(fx, 'other-skill', { 'SKILL.md': '# other\n' })
    const crashed = await crashStopped(fx)
    const before = deepSnapshot(crashed.opDir)
    let hookRan = false

    const r = await attempt(other, opIdN('c'), {
      hooks: {
        afterBuild: () => {
          hookRan = true
        },
      },
    })

    expect(hookRan).toBe(true)
    expect(r.result.status).toBe('committed')
    expect(deepSnapshot(crashed.opDir)).toEqual(before)
  })
})

describe('T-R2: a record from another root', () => {
  it('an op dir copied in from root A refuses every write in root B (foreign root); root A still sees it as pending', async () => {
    const a = makeFixture({ 'SKILL.md': '# a\n' })
    const crashed = await crashStopped(a)
    const b = makeFixture({ 'SKILL.md': '# b1\n' })
    const b2 = otherSkill(b, 'second-skill', { 'SKILL.md': '# b2\n' })
    expect((await attempt(b2, opIdN('d'))).result.status).toBe('committed') // makes B's ST
    fs.cpSync(crashed.opDir, opDirOf(b, OP_ID), { recursive: true })

    for (const [skill, id] of [
      [b, 'e'],
      [b2, 'f'],
    ] as const) {
      const r = await attempt(skill, opIdN(id))
      expect(refusedOf(r.result)).toMatchObject({
        reason: 'recovery-record-unreadable',
        blockedBy: [OP_ID],
      })
      expect(refusedOf(r.result).detail).toContain(b.skillsDir)
    }
    // Control: the same bytes in their own root are a verified, pending record.
    expect(refusedOf((await attempt(a, opIdN('c'))).result)).toMatchObject({
      reason: 'recovery-pending',
      blockedBy: [OP_ID],
    })
  })
})

describe('the scan in the order of the transaction', () => {
  const timeline = () => {
    const tl: string[] = []
    return {
      tl,
      options: {
        trace: (t: { op: string; path?: string }) =>
          tl.push(t.op === 'create' ? `create:${t.path}` : t.op),
        hooks: {
          afterBuild: () => void tl.push('hook:afterBuild'),
          afterStep4Hash: () => void tl.push('hook:afterStep4Hash'),
        },
      },
    }
  }

  it('record-scan follows the build, precedes the record temp and step 4', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const t = timeline()
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const { result } = await run(p, t.options)
    expect(result.status).toBe('committed')

    const build = t.tl.indexOf('hook:afterBuild')
    const scan = t.tl.indexOf('record-scan')
    const recTmp = t.tl.indexOf(`create:${path.join(fx.opDir, 'record.json.tmp')}`)
    const step4 = t.tl.indexOf('hook:afterStep4Hash')
    expect(build).toBeGreaterThanOrEqual(0)
    expect(t.tl.filter((e) => e === 'record-scan')).toHaveLength(1)
    expect(scan).toBeGreaterThan(build)
    expect(step4).toBeGreaterThan(scan)
    expect(recTmp).toBeGreaterThan(step4)
  })

  it('a refused run reaches the scan and never step 4, the record or a rename (same hooks as the control above)', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const other = otherSkill(fx, 'other-skill', { 'SKILL.md': '# other\n' })
    await crashStopped(fx)
    const t = timeline()
    const r = await attempt(fx, opIdN('c'), t.options)

    expect(refusedOf(r.result).reason).toBe('recovery-pending')
    expect(t.tl).toContain('hook:afterBuild')
    expect(t.tl).toContain('record-scan')
    expect(t.tl).not.toContain('hook:afterStep4Hash')
    expect(t.tl.some((e) => e.startsWith('create:') && e.endsWith('record.json.tmp'))).toBe(false)
    expect(r.trace.some((e) => e.op === 'rename' && e.path === fx.realDir)).toBe(false)
    // Paired: another skill past the same hooks does reach step 4.
    const t2 = timeline()
    expect((await attempt(other, opIdN('d'), t2.options)).result.status).toBe('committed')
    expect(t2.tl).toContain('hook:afterStep4Hash')
  })
})
