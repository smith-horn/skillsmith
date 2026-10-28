/**
 * SMI-6531 (#3202 retro, round 2): no path writes a park intent the reader
 * would refuse. The reader reads `park-intent.json` with `intentCap()` and
 * refuses a read that fills it; nothing bounded what was written. Two ways
 * past the cap, each proven with a real fixture across devices (`/dev/shm`):
 *
 *  - a long `host` copied from `owner.json` (which has its own, smaller-in-effect
 *    cap): the intent then names doctor's own process, and verifies;
 *  - a state root so deep that even doctor's own intent reaches the cap: each
 *    writer refuses `staging-unsafe` before its first mutation.
 *
 * Plus the classifier's target of an intent under the state root `/`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bindIdentity } from '../../../../src/install/park-tree.identity.js'
import { intentTarget } from '../../../../src/services/skill-recovery.opdir.js'
import { rootKeyOf } from '../../../../src/services/skill-swap.area.js'
import { setIntentCapForTest } from '../../../../src/services/skill-swap.intent-schema.js'
import { jsonBytes, recordIdentity } from '../../../../src/services/skill-swap.staging.js'
import { refusedOf } from '../skill-swap.abort.helpers.js'
import { abortAt } from '../skill-swap.abort.triggers.js'
import {
  areaOf,
  makeFixture,
  modify,
  OP_ID,
  plan,
  run,
  useTmpCleanup,
} from '../skill-swap.helpers.js'
import type { Fixture } from '../skill-swap.helpers.js'
import { useOtherDeviceCleanup } from '../skill-swap.xdev.helpers.js'
import { planRecovery } from '../../../../src/services/skill-recovery.target.js'
import { act, contentSnapshot, done, killAt, requestOf } from './recovery.act.helpers.js'
import { opReport } from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'
import { abortLeft, dead, editOwner, FILES, keptAt } from './recovery.clean.helpers.js'
import { killed, theParkedCopy, xfile, xs3 } from './recovery.xdev.helpers.js'

useTmpCleanup()
useOtherDeviceCleanup()

/**
 * The default cap is 64 KiB (SMI-7205), which no real path reaches. The
 * refusals below are proven at the cap the seam lowers for the writer and the
 * reader together; the last describe runs at the default.
 */
const INTENT_CAP = 4096
beforeEach(() => setIntentCapForTest(INTENT_CAP))
afterEach(() => setIntentCapForTest(null))

const unsafe = { ...dead, unsafeUnverifiedOwner: true }

/** Everything an action could touch: the skills root, the state root, the journal's base. */
const world = (st: State): string => contentSnapshot(st.fx.skillsDir, st.fx.stateRoot, st.fx.base)

/** `fx` (by default `xfile()`, across devices) with its state root moved `len` characters deep (components of at most 200). */
function deepXfile(len: number, fx: Fixture = xfile()): Fixture {
  let p = fx.stateRoot
  while (p.length < len)
    p = path.join(p, 'd'.repeat(Math.min(200, Math.max(1, len - p.length - 1))))
  fs.mkdirSync(p, { recursive: true })
  return { ...fx, stateRoot: p }
}

/** The bytes of the move-source intent naming `backupPath`, with this process as owner, as the writer serializes it. */
function intentSize(opDir: string, backupPath: string): number {
  const id = bindIdentity(opDir)
  if (!id.ok) throw new Error(`${opDir} cannot be bound`)
  return jsonBytes({
    schema: 1,
    opId: OP_ID,
    owner: { pid: process.pid, host: os.hostname(), uid: process.geteuid?.() ?? -1 },
    opIdentity: recordIdentity(id),
    kind: 'move-source',
    backupPath,
  }).length
}

/** A state root deep enough that the intent passes the cap, with `owner.json` still under its own. */
const DEEP = 3790

/**
 * The update now refuses such a root before it makes OP; an update from before
 * that precheck could still leave one, which is what doctor's and abort
 * cleanup's own prechecks exist for. This seam stands for that older update.
 */
const OLDER = { skipIntentPrecheck: true }

/** The precheck's own words: the worst case's size, "could be up to". */
const COULD_BE =
  /^the park intent could be up to \d+ bytes, at or over the reader's 4096-byte cap; /

/** `--clean-staging`'s suffix: what is true, and the remedy (pinned word for word). */
const CLEAN_TAIL =
  '; nothing was changed; run this command again with `--state-root` naming a state directory with a shorter path (the kept copy then goes there, in the client-`none` layout)'

/** `--apply`/`--undo`'s suffix: no `--state-root` shortens a recorded op's area. */
const APPLY_TAIL =
  "; nothing was changed; this op's record fixes its backup area under the state root its update used, so `--state-root` does not shorten it; no command in this version finishes it"

