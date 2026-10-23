/**
 * SMI-6531 (A1 step 4c): T-X8's kill half. A child process runs an update with
 * the state root on another device (a real `EXDEV`) and is SIGKILLed at each
 * boundary of the cross-device `publishTree` and of the op dir's park:
 *
 *  - publishTree: the sidecar temp written (P0), the sidecar published (P1),
 *    mid-copy (P2), the copy synced (P3), the copy verified (P3), the temp
 *    renamed to `dest` (P4);
 *  - step 13: the intent durable, the record unlinked, the owner unlinked, and
 *    in the park, before its rename, after it, after its sidecar, after its
 *    index line.
 *
 * Each must leave a publish sub-state (A1 plan §3.3 table) or a §3.3 park
 * state, with the record kept wherever the backup is not yet complete, the old
 * folder's bytes intact wherever it is, and no fs delete of a tree entry (the
 * child logs every delete call's path before it runs). Doctor's `--apply`
 * finish is step 6; this asserts the on-disk state it will read.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { bindIdentity } from '../../../src/install/park-tree.identity.js'
import { isParkIntentFor } from '../../../src/services/skill-swap.intent.js'
import { recordIdentity } from '../../../src/services/skill-swap.staging.js'
import { indexLines } from './skill-swap.abort.helpers.js'
import { CHILD_TEST_TIMEOUT_MS, mapLimit, spawnChild } from './skill-swap.child.helpers.js'
import {
  areaOf,
  hashOf,
  makeFixture,
  OP_ID,
  readRecord,
  tmp,
  useTmpCleanup,
} from './skill-swap.helpers.js'
import type { Fixture } from './skill-swap.helpers.js'
import { otherDevice, parkedCopies, useOtherDeviceCleanup } from './skill-swap.xdev.helpers.js'

useTmpCleanup()
useOtherDeviceCleanup()

const FILES = { 'SKILL.md': '# v1\n', 'a.txt': 'a\n', 'sub/b.txt': 'b\n' }

type State =
  | 'P0'
  | 'P1'
  | 'P2'
  | 'P3'
  | 'P4'
  | 'intent, record and owner'
  | 'intent and owner'
  | 'intent, ownerless'
  | 'parked, no sidecar'
  | 'parked, no index line'
  | 'parked'

interface Point {
  name: string
  cfg: Record<string, unknown>
  want: State
}

const POINTS: Point[] = [
  { name: 'sidecar temp written', cfg: { killAt: 'afterSidecarTemp' }, want: 'P0' },
  { name: 'sidecar published', cfg: { killAt: 'afterSidecar' }, want: 'P1' },
  { name: 'mid-copy', cfg: { killMidCopy: true }, want: 'P2' },
  { name: 'copy synced', cfg: { killAt: 'afterBackupCopy' }, want: 'P3' },
  { name: 'copy verified', cfg: { killAt: 'afterBackupVerify' }, want: 'P3' },
  { name: 'temp renamed to dest', cfg: { killAt: 'afterBackupMove' }, want: 'P4' },
  { name: 'intent durable', cfg: { killAt: 'afterIntent' }, want: 'intent, record and owner' },
  { name: 'record unlinked', cfg: { killAt: 'afterRecordUnlink' }, want: 'intent and owner' },
  { name: 'owner unlinked', cfg: { killAt: 'afterOwnerUnlink' }, want: 'intent, ownerless' },
  {
    name: 'before the park rename',
    cfg: { killFs: 'parkRenameBefore' },
    want: 'intent, ownerless',
  },
  { name: 'after the park rename', cfg: { killFs: 'parkRenameAfter' }, want: 'parked, no sidecar' },
  {
    name: 'after the park sidecar',
    cfg: { killFs: 'parkSidecarAfter' },
    want: 'parked, no index line',
  },
  { name: 'after the index line', cfg: { killAt: 'afterPark' }, want: 'parked' },
]
const KILL_CONCURRENCY = 2

interface Killed {
  fx: Fixture
  pre: string
  signal: NodeJS.Signals | null
  stderr: string
  deletes: string[]
}

async function killAt(cfg: Record<string, unknown>): Promise<Killed> {
  const fx0 = makeFixture(FILES)
  const fx = { ...fx0, stateRoot: otherDevice() }
  const pre = hashOf(fx.realDir)
  const dir = tmp('skill-swap-cfg-')
  const deleteLog = path.join(dir, 'deletes.log')
  fs.writeFileSync(deleteLog, '')
  fs.writeFileSync(
    path.join(dir, 'cfg.json'),
    JSON.stringify({
      skillsDir: fx.skillsDir,
      stateRoot: fx.stateRoot,
      dirName: fx.dirName,
      opId: OP_ID,
      deleteLog,
      writeSet: [{ rel: 'SKILL.md', kind: 'modify', text: '# v2\n' }],
      ...cfg,
    })
  )
  const child = spawnChild(['kill', path.join(dir, 'cfg.json')])
  await child.exited
  const deletes = fs.readFileSync(deleteLog, 'utf8').split('\n').filter(Boolean)
  return { fx, pre, signal: child.exit()?.signal ?? null, stderr: child.stderr(), deletes }
}

const has = (p: string) => fs.existsSync(p)

/** The intent at `where` verifies for this op, with kind `move-source`. */
function intentVerifies(where: string): boolean {
  const id = bindIdentity(where)
  if (!id.ok) return false
  const intent = JSON.parse(fs.readFileSync(path.join(where, 'park-intent.json'), 'utf8'))
  return intent.kind === 'move-source' && isParkIntentFor(intent, OP_ID, recordIdentity(id))
}

