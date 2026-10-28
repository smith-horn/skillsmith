/**
 * SMI-6531 (A1 step 6b-ii): what `--clean-staging` finishes after a kill
 * (design `step6b-design.md` § 1.2 crash points, § 6): T-X14's
 * `--clean-staging` halves (every abort cleanup kill point with no record
 * left, with and without an edit in N: a keep abort cleanup started resumes
 * with its own kind), T-PI2's `--clean-staging` half (an abort-new intent at
 * every point of its publish and the owner's unlink), T-X16's last clause (a
 * park that failed, finished once the cause is gone), and T-J14 for this
 * action (a kill at each of its own boundaries, then the same command).
 *
 * After every finish: no sidecar in the area without its tree, N's content
 * kept exactly once (in the area or in the parked op dir), the skill folder
 * and the manifest unchanged.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { recordIdentity } from '../../../../src/services/skill-swap.staging.js'
import { bindIdentity } from '../../../../src/install/park-tree.identity.js'
import { isParkIntentFor } from '../../../../src/services/skill-swap.intent.js'
import type { SwapHookPoint } from '../../../../src/services/skill-swap.js'
import { contentOf, indexLines, parkedCopy } from '../skill-swap.abort.helpers.js'
import {
  areaOf,
  hashOf,
  makeFixture,
  modify,
  OP_ID,
  plan,
  run,
  useTmpCleanup,
} from '../skill-swap.helpers.js'
import { act, contentSnapshot, done, killAt, removedBy } from './recovery.act.helpers.js'
import type { State } from './recovery.helpers.js'
import {
  abortLeft,
  ALIVE,
  dead,
  DEAD,
  EDIT,
  FILES,
  keptAt,
  opNames,
  sidecarAt,
} from './recovery.clean.helpers.js'

useTmpCleanup()

/** Every sidecar in the area has its tree at its name. */
function noOrphanSidecar(st: State): void {
  const area = areaOf(st.fx)
  if (!fs.existsSync(area)) return
  for (const n of fs.readdirSync(area).filter((x) => x.endsWith('.json'))) {
    expect(fs.existsSync(path.join(area, n.slice(0, -'.json'.length))), `${n} has its tree`).toBe(
      true
    )
  }
}

/** How many trees in the area or the parked op dir hold exactly `want`. */
function copiesOf(st: State, want: Record<string, string>): number {
  const area = areaOf(st.fx)
  const trees = fs.existsSync(area)
    ? fs
        .readdirSync(area)
        .map((n) => path.join(area, n))
        .filter((p) => fs.lstatSync(p).isDirectory())
    : []
  const parked = path.join(st.fx.staging, '.skillsmith-parked', OP_ID)
  if (fs.existsSync(parked)) {
    for (const c of fs.readdirSync(parked).filter((n) => !n.endsWith('.json'))) {
      trees.push(path.join(parked, c, 'new'))
    }
  }
  return trees.filter((t) => JSON.stringify(contentOf(t)) === JSON.stringify(want)).length
}

/** N's content while it is still in OP. */
const nOf = (st: State): Record<string, string> => contentOf(path.join(st.opDir, 'new'))

/** A real update whose build fails (abort cleanup keeps N as failed-build), its cleanup stopped at `stopAt`. */
async function buildFailLeft(stopAt: SwapHookPoint): Promise<State> {
  const fx = makeFixture(FILES)
  const p = plan(fx, [modify('SKILL.md', '# v2\n')])
  const kill = (w: string) => () => {
    throw new Error(`killed at ${w}`)
  }
  const r = await run(p, { hooks: { afterCopy: kill('afterCopy'), [stopAt]: kill(stopAt) } })
  expect(r.result).toMatchObject({ status: 'refused', staged: 'left' })
  return { fx, p, opId: OP_ID, opDir: fx.opDir }
}