/** A deep root on the skills root's own device (asserted), so every keep is a rename. */
function deepOneDevice(): Fixture {
  const fx = deepXfile(DEEP, makeFixture(FILES))
  expect(fs.statSync(fx.stateRoot).dev).toBe(fs.statSync(fx.skillsDir).dev)
  return fx
}

describe('a long owner.json host: the intent names doctor instead, and verifies', () => {
  it('--clean-staging killed after its intent leaves one that verifies; the same command finishes', async () => {
    const st = await abortLeft('abortAfterCheck', {}, xfile())
    const host = 'h'.repeat(3750)
    editOwner(st, { host, pid: process.pid, uid: process.geteuid?.() ?? -1 })
    // The precondition the defect needs: owner.json still reads (under its own cap) ...
    expect(fs.statSync(path.join(st.opDir, 'owner.json')).size).toBeLessThan(4096)
    const first = await act(st, 'clean-staging', unsafe, killAt('afterIntent'))
    expect(first.result.status).toBe('stopped')
    const cls = (await opReport(st, unsafe)).cls
    if (cls.kind !== 'no-record') throw new Error(`expected no-record, got ${cls.kind}`)
    expect(cls.intent).not.toBeNull()
    expect(cls.intent?.valid).toBe(true)
    const written = fs.readFileSync(path.join(st.opDir, 'park-intent.json'), 'utf8')
    const intent = JSON.parse(written) as { owner: { host: string; pid: number } }
    expect(intent.owner).toMatchObject({ host: os.hostname(), pid: process.pid })
    // ... and the copied owner's intent would have reached the reader's cap.
    const copied = { ...intent, owner: { ...intent.owner, host } }
    expect(jsonBytes(copied).length).toBeGreaterThanOrEqual(INTENT_CAP)
    await done(st, 'clean-staging', unsafe)
    expect(fs.existsSync(st.opDir)).toBe(false)
    expect(fs.readdirSync(theParkedCopy(st.fx)).sort()).toEqual(['new', 'park-intent.json'])
  })
})

describe('a state root so deep that even doctor’s intent reaches the cap: refused before any mutation', () => {
  it('--clean-staging across devices refuses staging-unsafe with nothing kept, unlinked or written', async () => {
    const st = await abortLeft('abortAfterCheck', { swap: OLDER }, deepXfile(DEEP))
    // Preconditions: owner.json reads, and the exact intent (doctor's owner, the real dest) reaches the cap.
    expect(fs.statSync(path.join(st.opDir, 'owner.json')).size).toBeLessThan(4096)
    expect(intentSize(st.opDir, keptAt(st.fx, 'unrecorded-new'))).toBeGreaterThanOrEqual(INTENT_CAP)
    const names = fs.readdirSync(st.opDir).sort()
    expect(names).toEqual(['new', 'owner.json'])
    const before = world(st)
    const a = await act(st, 'clean-staging', dead)
    expect(a.planned.status).toBe('planned')
    expect(a.result).toMatchObject({ status: 'refused', reason: 'staging-unsafe' })
    const detail = (a.result as { detail: string }).detail
    expect(detail).toMatch(COULD_BE)
    expect(detail.endsWith(CLEAN_TAIL)).toBe(true)
    expect(world(st)).toBe(before)
    expect(fs.readdirSync(st.opDir).sort()).toEqual(names)
    // The remedy is true: with a shorter --state-root the same command keeps N there.
    const short = fs.mkdtempSync(path.join(st.fx.base, 's-'))
    const a2 = await done(st, 'clean-staging', { ...dead, stateRoots: [fs.realpathSync(short)] })
    expect(
      a2.result.kept[0]!.path.startsWith(`${fs.realpathSync(short)}/backups/update/none/`)
    ).toBe(true)
  })

  it('--apply of a recorded op across devices refuses staging-unsafe before its keep copies anything', async () => {
    const st = await xs3(
      { ...OLDER, hooks: { afterSidecar: () => killed('afterSidecar') } },
      deepXfile(DEEP)
    )
    const backup = path.join(areaOf(st.fx), OP_ID)
    expect(intentSize(st.opDir, backup)).toBeGreaterThanOrEqual(INTENT_CAP)
    // The keep would copy: nothing of O is in the area yet but its sidecar.
    expect(fs.existsSync(backup)).toBe(false)
    expect(fs.existsSync(`${backup}.json`)).toBe(true)
    const before = world(st)
    const a = await act(st, 'apply')
    expect(a.planned.status).toBe('planned')
    expect(a.result).toMatchObject({ status: 'refused', reason: 'staging-unsafe' })
    const detail = (a.result as { detail: string }).detail
    expect(detail).toMatch(COULD_BE)
    expect(detail.endsWith(APPLY_TAIL)).toBe(true)
    expect(world(st)).toBe(before)
    expect(fs.existsSync(path.join(st.opDir, 'record.json'))).toBe(true)
  })
})