/** Which publish sub-state, or park state, the disk is in. Throws on anything else. */
function classify(fx: Fixture, pre: string): State {
  const area = areaOf(fx)
  const dest = path.join(area, OP_ID)
  const temp = path.join(area, `.tmp-${OP_ID}`)
  const src = path.join(fx.opDir, 'old')
  const sidecar = `${dest}.json`
  const op = (n: string) => path.join(fx.opDir, n)
  const copies = parkedCopies(fx)
  if (copies.length === 1) {
    // After the park's rename: OP gone, the parked copy holds the source and the intent.
    expect(has(fx.opDir)).toBe(false)
    const copy = copies[0]!
    expect(fs.readdirSync(copy).sort()).toEqual(['old', 'park-intent.json'])
    expect(intentVerifies(copy)).toBe(true)
    expect(hashOf(path.join(copy, 'old'))).toBe(pre)
    if (!has(`${copy}.json`)) return 'parked, no sidecar'
    return indexLines(fx).length === 1 ? 'parked' : 'parked, no index line'
  }
  expect(copies).toEqual([])
  expect(hashOf(src)).toBe(pre)
  if (!has(sidecar)) {
    expect(has(temp) || has(dest)).toBe(false)
    expect(has(`${sidecar}.tmp`)).toBe(true)
    return 'P0'
  }
  const side = JSON.parse(fs.readFileSync(sidecar, 'utf8'))
  const srcId = bindIdentity(src)
  expect(srcId.ok && side.identity.ino === srcId.ino.toString()).toBe(true)
  expect(side.treeHash).toBe(pre)
  if (has(temp)) {
    expect(has(dest)).toBe(false)
    let tempHash: string | null = null
    try {
      tempHash = hashOf(temp)
    } catch {
      tempHash = null
    }
    return tempHash === side.treeHash ? 'P3' : 'P2'
  }
  if (!has(dest)) return 'P1'
  expect(hashOf(dest)).toBe(side.treeHash)
  if (!has(op('park-intent.json'))) return 'P4'
  expect(intentVerifies(fx.opDir)).toBe(true)
  const meta = ['record.json', 'owner.json'].filter((n) => has(op(n)))
  expect(fs.readdirSync(fx.opDir).sort()).toEqual(['old', 'park-intent.json', ...meta].sort())
  if (meta.length === 2) return 'intent, record and owner'
  if (meta.length === 1 && meta[0] === 'owner.json') return 'intent and owner'
  expect(meta).toEqual([])
  return 'intent, ownerless'
}

/** The deletes a run may make: its metadata in OP, the backup sidecar temp, probes, lock files. */
function treeDeletesIn(fx: Fixture, deletes: string[]): string[] {
  const area = areaOf(fx)
  const allowed = new Set([
    ...[
      'owner.json',
      'owner.json.tmp',
      'record.json',
      'record.json.tmp',
      'park-intent.json.tmp',
    ].map((n) => path.join(fx.opDir, n)),
    path.join(area, `${OP_ID}.json.tmp`),
  ])
  return deletes.filter(
    (d) =>
      !allowed.has(d) &&
      !path.basename(d).startsWith('.skillsmith-probe-') &&
      !/\.lock(\.reclaim)?$/.test(d)
  )
}

describe('T-X8 (swap half): a kill at each cross-device boundary', () => {
  it(
    'every point leaves a publish sub-state or a park state, the record kept until P4 is past, nothing deleted',
    async () => {
      const killed = await mapLimit(POINTS, KILL_CONCURRENCY, async (pt) => ({
        pt,
        k: await killAt(pt.cfg),
      }))
      for (const { pt, k } of killed) {
        expect(k.signal, `${pt.name}: child stderr: ${k.stderr}`).toBe('SIGKILL')
        expect(classify(k.fx, k.pre), pt.name).toBe(pt.want)
        // The skill is at its new version from the commit on.
        expect(fs.readFileSync(path.join(k.fx.realDir, 'SKILL.md'), 'utf8')).toBe('# v2\n')
        // The record stays until the backup is complete (P4) and the intent is durable.
        const record = path.join(k.fx.opDir, 'record.json')
        const recordDue = ['P0', 'P1', 'P2', 'P3', 'P4', 'intent, record and owner'].includes(
          pt.want
        )
        expect(has(record), pt.name).toBe(recordDue)
        if (recordDue) readRecord(record)
        expect(treeDeletesIn(k.fx, k.deletes), pt.name).toEqual([])
        // The delete log works: a run past the record unlink logged that unlink.
        if (!recordDue) expect(k.deletes, pt.name).toContain(record)
      }
    },
    CHILD_TEST_TIMEOUT_MS * 3
  )
})