describe('T-X14 (--clean-staging halves): every abort cleanup kill point with no record left', () => {
  const cases: Array<[string, () => Promise<State>, string]> = [
    ['abortAfterCheck', () => abortLeft('abortAfterCheck'), 'unrecorded-new'],
    ['abortAfterCompare', () => abortLeft('abortAfterCompare'), 'unrecorded-new'],
    [
      'abortAfterCheck, N edited',
      () => abortLeft('abortAfterCheck', { editN: true }),
      'unrecorded-new',
    ],
    // A keep abort cleanup started (its sidecar published, N not moved): it resumes with its own kind.
    [
      'afterSidecar, N edited (edited-new at P1)',
      () => abortLeft('afterSidecar', { editN: true }),
      'edited-new',
    ],
    [
      'afterSidecar of a failed build (failed-build at P1)',
      () => buildFailLeft('afterSidecar'),
      'failed-build',
    ],
    // A sidecar temp alone that parses as this op's (the classifier's R2): linked, then the move, with its kind.
    [
      'afterSidecarTemp, N edited (R2)',
      () => abortLeft('afterSidecarTemp', { editN: true }),
      'edited-new',
    ],
    [
      'beforeSidecar, N edited (nothing in the area yet)',
      () => abortLeft('beforeSidecar', { editN: true }),
      'unrecorded-new',
    ],
  ]
  for (const [label, make, kind] of cases) {
    it(`${label}: N kept as ${kind}, once; no sidecar without its tree`, async () => {
      const st = await make()
      expect(opNames(st)).toEqual(['new', 'owner.json'])
      const want = nOf(st)
      const t = contentOf(st.fx.realDir)
      const a = await done(st, 'clean-staging', dead)
      const dest = keptAt(st.fx, kind)
      expect(a.result.kept).toEqual([{ tree: 'N', kind, path: dest }])
      expect(contentOf(dest)).toEqual(want)
      expect(sidecarAt(dest)).toMatchObject({ kind, treeHash: hashOf(dest) })
      expect(copiesOf(st, want)).toBe(1)
      noOrphanSidecar(st)
      expect(fs.existsSync(st.opDir)).toBe(false)
      expect(contentOf(st.fx.realDir)).toEqual(t)
      expect(a.result.manifest).toBe('untouched')
      // Only metadata (owner.json, a provable sidecar temp) and the op dir were removed.
      for (const p of removedBy(a.trace)) {
        expect(p === st.opDir || p.endsWith('.json') || p.endsWith('.json.tmp'), p).toBe(true)
      }
      expect(removedBy(a.trace)).toContain(path.join(st.opDir, 'owner.json'))
    })
  }

  it("a kill after the abort's keep moved N (P5): nothing left to keep; only owner.json and OP go", async () => {
    const st = await abortLeft('afterPublishRename', { editN: true })
    expect(opNames(st)).toEqual(['owner.json'])
    const dest = keptAt(st.fx, 'edited-new')
    const want = contentOf(dest)
    const a = await done(st, 'clean-staging', dead)
    expect(a.result.kept).toEqual([])
    expect(removedBy(a.trace)).toEqual([path.join(st.opDir, 'owner.json'), st.opDir])
    expect(copiesOf(st, want)).toBe(1)
    noOrphanSidecar(st)
  })
})