describe('the same deep root on ONE device: doctor still refuses whenever it keeps a tree', () => {
  it('--apply keeping O (a rename here) refuses staging-unsafe with zero mutation', async () => {
    const st = await xs3(
      { ...OLDER, hooks: { afterSidecar: () => killed('afterSidecar') } },
      deepOneDevice()
    )
    const before = world(st)
    const a = await act(st, 'apply')
    expect(a.planned.status).toBe('planned')
    expect(a.result).toMatchObject({ status: 'refused', reason: 'staging-unsafe' })
    expect((a.result as { detail: string }).detail).toMatch(COULD_BE)
    expect(world(st)).toBe(before)
  })

  it('--clean-staging keeping new/ (a rename here) refuses staging-unsafe with zero mutation', async () => {
    const st = await abortLeft('abortAfterCheck', { swap: OLDER }, deepOneDevice())
    const before = world(st)
    const a = await act(st, 'clean-staging', dead)
    expect(a.planned.status).toBe('planned')
    expect(a.result).toMatchObject({ status: 'refused', reason: 'staging-unsafe' })
    expect((a.result as { detail: string }).detail.endsWith(CLEAN_TAIL)).toBe(true)
    expect(world(st)).toBe(before)
  })

  it('abort cleanup keeping an edited N (a rename here) ends left with stopped/staging-unsafe, nothing changed', async () => {
    const fx = deepOneDevice()
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    let atCheck: string | null = null
    const snap = (): string => contentSnapshot(fx.skillsDir, fx.stateRoot, fx.base)
    const t = abortAt(fx, 'step4', {
      abortAfterCheck: () => {
        fs.appendFileSync(path.join(fx.opDir, 'new', 'a.txt'), 'edited in N\n')
        atCheck = snap()
      },
    })
    let r: Awaited<ReturnType<typeof run>>
    try {
      r = await run(p, { ...t.options, ...OLDER })
    } finally {
      t.restore()
    }
    expect(refusedOf(r.result).staged).toBe('left')
    expect(snap()).toBe(atCheck)
  })

  it('control: a normal-depth root on one device still applies', async () => {
    const fx = makeFixture(FILES)
    expect(fs.statSync(fx.stateRoot).dev).toBe(fs.statSync(fx.skillsDir).dev)
    const st = await xs3({ hooks: { afterSidecar: () => killed('afterSidecar') } }, fx)
    const a = await done(st, 'apply')
    expect(fs.existsSync(path.join(areaOf(fx), OP_ID))).toBe(true)
    expect(a.result.status).toBe('done')
  })
})

describe('the update’s abort cleanup with that state root: an edited N kept across devices, then parked', () => {
  it('ends left with stopped/staging-unsafe before the keep copies N, nothing changed after its check', async () => {
    const fx = deepXfile(DEEP)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    let atCheck: string | null = null
    const snap = (): string => contentSnapshot(fx.skillsDir, fx.stateRoot, fx.base)
    // Edited, so cleanup keeps N (a cross-device copy) and then parks its source behind the intent.
    const t = abortAt(fx, 'step4', {
      abortAfterCheck: () => {
        fs.appendFileSync(path.join(fx.opDir, 'new', 'a.txt'), 'edited in N\n')
        atCheck = snap()
      },
    })
    let r: Awaited<ReturnType<typeof run>>
    try {
      r = await run(p, { ...t.options, ...OLDER })
    } finally {
      t.restore()
    }
    const left = refusedOf(r.result)
    expect(left.staged).toBe('left')
    const w = left.warnings.find((x) => x.code === 'removal-not-done')
    expect(w).toMatchObject({ path: fx.opDir, status: 'stopped', reason: 'staging-unsafe' })
    const d = (w?.code === 'removal-not-done' ? w.detail : undefined) ?? ''
    expect(d).toMatch(COULD_BE)
    expect(d.endsWith('; abort cleanup changed nothing')).toBe(true)
    expect(atCheck).not.toBeNull()
    expect(snap()).toBe(atCheck)
    expect(fs.readdirSync(fx.opDir).sort()).toEqual(['new', 'owner.json'])
  })
})

