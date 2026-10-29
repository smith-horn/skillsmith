/**
 * SMI-6531 (A1 step 6b-iii): `--abandon` across devices (the state root on
 * `/dev/shm`, a real `EXDEV`): each verified source stays in OP, which is
 * parked whole behind a `move-source` intent naming the op dir itself (UD28,
 * UD54); the plan states that finish step for step; the precheck runs before
 * any mutation; and a deep state root finishes (SMI-7205's 64 KiB cap).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { executeRecovery } from '../../../../src/services/skill-recovery.exec.js'
import { planAction } from '../../../../src/services/skill-recovery.plan.js'
import { planRecovery } from '../../../../src/services/skill-recovery.target.js'
import { setIntentCapForTest } from '../../../../src/services/skill-swap.intent-schema.js'
import type { SwapHookPoint, TraceOp } from '../../../../src/services/skill-swap.types.js'
import { ALL_DELETES, spyFs } from '../skill-swap.abort.helpers.js'
import type { Event } from '../skill-swap.abort.helpers.js'
import { areaOf, hashOf, makeFixture, OP_ID, useTmpCleanup } from '../skill-swap.helpers.js'
import type { Fixture } from '../skill-swap.helpers.js'
import { parkedCopies, useOtherDeviceCleanup } from '../skill-swap.xdev.helpers.js'
import { act, contentSnapshot, counting, done, killAt, requestOf } from './recovery.act.helpers.js'
import { destOf, opReport, s2 } from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'
import {
  contentSet,
  nothingLost,
  theParkedCopy,
  treeDeletesDoctor,
  xfile,
} from './recovery.xdev.helpers.js'
import { abandonable, copiedOp, sidecarAt } from './recovery.abandon.helpers.js'

useTmpCleanup()
useOtherDeviceCleanup()
afterEach(() => setIntentCapForTest(null))

/** Everything an action could touch: the skills root, the state root, the journal's base. */
const world = (st: State): string => contentSnapshot(st.fx.skillsDir, st.fx.stateRoot, st.fx.base)

/** `fx` with its state root moved `len` characters deep (components of at most 200). */
function deep(len: number, fx: Fixture): Fixture {
  let p = fx.stateRoot
  while (p.length < len)
    p = path.join(p, 'd'.repeat(Math.min(200, Math.max(1, len - p.length - 1))))
  fs.mkdirSync(p, { recursive: true })
  return { ...fx, stateRoot: p }
}
const DEEP = 3790

const intentOf = (st: State): string => path.join(st.opDir, 'park-intent.json')

