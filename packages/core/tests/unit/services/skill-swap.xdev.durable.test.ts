/**
 * SMI-6531 (A1 step 4c, review round 1): durability and the end of step 13.
 *
 *  - The park's durability (GPT-5.6-Sol rounds 1-2, owner decision): the port
 *    syncs `.skillsmith-parked` and ST before its rename (traced from its
 *    `preMoveSynced`), and after a park that moved OP the caller syncs the
 *    landing directory and then ST before reporting; a failed post-rename sync
 *    is not done (`held`, `park-not-durable`), for both park callers, and for
 *    a park the port already returned `held`.
 *  - Fix 4 (governance, measured): every failure after `record.json` is
 *    unlinked ends as `removal-not-done` naming OP with one stderr line and the
 *    `--clean-staging` hint, never as an `incomplete` result naming no record:
 *    an EIO at OP's sync right after the unlink, and an owner unlink that is
 *    refused, on both devices.
 *
 * The directory syncs are failed at `syncDirectory`'s open (its named
 * `fs/promises` import, republished with `syncBuiltinESMExports`); each test
 * asserts the stub fired.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parkTreeIndexed } from '../../../src/install/park-call.js'
import type { SwapResult, TraceOp } from '../../../src/services/skill-swap.js'
import { ALL_DELETES, refusedOf, runSpied } from './skill-swap.abort.helpers.js'
import type { Event } from './skill-swap.abort.helpers.js'
import { abortAt } from './skill-swap.abort.triggers.js'
import {
  run as runPlain,
  makeFixture,
  modify,
  OP_ID,
  plan,
  useTmpCleanup,
} from './skill-swap.helpers.js'
import type { Fixture } from './skill-swap.helpers.js'
import {
  failDirSync,
  parkedArea,
  parkedCopies,
  treeDeletesX,
  useOtherDeviceCleanup,
  xdevFixture,
} from './skill-swap.xdev.helpers.js'

useTmpCleanup()
useOtherDeviceCleanup()

const FILES = { 'SKILL.md': '# v1\n', 'a.txt': 'a\n', 'sub/b.txt': 'b\n' }
const traceOf = (events: Event[]): TraceOp[] => events.filter((e): e is TraceOp => !('fs' in e))

type Committed = Extract<SwapResult, { status: 'committed' }>
function committedOf(r: SwapResult): Committed {
  expect(r.status).toBe('committed')
  if (r.status !== 'committed') throw new Error('unreachable')
  return r
}

/** The one-line, not-done end after the record unlink: OP named, the hint, no record named. */
function assertNotDoneAfterRecord(fx: Fixture, r: Committed, lines: string[], reason: string) {
  expect(r.incomplete).toBeUndefined()
  expect(r).not.toHaveProperty('recordPath')
  expect(fs.existsSync(path.join(fx.opDir, 'record.json'))).toBe(false)
  const nd = r.warnings.filter((w) => w.code === 'removal-not-done')
  expect(nd).toHaveLength(1)
  expect(nd[0]).toMatchObject({ path: fx.opDir, status: 'stopped', reason })
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain(fx.opDir)
  expect(lines[0]).toContain(`skillsmith doctor recovery --clean-staging ${OP_ID}`)
  expect(lines[0]).not.toContain('skillsmith restore')
}