describe('T-PI2 (--clean-staging half): an abort-new intent finishes without the flag', () => {
  const POINTS: Array<[string, SwapHookPoint, boolean]> = [
    ['after the intent is durable (owner.json still there, its owner dead)', 'afterIntent', false],
    ["after the intent's link, its temp still there (same inode)", 'afterIntent', true],
    ['after owner.json is unlinked', 'afterOwnerUnlink', false],
    ["before the park's rename", 'beforePark', false],
  ]
  for (const [label, point, linkTemp] of POINTS) {
    it(`${label}: OP parked whole with N and the intent; the guard hash covered it`, async () => {
      const st = await abortLeft(point)
      const intent = path.join(st.opDir, 'park-intent.json')
      if (linkTemp) fs.linkSync(intent, `${intent}.tmp`)
      const ownerThere = fs.existsSync(path.join(st.opDir, 'owner.json'))
      const want = nOf(st)
      const ino = fs.lstatSync(intent).ino
      // Without the flag: a dead owner when owner.json is there; none needed once it is gone.
      const a = await done(st, 'clean-staging', ownerThere ? dead : { ownerProbe: ALIVE })
      const copy = parkedCopy(st.fx)
      expect(a.result.kept).toEqual([{ tree: 'OP', kind: 'abort-new', path: copy }])
      expect(fs.readdirSync(copy).sort()).toEqual(['new', 'park-intent.json'])
      expect(fs.lstatSync(path.join(copy, 'park-intent.json')).ino).toBe(ino)
      expect(contentOf(path.join(copy, 'new'))).toEqual(want)
      const side = sidecarAt(copy)
      expect(side).toMatchObject({ kind: 'abort-new', client: 'claude-code' })
      expect(side.treeHash).toBe(hashOf(copy))
      expect(indexLines(st.fx)).toEqual([
        expect.objectContaining({ kind: 'abort-new', client: 'claude-code' }),
      ])
      const removed = removedBy(a.trace).filter((p) => p.startsWith(st.opDir))
      expect(removed).toEqual([
        ...(linkTemp ? [`${intent}.tmp`] : []),
        ...(ownerThere ? [path.join(st.opDir, 'owner.json')] : []),
      ])
      expect(copiesOf(st, want)).toBe(1)
    })
  }

  it('after the intent temp only (no intent yet): N kept as unrecorded-new, the provable temp unlinked', async () => {
    const st = await abortLeft('afterIntentTemp')
    expect(opNames(st)).toEqual(['new', 'owner.json', 'park-intent.json.tmp'])
    const want = nOf(st)
    const a = await done(st, 'clean-staging', dead)
    expect(a.result.kept.map((k) => k.kind)).toEqual(['unrecorded-new'])
    expect(removedBy(a.trace)).toEqual([
      `${keptAt(st.fx, 'unrecorded-new')}.json.tmp`,
      path.join(st.opDir, 'park-intent.json.tmp'),
      path.join(st.opDir, 'owner.json'),
      st.opDir,
    ])
    expect(copiesOf(st, want)).toBe(1)
  })

  const NEGATIVES: Array<[string, (st: State) => void]> = [
    ['no intent and no owner.json', (st) => fs.rmSync(path.join(st.opDir, 'park-intent.json'))],
    ['an intent for another opId', (st) => editIntent(st, { opId: 'b'.repeat(32) })],
    ['an invalid schema', (st) => editIntent(st, { schema: 3 })],
    [
      'OP replaced by a copy',
      (st) => {
        const aside = `${st.opDir}-aside`
        fs.renameSync(st.opDir, aside)
        fs.cpSync(aside, st.opDir, { recursive: true })
      },
    ],
  ]
  for (const [label, arrange] of NEGATIVES) {
    it(`${label}: refused without the flag, zero mutation`, async () => {
      const st = await abortLeft('afterOwnerUnlink')
      arrange(st)
      const before = contentSnapshot(st.fx.skillsDir, st.fx.stateRoot)
      const a = await act(st, 'clean-staging', { ownerProbe: DEAD })
      expect(a.result).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
      expect(contentSnapshot(st.fx.skillsDir, st.fx.stateRoot)).toBe(before)
    })
  }

  it('the control for the negatives: the same state, unarranged, is offered and parks', async () => {
    const st = await abortLeft('afterOwnerUnlink')
    const a = await done(st, 'clean-staging', { ownerProbe: DEAD })
    expect(a.result.kept.map((k) => k.kind)).toEqual(['abort-new'])
  })
})

/** Edits the intent's JSON in place (a new inode is fine: the plan reads it fresh). */
function editIntent(st: State, over: Record<string, unknown>): void {
  const f = path.join(st.opDir, 'park-intent.json')
  const v = JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, unknown>
  fs.writeFileSync(f, JSON.stringify({ ...v, ...over }, null, 2) + '\n')
}