describe('across devices: copied, verified, then the op dir parked whole with the intent', () => {
  it('anything else: N kept as abandoned-new; new/ and the intent parked; nothing lost, no tree deleted', async () => {
    const st = await abandonable(xfile())
    const before = contentSet(st.opDir)
    const events: Event[] = []
    const restore = spyFs(ALL_DELETES, events)
    let a: Awaited<ReturnType<typeof done>>
    try {
      a = await done(st, 'abandon')
    } finally {
      restore()
    }
    const dest = destOf(st, 'abandoned-new')
    expect(a.result.kept).toEqual([{ tree: 'N', kind: 'abandoned-new', path: dest }])
    const parked = theParkedCopy(st.fx)
    expect(a.result.extraCopy).toBe(parked)
    expect(fs.readdirSync(parked).sort()).toEqual(['new', 'park-intent.json'])
    const intent = JSON.parse(fs.readFileSync(path.join(parked, 'park-intent.json'), 'utf8'))
    expect(intent).toMatchObject({ kind: 'move-source', opId: OP_ID, backupPath: dest })
    expect(hashOf(dest)).toBe(hashOf(path.join(parked, 'new')))
    nothingLost(before, contentSet(areaOf(st.fx), parked))
    expect(treeDeletesDoctor(st.fx, events)).toEqual([])
    expect(fs.existsSync(st.opDir)).toBe(false)
  })

  it('the plan states the cross-device finish in the order finishRecoveredAcross runs it', async () => {
    const st = await abandonable(xfile())
    const planned = await planRecovery(requestOf(st, 'abandon'))
    if (planned.status !== 'planned') throw new Error(JSON.stringify(planned))
    const line = planned.plan.remaining.find((r) => r.startsWith('if a copy crosses devices: '))
    const stated = line!.slice('if a copy crosses devices: '.length).split(', then ')
    const ev: Array<TraceOp | 'cleanup'> = []
    const r = await executeRecovery(planned, {
      swap: {
        trace: (t) => ev.push(t),
        hooks: { beforeMetadataCleanup: () => void ev.push('cleanup') },
      },
    })
    expect(r.status).toBe('done')
    const ran: string[] = []
    const tail = ev.slice(ev.indexOf('cleanup') + 1)
    for (let i = 0; i < tail.length; i++) {
      const e = tail[i]!
      if (e === 'cleanup') continue
      if (e.op === 'create' && e.path === `${intentOf(st)}.tmp`) {
        // The intent's publish: temp, its fsync, link, temp unlinked, then the op dir synced.
        while (!(tail[i] !== 'cleanup' && (tail[i] as TraceOp).op === 'dirsync')) i++
        ran.push('write park-intent.json (kind move-source) durably')
        continue
      }
      if (e.op === 'unlink' && path.dirname(e.path) === st.opDir) {
        ran.push(`unlink ${path.basename(e.path)}`)
      } else if (e.op === 'dirsync' && e.path === st.opDir) ran.push('sync the op dir')
      if (ran.at(-1) === 'sync the op dir' && ran.at(-2) === 'unlink record.json') {
        ran.push('park the op dir whole with its verified sources and the intent (no rmdir)')
        break
      }
    }
    expect(ran.length).toBeGreaterThan(5)
    for (let i = 0; i < Math.max(stated.length, ran.length); i++) {
      expect(ran[i], `step ${i}: stated ${JSON.stringify(stated)}`).toBe(stated[i])
    }
  })

  it('an unhashable tree across devices cannot be verified: stopped write-failed, the record kept, no tree removed', async () => {
    const st = await abandonable(xfile())
    execFileSync('mkfifo', [path.join(st.opDir, 'new', 'pipe')])
    const events: Event[] = []
    const restore = spyFs(ALL_DELETES, events)
    let a: Awaited<ReturnType<typeof act>>
    try {
      a = await act(st, 'abandon')
    } finally {
      restore()
    }
    expect(a.result).toMatchObject({ status: 'stopped', reason: 'write-failed' })
    expect(fs.existsSync(path.join(st.opDir, 'record.json'))).toBe(true)
    expect(fs.lstatSync(path.join(st.opDir, 'new', 'pipe')).isFIFO()).toBe(true)
    expect(treeDeletesDoctor(st.fx, events)).toEqual([])
  })
})

describe('kills across devices: the same command finishes, with the intent the op dir itself names', () => {
  const POINTS: readonly SwapHookPoint[] = [
    'beforePublish',
    'afterSidecar',
    'afterBackupCopy',
    'afterBackupVerify',
    'afterBackupMove',
    'beforeMetadataCleanup',
    'afterIntentTemp',
    'afterIntent',
    'afterOwnerUnlink',
  ]
  const AFTER_RECORD: readonly SwapHookPoint[] = ['afterRecordUnlink', 'afterRecoveredOpSync']

  it('every kill of a copied op dir (op-dir-identity), then a rerun, ends parked with nothing lost', async () => {
    const build = async () => copiedOp(await s2(xfile()))
    const ref = await build()
    const c = counting([...POINTS, ...AFTER_RECORD])
    await done(ref, 'abandon', {}, c.opts)
    const kills = [...c.counts].flatMap(([p, n]) =>
      Array.from({ length: n }, (_, i) => [p, i + 1] as const)
    )
    expect(kills.map(([p]) => p)).toEqual(expect.arrayContaining(['afterIntent', ...AFTER_RECORD]))
    for (const [point, nth] of kills) {
      const st = await build()
      const before = contentSet(st.opDir)
      const first = await act(st, 'abandon', {}, killAt(point, nth))
      expect(first.result.status, `${point} #${nth}`).toBe(
        AFTER_RECORD.includes(point) ? 'done' : 'stopped'
      )
      const again = await act(st, 'abandon')
      expect(
        again.result.status,
        `${point} #${nth}: ${JSON.stringify(again.result).slice(0, 400)}`
      ).toBe('done')
      expect(fs.existsSync(st.opDir), `${point} #${nth}`).toBe(false)
      expect(parkedCopies(st.fx), `${point} #${nth}`).toHaveLength(1)
      nothingLost(before, contentSet(areaOf(st.fx), parkedCopies(st.fx)[0]!))
    }
  })

  it('delta § 3: killed after its intent, a moved op’s rerun reuses the intent it wrote (it names the op dir as it is)', async () => {
    const st = copiedOp(await s2(xfile()))
    const first = await act(st, 'abandon', {}, killAt('afterIntent'))
    expect(first.result.status).toBe('stopped')
    expect(fs.existsSync(path.join(st.opDir, 'record.json'))).toBe(true)
    expect(fs.existsSync(intentOf(st))).toBe(true)
    const cls = (await opReport(st)).cls
    expect(cls.kind).toBe('ab')
    if (cls.kind !== 'ab') return
    expect(cls.facts.moved).toBe('op-dir-identity')
    expect(cls.facts.parkIntent).toEqual({ path: intentOf(st), valid: true })
    const plan = planAction(cls, 'abandon')
    if (!plan.offered) throw new Error(plan.detail)
    expect(plan.remaining.join('\n')).toContain('reuse the verified park-intent.json')
    const written = fs.readFileSync(intentOf(st), 'utf8')
    const again = await done(st, 'abandon')
    // Reused, not rewritten: the parked intent is the one the first run wrote.
    expect(fs.readFileSync(path.join(theParkedCopy(st.fx), 'park-intent.json'), 'utf8')).toBe(
      written
    )
    expect(again.result.extraCopy).toBe(theParkedCopy(st.fx))
  })

  it('UD54: killed after record.json goes, the no-record op dir is finished by --abandon (and offered to --apply)', async () => {
    const st = await abandonable(xfile())
    const first = await act(st, 'abandon', {}, killAt('afterRecordUnlink'))
    expect(first.result.status).toBe('done')
    expect(fs.existsSync(path.join(st.opDir, 'record.json'))).toBe(false)
    const cls = (await opReport(st)).cls
    expect(cls.kind).toBe('no-record')
    expect(planAction(cls, 'apply').offered).toBe(true)
    const plan = planAction(cls, 'abandon')
    expect(plan.offered).toBe(true)
    const again = await done(st, 'abandon')
    expect(again.result.from).toBe('no-record')
    expect(fs.existsSync(st.opDir)).toBe(false)
    expect(fs.readdirSync(theParkedCopy(st.fx)).sort()).toEqual(['new', 'park-intent.json'])
  })
})