describe('SMI-7205: at the default cap a deep state root no longer strands a recorded op', () => {
  beforeEach(() => setIntentCapForTest(null))

  it('--apply across devices finishes it; the intent written is over 4096 bytes and reads back valid', async () => {
    // No OLDER seam: the update's own precheck now accepts this root too.
    const st = await xs3({ hooks: { afterSidecar: () => killed('afterSidecar') } }, deepXfile(DEEP))
    const backup = path.join(areaOf(st.fx), OP_ID)
    expect(intentSize(st.opDir, backup)).toBeGreaterThanOrEqual(INTENT_CAP)
    // Stopped right after the record unlink: only the intent says what is left to do.
    const first = await act(st, 'apply', {}, killAt('afterRecordUnlink'))
    expect(first.result.status).toBe('done')
    const intentFile = path.join(st.opDir, 'park-intent.json')
    expect(fs.statSync(intentFile).size).toBeGreaterThanOrEqual(INTENT_CAP)
    const cls = (await opReport(st)).cls
    if (cls.kind !== 'no-record') throw new Error(`expected no-record, got ${cls.kind}`)
    expect(cls.intent?.valid).toBe(true)
    expect(cls.intent?.blocked).toBeNull()
    // A temp linked to that big intent is provable too (its read follows the same cap).
    const tmp = `${intentFile}.tmp`
    fs.linkSync(intentFile, tmp)
    const planned = await planRecovery(requestOf(st, 'apply'))
    expect(planned.status).toBe('planned')
    if (planned.status === 'planned') {
      expect(planned.plan.remaining).toContain(`unlink the metadata temp ${tmp}`)
    }
    // The same command finishes the park from that intent.
    const last = await done(st, 'apply')
    expect(fs.existsSync(tmp)).toBe(false)
    expect(last.result.status).toBe('done')
    expect(fs.existsSync(st.opDir)).toBe(false)
    expect(fs.existsSync(path.join(theParkedCopy(st.fx), 'park-intent.json'))).toBe(true)
  })

  it('a big intent BESIDE record.json (a finish killed after its intent, before the record unlink) classifies valid and the same command finishes it', async () => {
    const st = await xs3({ hooks: { afterSidecar: () => killed('afterSidecar') } }, deepXfile(DEEP))
    const backup = path.join(areaOf(st.fx), OP_ID)
    expect(intentSize(st.opDir, backup)).toBeGreaterThanOrEqual(INTENT_CAP)
    // Stopped once park-intent.json is durable and record.json is still there.
    const first = await act(st, 'apply', {}, killAt('afterIntent'))
    expect(first.result.status).toBe('stopped')
    const recordFile = path.join(st.opDir, 'record.json')
    const intentFile = path.join(st.opDir, 'park-intent.json')
    expect(fs.existsSync(recordFile)).toBe(true)
    expect(fs.statSync(intentFile).size).toBeGreaterThanOrEqual(INTENT_CAP)
    // The classifier reads it beside the record (analyzeParkIntent) at the default cap, not 4096.
    const cls = (await opReport(st)).cls
    expect(cls.kind, JSON.stringify(cls).slice(0, 600)).not.toBe('no-record')
    const facts = (cls as { facts?: { parkIntent: { valid: boolean } | null } }).facts
    expect(facts?.parkIntent).not.toBeNull()
    expect(facts?.parkIntent?.valid).toBe(true)
    // The same command finishes it from that intent: parked, nothing lost.
    const last = await done(st, 'apply')
    expect(last.result.status).toBe('done')
    expect(fs.existsSync(st.opDir)).toBe(false)
    expect(fs.existsSync(path.join(theParkedCopy(st.fx), 'park-intent.json'))).toBe(true)
    expect(fs.existsSync(path.join(areaOf(st.fx), OP_ID))).toBe(true)
  })
})

describe('intentTarget under the state root /', () => {
  it('derives the state root / (not the empty string), so the intent is not blocked', () => {
    const root = '/srv/skills'
    const backupPath = `/backups/update/claude-code/${rootKeyOf(root)}/my-skill/${OP_ID}.unrecorded-new`
    expect(intentTarget(backupPath, root, OP_ID)).toEqual({
      stateRoot: '/',
      client: 'claude-code',
      dirName: 'my-skill',
    })
  })

  it('still derives a deeper state root, and refuses a path with no state root at all', () => {
    const root = '/srv/skills'
    const key = rootKeyOf(root)
    const deep = `/var/state/backups/update/claude-code/${key}/my-skill/${OP_ID}`
    expect(intentTarget(deep, root, OP_ID)).toMatchObject({ stateRoot: '/var/state' })
    expect(intentTarget(`backups/update/claude-code/${key}/my-skill/${OP_ID}`, root, OP_ID)).toBe(
      null
    )
  })
})