describe('T-X16 (last clause): once the cause is removed, --clean-staging finishes the intended park', () => {
  const nulls = {
    reason: null,
    path: null,
    entry: null,
    treeHash: null,
    errno: null,
    opId: null,
    sidecarPath: null,
    detail: null,
    originPath: null,
    heldPath: null,
    misplaced: null,
    parkedAreaCreated: null,
  }
  const FAILURES = [
    { status: 'stopped', reason: 'park-failed', detail: 'trash-unusable' },
    { status: 'stopped', reason: 'park-failed', errno: 'EROFS' },
    { status: 'stopped', reason: 'park-failed', errno: 'EACCES' },
    { status: 'stopped', reason: 'park-failed', errno: 'EACCES', detail: 'at rename(2)' },
    { status: 'kept', reason: 'mount-inside-tree' },
  ] as const
  for (const f of FAILURES) {
    it(`${f.status}/${f.reason}${'errno' in f ? ` (${f.errno})` : ''}: the parked copy holds N and the intent`, async () => {
      const st = await abortLeft(null, {
        swap: { park: async () => ({ ...nulls, ...f }) as never },
      })
      expect(opNames(st)).toEqual(['new', 'park-intent.json'])
      const id = bindIdentity(st.opDir)
      expect(
        id.ok &&
          isParkIntentFor(
            JSON.parse(fs.readFileSync(path.join(st.opDir, 'park-intent.json'), 'utf8')),
            OP_ID,
            recordIdentity(id)
          )
      ).toBe(true)
      const want = nOf(st)
      const a = await done(st, 'clean-staging', { ownerProbe: ALIVE })
      const copy = parkedCopy(st.fx)
      expect(a.result.kept).toEqual([{ tree: 'OP', kind: 'abort-new', path: copy }])
      expect(contentOf(path.join(copy, 'new'))).toEqual(want)
      // The intended park, not a fresh keep: nothing went to the backup area.
      expect(fs.existsSync(keptAt(st.fx, 'unrecorded-new'))).toBe(false)
      expect(a.result.warnings).toEqual([])
    })
  }
})

describe("T-J14 (--clean-staging): a kill at each of the action's own boundaries, then the same command", () => {
  const POINTS: SwapHookPoint[] = [
    'beforePublish',
    'beforeSidecar',
    'afterSidecarTemp',
    'afterSidecar',
    'afterPublishRename',
    'afterPublishAreaSync',
    'afterPublishOpSync',
    'beforeMetadataCleanup',
    'afterOwnerUnlink',
    'afterRecoveredOpSync',
  ]
  for (const point of POINTS) {
    it(`killed at ${point}: the rerun ends as an uninterrupted run would`, async () => {
      const st = await abortLeft('abortAfterCheck', { editN: true })
      const want = nOf(st)
      const first = await act(st, 'clean-staging', dead, killAt(point))
      expect(first.result.status).toBe('stopped')
      expect(copiesOf(st, want) + (fs.existsSync(path.join(st.opDir, 'new')) ? 1 : 0)).toBe(1)
      noOrphanSidecarOrSource(st)
      await done(
        st,
        'clean-staging',
        fs.existsSync(path.join(st.opDir, 'owner.json')) ? dead : { ownerProbe: ALIVE }
      )
      expect(fs.existsSync(st.opDir)).toBe(false)
      const dest = keptAt(st.fx, 'unrecorded-new')
      expect(contentOf(dest)).toEqual(want)
      expect(contentOf(dest)['a.txt']).toContain(EDIT)
      expect(copiesOf(st, want)).toBe(1)
      noOrphanSidecar(st)
    })
  }
})

/** Mid-keep: every sidecar's tree is at its name or still in OP (the keep's P1). */
function noOrphanSidecarOrSource(st: State): void {
  const area = areaOf(st.fx)
  if (!fs.existsSync(area)) return
  for (const n of fs.readdirSync(area).filter((x) => x.endsWith('.json'))) {
    const there = fs.existsSync(path.join(area, n.slice(0, -'.json'.length)))
    expect(there || fs.existsSync(path.join(st.opDir, 'new')), n).toBe(true)
  }
}
