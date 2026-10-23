/**
 * SMI-6531 (A1 step 4b): T-X14's swap half, and T-PI2's kill points. A child
 * process aborts before rename 1 and is SIGKILLed at each point of abort
 * cleanup; the test then asserts the state left on disk is one doctor (step 6)
 * can resume, as the plan's "Kill during cleanup" list names it:
 *
 *  - before the intent is durable, `owner.json` is still there;
 *  - once it is durable, `park-intent.json` verifies (with or without
 *    `owner.json`);
 *  - after the park's rename, the parked op dir, with or without its sidecar
 *    and index line;
 *  - during a keep, its sidecar names a tree that still exists (no sidecar
 *    without its tree);
 *  - and everywhere, nothing removed: N's bytes are intact wherever N is.
 *
 * Doctor running against these states is step 6's half.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { bindIdentity } from '../../../src/install/park-tree.identity.js'
import { isParkIntentFor } from '../../../src/services/skill-swap.intent.js'
import { recordIdentity } from '../../../src/services/skill-swap.staging.js'
import { contentOf, indexLines, parkedOpArea } from './skill-swap.abort.helpers.js'
import { CHILD_TEST_TIMEOUT_MS, mapLimit, spawnChild } from './skill-swap.child.helpers.js'
import { areaOf, makeFixture, OP_ID, tmp, useTmpCleanup } from './skill-swap.helpers.js'
import type { Fixture } from './skill-swap.helpers.js'

useTmpCleanup()

const FILES = { 'SKILL.md': '# v1\n', 'a.txt': 'a\n', 'sub/b.txt': 'b\n' }

type Point =
  | 'abortAfterCheck'
  | 'abortAfterCompare'
  | 'afterSidecar'
  | 'afterRecordUnlink'
  | 'afterIntentTemp'
  | 'afterIntent'
  | 'afterOwnerUnlink'
  | 'parkRenameBefore'
  | 'parkRenameAfter'
  | 'parkSidecarAfter'
  | 'afterPark'
/** Kill children run this many at a time: each compiles TypeScript at startup (CPU burst). */
const KILL_CONCURRENCY = 2
const FS_POINTS = new Set(['parkRenameBefore', 'parkRenameAfter', 'parkSidecarAfter'])

interface Killed {
  fx: Fixture
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

async function killAt(abortAt: string, point: Point, editN: boolean): Promise<Killed> {
  const fx = makeFixture(FILES)
  const cfgPath = path.join(tmp('skill-swap-cfg-'), 'cfg.json')
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({
      skillsDir: fx.skillsDir,
      stateRoot: fx.stateRoot,
      dirName: fx.dirName,
      opId: OP_ID,
      abortAt,
      editN,
      ...(FS_POINTS.has(point) ? { killFs: point } : { killAt: point }),
      writeSet: [{ rel: 'SKILL.md', kind: 'modify', text: '# v2\n' }],
    })
  )
  const child = spawnChild(['kill', cfgPath])
  await child.exited
  return {
    fx,
    signal: child.exit()?.signal ?? null,
    stdout: child.stdout(),
    stderr: child.stderr(),
  }
}

/** N's expected bytes: the copy, the write set unless the build failed first, the edit. */
function expectedN(abortAt: string, editN: boolean): Record<string, string> {
  return {
    'SKILL.md': abortAt === 'build' ? '# v1\n' : '# v2\n',
    'a.txt': editN ? 'a\nedited in N\n' : 'a\n',
    'sub/': 'dir',
    'sub/b.txt': 'b\n',
  }
}

const has = (p: string) => fs.existsSync(p)
const OPF = (fx: Fixture, n: string) => path.join(fx.opDir, n)

function intentVerifies(fx: Fixture, where: string): boolean {
  const id = bindIdentity(where)
  if (!id.ok) return false
  const intent = JSON.parse(fs.readFileSync(path.join(where, 'park-intent.json'), 'utf8'))
  return isParkIntentFor(intent, OP_ID, recordIdentity(id))
}

/** The parked copy, if the park's rename ran. */
function parkedCopyOrNull(fx: Fixture): string | null {
  const area = parkedOpArea(fx)
  if (!has(area)) return null
  const trees = fs.readdirSync(area).filter((n) => !n.endsWith('.json'))
  expect(trees.length).toBeLessThanOrEqual(1)
  return trees.length === 1 ? path.join(area, trees[0]!) : null
}

/** No sidecar in the backup area without its tree at its dest or (not yet moved) in OP. */
function noOrphanSidecar(fx: Fixture): void {
  const area = areaOf(fx)
  if (!has(area)) return
  for (const n of fs.readdirSync(area).filter((x) => x.endsWith('.json'))) {
    const dest = path.join(area, n.slice(0, -'.json'.length))
    const sidecar = JSON.parse(fs.readFileSync(path.join(area, n), 'utf8'))
    const where = has(dest) ? dest : OPF(fx, 'new')
    const id = bindIdentity(where)
    expect(id.ok).toBe(true)
    if (id.ok) expect(recordIdentity(id)).toEqual(sidecar.identity)
  }
}

