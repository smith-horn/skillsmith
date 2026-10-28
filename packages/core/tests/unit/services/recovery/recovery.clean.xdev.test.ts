/**
 * SMI-6531 (A1 step 6b-ii): `--clean-staging` across devices (design
 * `step6b-design.md` § 1.2 case (b) step 7, § 6 "Cross-device
 * --clean-staging"; UD28, PLAN:1916 park-caller row 2). The state root is on
 * another device (`/dev/shm`): N is copied and verified into the area, the
 * verified N stays in OP, the move-source intent is made durable, the
 * metadata goes (`owner.json` last), and OP is parked whole. Zero tree
 * deletes (the fs spy); a kill at each boundary, then the same command, ends
 * as an uninterrupted run would. Also T-PI2's move-source half: a doctor
 * cross-device finish killed after its record went is finished by
 * `--clean-staging` too.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RecoveryRequest } from '../../../../src/services/skill-recovery.run.types.js'
import type { SwapHookPoint } from '../../../../src/services/skill-swap.js'
import type { TraceOp } from '../../../../src/services/skill-swap.types.js'
import { ALL_DELETES, contentOf, spyFs } from '../skill-swap.abort.helpers.js'
import type { Event } from '../skill-swap.abort.helpers.js'
import { areaOf, hashOf, OP_ID, useTmpCleanup } from '../skill-swap.helpers.js'
import { useOtherDeviceCleanup } from '../skill-swap.xdev.helpers.js'
import { act, done, killAt } from './recovery.act.helpers.js'
import { opReport } from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'
import {
  abortLeft,
  ALIVE,
  dead,
  editOwner,
  file,
  keptAt,
  opNames,
  sidecarAt,
} from './recovery.clean.helpers.js'
import {
  contentSet,
  killed,
  nothingLost,
  theParkedCopy,
  treeDeletesDoctor,
  xfile,
  xs3,
} from './recovery.xdev.helpers.js'

useTmpCleanup()
useOtherDeviceCleanup()

const everything = (st: State): Set<string> => contentSet(st.fx.skillsDir, st.fx.stateRoot)

describe('cross-device --clean-staging: copy, verify, intent, park; no tree deleted', () => {
  it('N kept (verified copy) in the other-device area; OP parked whole with N and the intent', async () => {
    const st = await abortLeft('abortAfterCheck', { editN: true }, xfile())
    const nHash = hashOf(path.join(st.opDir, 'new'))
    const before = everything(st)
    const events: Event[] = []
    const restore = spyFs(ALL_DELETES, events)
    let a: Awaited<ReturnType<typeof done>>
    try {
      a = await done(st, 'clean-staging', dead)
    } finally {
      restore()
    }
    const dest = keptAt(st.fx, 'unrecorded-new')
    const parked = theParkedCopy(st.fx)
    expect(a.result.kept).toEqual([{ tree: 'N', kind: 'unrecorded-new', path: dest }])
    expect(a.result.extraCopy).toBe(parked)
    expect(hashOf(dest)).toBe(nHash)
    expect(sidecarAt(dest)).toMatchObject({ kind: 'unrecorded-new', treeHash: nHash })
    expect(fs.readdirSync(parked).sort()).toEqual(['new', 'park-intent.json'])
    expect(hashOf(path.join(parked, 'new'))).toBe(nHash)
    const intent = JSON.parse(fs.readFileSync(path.join(parked, 'park-intent.json'), 'utf8'))
    expect(intent).toMatchObject({ kind: 'move-source', backupPath: dest, schema: 1 })
    expect(fs.existsSync(st.opDir)).toBe(false)
    expect(treeDeletesDoctor(st.fx, events)).toEqual([])
    nothingLost(before, everything(st))
    // The order: the verified copy, then the intent, owner.json, OP's sync, the park.
    const trace = a.trace
    const idx = (pred: (t: (typeof trace)[number]) => boolean): number => trace.findIndex(pred)
    const intentLink = idx(
      (t) => t.op === 'link' && t.dest === path.join(st.opDir, 'park-intent.json')
    )
    const ownerGone = idx((t) => t.op === 'unlink' && t.path === path.join(st.opDir, 'owner.json'))
    const park = idx((t) => t.op === 'park')
    expect(intentLink).toBeGreaterThan(-1)
    expect(ownerGone).toBeGreaterThan(intentLink)
    expect(park).toBeGreaterThan(ownerGone)
  })

  /** The keep plan's `remaining` lines of a run that finished, with its trace. */
  async function planAndRun(
    fx: ReturnType<typeof xfile>,
    arrange: (st: State) => void = () => undefined,
    over: Partial<RecoveryRequest> = dead
  ) {
    const st = await abortLeft('abortAfterCheck', {}, fx)
    arrange(st)
    const a = await done(st, 'clean-staging', over)
    if (a.planned.status !== 'planned') throw new Error('expected a plan')
    return { st, a, remaining: a.planned.plan.remaining }
  }

  /** Provable metadata temps (empty files with one link: a kill inside a metadata publish). */
  const plantTemps = (st: State): void => {
    fs.writeFileSync(path.join(st.opDir, 'record.json.tmp'), '')
    fs.writeFileSync(path.join(st.opDir, 'park-intent.json.tmp'), '')
  }

  const ONE = 'on one device: '
  const ACROSS = 'if the copy crosses devices: '

  /** One labelled sequence of the plan, as its steps. */
  function stepsOf(remaining: readonly string[], label: string): string[] {
    const line = remaining.find((l) => l.startsWith(label))
    if (line === undefined) throw new Error(`no "${label}" line in ${JSON.stringify(remaining)}`)
    return line.slice(label.length).split(', then ')
  }

  /** A plan step as the tag the trace shows for it. */
  function tagOfStep(step: string): string {
    if (step.startsWith('write park-intent.json')) return 'intent'
    if (step === 'unlink owner.json') return 'owner'
    const temp = 'unlink the metadata temp '
    if (step.startsWith(temp)) return `temp:${path.basename(step.slice(temp.length))}`
    if (step === 'rmdir the emptied op dir') return 'rmdir'
    if (step.startsWith('park the op dir')) return 'park'
    if (step === 'sync the op dir') return 'sync:op'
    if (step === 'sync the staging dir') return 'sync:st'
    throw new Error(`a plan step the test does not know: ${step}`)
  }

  const plannedTags = (steps: readonly string[]): string[] => steps.map(tagOfStep)

  /**
   * What the run did to the op dir after its keep, in order, in the same tags
   * (syncs of the op dir and the staging dir included). The window opens after
   * the keep's last `rename`; on one device the keep's own sync of the op dir
   * follows that rename and is not the finish's, so it is skipped. The intent's
   * publish temp and its own sync are part of the `intent` step. Across devices
   * the window ends at the park, whose own syncs are not the plan's.
   */
  function observedTags(trace: readonly TraceOp[], opDir: string): string[] {
    const staging = path.dirname(opDir)
    const out: string[] = []
    const from = trace.map((t) => t.op).lastIndexOf('rename') + 1
    const crossed = trace.some((t) => t.op === 'park')
    let skipOpSync = !crossed
    let intentSync = false
    for (const t of trace.slice(from)) {
      if (t.op === 'dirsync' && t.path === opDir) {
        if (skipOpSync) skipOpSync = false
        else if (intentSync) intentSync = false
        else out.push('sync:op')
      } else if (t.op === 'dirsync' && t.path === staging) {
        if (out.includes('rmdir')) out.push('sync:st')
      } else if (t.op === 'link' && t.dest === path.join(opDir, 'park-intent.json')) {
        out.push('intent')
        intentSync = true
      } else if (t.op === 'unlink' && path.dirname(t.path) === opDir) {
        skipOpSync = false
        const name = path.basename(t.path)
        // The intent's own publish temp goes right after the link: part of "write", not a temp step.
        if (name === 'park-intent.json.tmp' && out.includes('intent')) continue
        out.push(name === 'owner.json' ? 'owner' : `temp:${name}`)
      } else if (t.op === 'rmdir' && t.path === opDir) out.push('rmdir')
      else if (t.op === 'park') {
        out.push('park')
        break
      }
    }
    return out
  }

  it('the plan states the cross-device finish in the order the run takes it, temps included (no rmdir)', async () => {
    const { st, a, remaining } = await planAndRun(xfile(), plantTemps)
    const across = stepsOf(remaining, ACROSS)
    expect(plannedTags(across)).toEqual([
      'temp:park-intent.json.tmp',
      'sync:op',
      'intent',
      'temp:record.json.tmp',
      'owner',
      'sync:op',
      'park',
    ])
    expect(plannedTags(across)).toEqual(observedTags(a.trace, st.opDir))
    expect(across[across.length - 1]).toContain('(no rmdir)')
    expect(a.trace.some((t) => t.op === 'rmdir' && t.path === st.opDir)).toBe(false)
    expect(remaining.some((l) => l.startsWith('then'))).toBe(false)
  })

  it('a verifying intent (--clean-staging case a): its temps, owner.json, the op dir sync, then the park, in the order the run takes them', async () => {
    const st = await abortLeft('abortAfterCheck', {}, xfile())
    const first = await act(st, 'clean-staging', dead, killAt('afterIntent'))
    expect(first.result.status).toBe('stopped')
    fs.writeFileSync(path.join(st.opDir, 'record.json.tmp'), '')
    expect(opNames(st)).toEqual(['new', 'owner.json', 'park-intent.json', 'record.json.tmp'])
    const a = await done(st, 'clean-staging', dead)
    if (a.planned.status !== 'planned') throw new Error('expected a plan')
    const remaining = a.planned.plan.remaining
    expect(plannedTags(remaining)).toEqual(['temp:record.json.tmp', 'owner', 'sync:op', 'park'])
    expect(plannedTags(remaining)).toEqual(observedTags(a.trace, st.opDir))
  })

  it('a no-record move-source intent under --apply: its temps, the op dir sync, then the park, in the order the run takes them', async () => {
    const st = await xs3({ hooks: { afterBackupMove: () => killed('afterBackupMove') } })
    expect((await act(st, 'apply', {}, killAt('afterRecordUnlink'))).result.status).toBe('done')
    fs.writeFileSync(path.join(st.opDir, 'record.json.tmp'), '')
    expect(opNames(st)).toEqual(['old', 'park-intent.json', 'record.json.tmp'])
    const a = await done(st, 'apply', { ownerProbe: ALIVE })
    if (a.planned.status !== 'planned') throw new Error('expected a plan')
    const remaining = a.planned.plan.remaining
    expect(plannedTags(remaining)).toEqual(['temp:record.json.tmp', 'sync:op', 'park'])
    expect(plannedTags(remaining)).toEqual(observedTags(a.trace, st.opDir))
  })

  it('the same plan states the one-device finish in the order the one-device run takes it (rmdir, no park)', async () => {
    const { st, a, remaining } = await planAndRun(file(), plantTemps)
    const one = stepsOf(remaining, ONE)
    expect(plannedTags(one)).toEqual([
      'temp:park-intent.json.tmp',
      'temp:record.json.tmp',
      'sync:op',
      'owner',
      'sync:op',
      'rmdir',
      'sync:st',
    ])
    expect(plannedTags(one)).toEqual(observedTags(a.trace, st.opDir))
    expect(a.trace.some((t) => t.op === 'park')).toBe(false)
    // The text does not depend on the device: the cross-device sequence is stated here too.
    expect(plannedTags(stepsOf(remaining, ACROSS))).toContain('park')
  })

  for (const [label, fx] of [
    ['one device', file],
    ['across devices', xfile],
  ] as const) {
    it(`no owner.json (verdict absent, --unsafe-unverified-owner), ${label}: neither sequence mentions owner.json`, async () => {
      const { st, a, remaining } = await planAndRun(
        fx(),
        (s) => fs.rmSync(path.join(s.opDir, 'owner.json')),
        { ...dead, unsafeUnverifiedOwner: true }
      )
      expect(a.planned.status === 'planned' ? a.planned.plan.notes.join('\n') : '').toContain(
        'owner absent'
      )
      // Presence from the same run: both sequences are there and end in their real last step.
      expect(plannedTags(stepsOf(remaining, ONE))).toEqual(['sync:op', 'rmdir', 'sync:st'])
      expect(plannedTags(stepsOf(remaining, ACROSS))).toEqual(['intent', 'sync:op', 'park'])
      // The syncs the plan names are the syncs the run made, with no temps and no owner.json too.
      expect(plannedTags(stepsOf(remaining, label === 'one device' ? ONE : ACROSS))).toEqual(
        observedTags(a.trace, st.opDir)
      )
      expect(remaining.join('\n')).not.toMatch(/owner\.json/)
      expect(observedTags(a.trace, st.opDir)).not.toContain('owner')
    })
  }

  it("the move-source intent a cross-device run writes names the op dir's own owner, not doctor's process", async () => {
    const st = await abortLeft('abortAfterCheck', {}, xfile())
    // An owner that cannot be mistaken for this process: another host, another pid.
    editOwner(st, { host: 'elsewhere.example', pid: process.pid + 1 })
    const own = JSON.parse(fs.readFileSync(path.join(st.opDir, 'owner.json'), 'utf8')) as {
      pid: number
      host: string
      uid: number
    }
    expect(own.host).not.toBe(os.hostname())
    await done(st, 'clean-staging', { ...dead, unsafeUnverifiedOwner: true })
    const intent = JSON.parse(
      fs.readFileSync(path.join(theParkedCopy(st.fx), 'park-intent.json'), 'utf8')
    ) as { kind: string; owner: { pid: number; host: string; uid: number } }
    expect(intent.kind).toBe('move-source')
    expect(intent.owner).toEqual({ pid: own.pid, host: own.host, uid: own.uid })
  })

  it('an owner.json owner the intent would refuse (pid 1.5) is not copied: the killed run leaves an intent that verifies, and the same command finishes the park', async () => {
    const st = await abortLeft('abortAfterCheck', {}, xfile())
    editOwner(st, { pid: 1.5 })
    const unsafe = { ...dead, unsafeUnverifiedOwner: true }
    const first = await act(st, 'clean-staging', unsafe, killAt('afterIntent'))
    expect(first.result.status).toBe('stopped')
    const cls = (await opReport(st, unsafe)).cls
    if (cls.kind !== 'no-record') throw new Error(`expected no-record, got ${cls.kind}`)
    expect(cls.intent).not.toBeNull()
    expect(cls.intent?.valid).toBe(true)
    // The intent names doctor's process, not the unusable pid.
    const intent = JSON.parse(fs.readFileSync(path.join(st.opDir, 'park-intent.json'), 'utf8')) as {
      owner: { pid: number }
    }
    expect(intent.owner.pid).toBe(process.pid)
    await done(st, 'clean-staging', unsafe)
    expect(fs.existsSync(st.opDir)).toBe(false)
    expect(fs.readdirSync(theParkedCopy(st.fx)).sort()).toEqual(['new', 'park-intent.json'])
  })

  const POINTS: SwapHookPoint[] = [
    'afterBackupCopy',
    'afterBackupVerify',
    'afterBackupMove',
    'afterIntentTemp',
    'afterIntent',
    'afterOwnerUnlink',
    'beforePark',
  ]
  for (const point of POINTS) {
    it(`killed at ${point}: the same command finishes; N kept once and parked; nothing lost`, async () => {
      const st = await abortLeft('abortAfterCheck', {}, xfile())
      const want = contentOf(path.join(st.opDir, 'new'))
      const before = everything(st)
      const first = await act(st, 'clean-staging', dead, killAt(point))
      expect(first.result.status).toBe('stopped')
      nothingLost(before, everything(st))
      const ownerThere = fs.existsSync(path.join(st.opDir, 'owner.json'))
      await done(st, 'clean-staging', ownerThere ? dead : { ownerProbe: ALIVE })
      expect(fs.existsSync(st.opDir)).toBe(false)
      expect(contentOf(keptAt(st.fx, 'unrecorded-new'))).toEqual(want)
      const parked = theParkedCopy(st.fx)
      expect(fs.readdirSync(parked).sort()).toEqual(['new', 'park-intent.json'])
      expect(contentOf(path.join(parked, 'new'))).toEqual(want)
      // Exactly one kept tree in the area (no second keep of N).
      const trees = fs
        .readdirSync(areaOf(st.fx))
        .filter(
          (n) => !n.endsWith('.json') && fs.lstatSync(path.join(areaOf(st.fx), n)).isDirectory()
        )
      expect(trees).toEqual([`${OP_ID}.unrecorded-new`])
      nothingLost(before, everything(st))
    })
  }
})

describe('T-PI2 (move-source half): a doctor cross-device finish killed after its record went', () => {
  it('--clean-staging finishes its park from the intent, as --apply would', async () => {
    const st = await xs3({ hooks: { afterBackupMove: () => killed('afterBackupMove') } })
    const first = await act(st, 'apply', {}, killAt('afterRecordUnlink'))
    expect(first.result.status).toBe('done')
    expect(opNames(st)).toEqual(['old', 'park-intent.json'])
    const a = await done(st, 'clean-staging', { ownerProbe: ALIVE })
    const parked = theParkedCopy(st.fx)
    expect(a.result.extraCopy).toBe(parked)
    expect(fs.readdirSync(parked).sort()).toEqual(['old', 'park-intent.json'])
    expect(hashOf(path.join(parked, 'old'))).toBe(st.p.input.preTree)
    expect(a.result.warnings).toEqual([])
  })
})