describe('fix 1: the park is synced before it is reported', () => {
  it('across devices: mkdirs, the port syncs .skillsmith-parked and ST, the park, then <opId> and ST, then the hook', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    let atHook: number | null = null
    const trace: TraceOp[] = []
    const run = await runPlain(p, {
      trace: (t) => trace.push(t),
      hooks: { afterParkSync: () => void (atHook = trace.length) },
    })
    const r = committedOf(run.result)
    const parked = path.dirname(parkedArea(fx))
    const i = trace.findIndex((t) => t.op === 'park')
    expect(trace.slice(i - 4, i + 3)).toEqual([
      { op: 'mkdir', path: parked },
      { op: 'mkdir', path: parkedArea(fx) },
      { op: 'dirsync', path: parked },
      { op: 'dirsync', path: fx.staging },
      { op: 'park', path: fx.opDir, status: 'parked', dest: r.extraCopy },
      { op: 'dirsync', path: parkedArea(fx) },
      { op: 'dirsync', path: fx.staging },
    ])
    expect(path.dirname(String(r.extraCopy))).toBe(parkedArea(fx))
    // The hook runs after both post-rename syncs (Sol round 2: it was unpinned).
    expect(atHook).not.toBeNull()
    expect(trace.slice(0, atHook!).slice(-2)).toEqual([
      { op: 'dirsync', path: parkedArea(fx) },
      { op: 'dirsync', path: fx.staging },
    ])
  })

  it("abort cleanup's park: the same pre- and post-rename syncs, in the same order", async () => {
    const fx = makeFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const t = abortAt(fx, 'step4')
    try {
      const run = await runSpied(p, ALL_DELETES, t.options)
      expect(refusedOf(run.result).staged).toBe('parked')
      const trace = traceOf(run.events)
      const parked = path.dirname(parkedArea(fx))
      const i = trace.findIndex((t) => t.op === 'park')
      expect(trace.slice(i - 2, i + 3)).toEqual([
        { op: 'dirsync', path: parked },
        { op: 'dirsync', path: fx.staging },
        expect.objectContaining({ op: 'park', path: fx.opDir, status: 'parked' }),
        { op: 'dirsync', path: parkedArea(fx) },
        { op: 'dirsync', path: fx.staging },
      ])
    } finally {
      t.restore()
    }
  })

  it('across devices: a failed sync of the landing directory is not done (held/park-not-durable), the tree reported where it is', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const lines: string[] = []
    const f = failDirSync((d) => d === parkedArea(fx))
    let run
    try {
      run = await runSpied(p, ALL_DELETES, { stderr: (l) => lines.push(l) })
    } finally {
      f.restore()
    }
    // Presence: the landing sync was attempted (and failed) exactly once.
    expect(f.fired()).toBe(1)
    const r = committedOf(run.result)
    expect(r.incomplete).toBeUndefined()
    expect(r.extraCopy).toBeUndefined()
    const copies = parkedCopies(fx)
    expect(copies).toHaveLength(1)
    const nd = r.warnings.filter((w) => w.code === 'removal-not-done')
    expect(nd).toEqual([
      expect.objectContaining({
        path: fx.opDir,
        status: 'held',
        reason: 'park-not-durable',
        errno: 'EIO',
        parkedPath: copies[0],
      }),
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(String(copies[0]))
    // Absence, after the park only: no sync of ST or .skillsmith-parked was made.
    const trace = traceOf(run.events)
    const after = trace.slice(trace.findIndex((t) => t.op === 'park') + 1)
    const parked = path.dirname(parkedArea(fx))
    expect(
      after.filter((t) => t.op === 'dirsync' && (t.path === fx.staging || t.path === parked))
    ).toEqual([])
    // ...while the pre-rename syncs before it are there (so the filter can see a dirsync).
    expect(trace.filter((t) => t.op === 'dirsync' && t.path === fx.staging).length).toBeGreaterThan(
      0
    )
    expect(treeDeletesX(fx, run.events)).toEqual([])
  })

  it('a park the port already returned held, whose landing sync then fails: its own reason, the failure in the detail, the sync errno', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const f = failDirSync((d) => d === parkedArea(fx))
    let run
    try {
      run = await runSpied(p, ALL_DELETES, {
        park: async (parent, name, o) => {
          const real = await parkTreeIndexed(parent, name, o)
          return { ...real, status: 'held', reason: 'changed-during-move', detail: 'probe-held' }
        },
      })
    } finally {
      f.restore()
    }
    expect(f.fired()).toBe(1)
    const r = committedOf(run.result)
    const nd = r.warnings.filter((w) => w.code === 'removal-not-done')
    expect(nd).toHaveLength(1)
    expect(nd[0]).toMatchObject({ status: 'held', reason: 'changed-during-move', errno: 'EIO' })
    const detail = String((nd[0] as { detail?: string }).detail)
    expect(detail).toMatch(
      /^probe-held; its park could not be synced \(the park moved the tree to /
    )
    expect(detail).toContain(`${parkedArea(fx)} could not be synced`)
  })

  it('abort cleanup: a failed sync of ST after its park is staged held with park-not-durable', async () => {
    const fx = makeFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const t = abortAt(fx, 'step4')
    let parked = false
    const f = failDirSync(
      (d) => d === fx.staging,
      () => parked
    )
    try {
      const run = await runSpied(p, ALL_DELETES, {
        ...t.options,
        hooks: { ...t.options.hooks, afterPark: () => void (parked = true) },
      })
      expect(f.fired()).toBe(1)
      const r = refusedOf(run.result)
      expect(r.staged).toBe('held')
      expect(r.warnings).toContainEqual(
        expect.objectContaining({
          code: 'removal-not-done',
          status: 'held',
          reason: 'park-not-durable',
        })
      )
    } finally {
      f.restore()
      t.restore()
    }
  })
})

describe('fix 4: a failure after the record unlink is a removal not done', () => {
  for (const device of ['one device', 'across devices'] as const) {
    const make = () => (device === 'one device' ? makeFixture(FILES) : xdevFixture(FILES))

    it(`${device}: EIO at the sync of OP right after the record unlink`, async () => {
      const fx = make()
      const p = plan(fx, [modify('SKILL.md', '# v2\n')])
      const record = path.join(fx.opDir, 'record.json')
      const lines: string[] = []
      // Armed once the manifest is written and the record is gone: the sync right after its unlink.
      const f = failDirSync(
        (d) => d === fx.opDir,
        () => p.manifest.writes > 0 && !fs.existsSync(record)
      )
      let run
      try {
        run = await runSpied(p, ALL_DELETES, { stderr: (l) => lines.push(l) })
      } finally {
        f.restore()
      }
      expect(f.fired()).toBe(1)
      const r = committedOf(run.result)
      assertNotDoneAfterRecord(fx, r, lines, 'write-failed')
      expect(r.warnings).toContainEqual(expect.objectContaining({ errno: 'EIO' }))
      const left = fs.readdirSync(fx.opDir).sort()
      expect(left).toEqual(
        device === 'one device' ? ['owner.json'] : ['old', 'owner.json', 'park-intent.json']
      )
      expect(treeDeletesX(fx, run.events)).toEqual([])
    })

    it(`${device}: the owner unlink refused (owner.json replaced after the record unlink)`, async () => {
      const fx = make()
      const p = plan(fx, [modify('SKILL.md', '# v2\n')])
      const owner = path.join(fx.opDir, 'owner.json')
      const lines: string[] = []
      const run = await runSpied(p, ALL_DELETES, {
        stderr: (l) => lines.push(l),
        hooks: {
          afterRecordUnlink: () => {
            fs.writeFileSync(`${owner}.planted`, 'planted owner\n')
            fs.renameSync(`${owner}.planted`, owner)
          },
        },
      })
      const r = committedOf(run.result)
      assertNotDoneAfterRecord(fx, r, lines, 'staging-unsafe')
      expect(fs.readFileSync(owner, 'utf8')).toBe('planted owner\n')
      expect(treeDeletesX(fx, run.events)).toEqual([])
    })
  }
})