describe('the park-intent precheck: before any mutation, the backup area’s mkdir included', () => {
  /** The precheck's own words at the seam's 4096-byte cap. */
  const COULD_BE =
    /^the park intent could be up to \d+ bytes, at or over the reader's 4096-byte cap; /
  const APPLY_TAIL =
    "; nothing was changed; this op's record fixes its backup area under the state root its update used, so `--state-root` does not shorten it; no command in this version finishes it"

  for (const [name, fixture] of [
    ['across devices', () => deep(DEEP, xfile())],
    ['on one device', () => deep(DEEP, makeFixture({ 'SKILL.md': '# v1\n', 'a.txt': 'a\n' }))],
  ] as const) {
    it(`${name}: a deep state root at a 4096-byte cap refuses staging-unsafe; nothing changed, the area not created`, async () => {
      const st = await abandonable(fixture())
      setIntentCapForTest(4096)
      const area = areaOf(st.fx)
      expect(fs.existsSync(area)).toBe(false)
      const before = world(st)
      const a = await act(st, 'abandon')
      expect(a.planned.status).toBe('planned')
      expect(a.result).toMatchObject({ status: 'refused', reason: 'staging-unsafe' })
      const detail = (a.result as { detail: string }).detail
      expect(detail).toMatch(COULD_BE)
      expect(detail.endsWith(APPLY_TAIL)).toBe(true)
      expect(fs.existsSync(area)).toBe(false)
      expect(world(st)).toBe(before)
      expect(fs.existsSync(path.join(st.opDir, 'record.json'))).toBe(true)
    })
  }

  it('SMI-7205: at the default cap the same deep root finishes; its intent is over 4096 bytes and reads back valid', async () => {
    const st = await abandonable(deep(DEEP, xfile()))
    const first = await act(st, 'abandon', {}, killAt('afterRecordUnlink'))
    expect(first.result.status).toBe('done')
    expect(fs.statSync(intentOf(st)).size).toBeGreaterThan(4096)
    const cls = (await opReport(st)).cls
    if (cls.kind !== 'no-record') throw new Error(`expected no-record, got ${cls.kind}`)
    expect(cls.intent?.valid).toBe(true)
    expect(cls.intent?.blocked).toBeNull()
    await done(st, 'abandon')
    expect(fs.existsSync(st.opDir)).toBe(false)
    expect(sidecarAt(destOf(st, 'abandoned-new')).kind).toBe('abandoned-new')
  })
})