/** The state doctor reads at `point` of a park-path abort. */
function assertParkPathState(k: Killed, abortAt: string, point: Point): void {
  const { fx } = k
  expect(k.signal, `child stderr: ${k.stderr}`).toBe('SIGKILL')
  expect(k.stdout).toBe('')
  const want = expectedN(abortAt, false)
  const copy = parkedCopyOrNull(fx)
  const moved = point === 'parkRenameAfter' || point === 'parkSidecarAfter' || point === 'afterPark'
  if (moved) {
    expect(copy).not.toBeNull()
    expect(has(fx.opDir)).toBe(false)
    expect(fs.readdirSync(copy!).sort()).toEqual(['new', 'park-intent.json'])
    expect(contentOf(path.join(copy!, 'new'))).toEqual(want)
    expect(intentVerifies(fx, copy!)).toBe(true)
    expect(has(`${copy}.json`)).toBe(point !== 'parkRenameAfter')
    expect(indexLines(fx).length).toBe(point === 'afterPark' ? 1 : 0)
    return
  }
  expect(copy).toBeNull()
  expect(contentOf(OPF(fx, 'new'))).toEqual(want)
  const durable = ['afterIntent', 'afterOwnerUnlink', 'parkRenameBefore'].includes(point)
  const ownerGone = point === 'afterOwnerUnlink' || point === 'parkRenameBefore'
  const recordGone = point !== 'abortAfterCheck' && point !== 'abortAfterCompare'
  expect(has(OPF(fx, 'record.json'))).toBe(abortAt === 'step6' && !recordGone)
  expect(has(OPF(fx, 'owner.json'))).toBe(!ownerGone)
  expect(has(OPF(fx, 'park-intent.json'))).toBe(durable)
  expect(has(OPF(fx, 'park-intent.json.tmp'))).toBe(point === 'afterIntentTemp')
  if (durable) expect(intentVerifies(fx, fx.opDir)).toBe(true)
  // Before the intent is durable, owner.json is there (same-host dead pid: --clean-staging).
  if (!durable) expect(has(OPF(fx, 'owner.json'))).toBe(true)
}

describe('T-X14 (swap half): a kill at each point of a park-path cleanup leaves a resumable state', () => {
  const POINTS: Point[] = [
    'abortAfterCheck',
    'abortAfterCompare',
    'afterRecordUnlink',
    'afterIntentTemp',
    'afterIntent',
    'afterOwnerUnlink',
    'parkRenameBefore',
    'parkRenameAfter',
    'parkSidecarAfter',
    'afterPark',
  ]
  for (const abortAt of ['step4', 'step6'] as const) {
    it(
      `abort at ${abortAt}: every kill point`,
      async () => {
        // `afterRecordUnlink` needs a record; at step 4 there is none, so the run passes it.
        const points = POINTS.filter((p) => abortAt === 'step6' || p !== 'afterRecordUnlink')
        const runs = await mapLimit(points, KILL_CONCURRENCY, (p) => killAt(abortAt, p, false))
        runs.forEach((k, i) => {
          const point = points[i]!
          try {
            assertParkPathState(k, abortAt, point)
            noOrphanSidecar(k.fx)
          } catch (err) {
            throw new Error(`kill at ${point}: ${(err as Error).message}`, { cause: err })
          }
        })
      },
      CHILD_TEST_TIMEOUT_MS
    )
  }
})

describe('T-X14 (swap half): a kill during a keep leaves its sidecar with its tree', () => {
  const cases: Array<[string, boolean, string, Point[]]> = [
    ['build', false, 'failed-build', ['abortAfterCheck', 'afterSidecar', 'afterOwnerUnlink']],
    [
      'step4',
      true,
      'edited-new',
      ['abortAfterCheck', 'abortAfterCompare', 'afterSidecar', 'afterOwnerUnlink'],
    ],
  ]
  for (const [abortAt, editN, kind, points] of cases) {
    it(
      `${kind} (abort at ${abortAt}${editN ? ', N edited' : ''}): every kill point`,
      async () => {
        const runs = await mapLimit(points, KILL_CONCURRENCY, (p) => killAt(abortAt, p, editN))
        runs.forEach((k, i) => {
          const point = points[i]!
          try {
            expect(k.signal, `child stderr: ${k.stderr}`).toBe('SIGKILL')
            const { fx } = k
            const dest = path.join(areaOf(fx), `${OP_ID}.${kind}`)
            const want = expectedN(abortAt, editN)
            const moved = point === 'afterOwnerUnlink'
            expect(contentOf(moved ? dest : OPF(fx, 'new'))).toEqual(want)
            expect(has(`${dest}.json`)).toBe(point === 'afterSidecar' || moved)
            // No intent: nothing is left in OP to park once N is kept.
            expect(has(OPF(fx, 'park-intent.json'))).toBe(false)
            expect(has(OPF(fx, 'owner.json'))).toBe(!moved)
            noOrphanSidecar(fx)
          } catch (err) {
            throw new Error(`kill at ${point}: ${(err as Error).message}`, { cause: err })
          }
        })
      },
      CHILD_TEST_TIMEOUT_MS
    )
  }
})
