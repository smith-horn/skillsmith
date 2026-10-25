/**
 * SMI-6531 (A1 step 5): the record scan, swap halves of T-R1 and T-R3
 * (A1 plan §3.3 step 3, R1, UD8). T-R2 and the order are in
 * `skill-swap.scan.root.test.ts`.
 *
 * Crash states are real `swapInPlace` runs. Doctor's half (naming the state,
 * `--apply`, `--undo`) is step 6's.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_RECORD_BYTES, scanStagingRecords } from '../../../src/services/skill-swap.records.js'
import type { SwapOptions } from '../../../src/services/skill-swap.js'
import {
  deletesOf,
  refusedOf,
  runSpied,
  ALL_DELETES,
  treeDeletes,
} from './skill-swap.abort.helpers.js'
import {
  areaOf,
  hashOf,
  listTree,
  makeFixture,
  run,
  OP_ID,
  plan,
  modify,
  useTmpCleanup,
} from './skill-swap.helpers.js'
import {
  attempt,
  crashIncomplete,
  crashStopped,
  deepSnapshot,
  frozen,
  frozenWide,
  opDirOf,
  opIdN,
  otherSkill,
  plantRecord,
  plantRecordText,
} from './skill-swap.scan.helpers.js'

useTmpCleanup()

const CRASHES = [
  ['a stopped run (pre-commit check failed)', crashStopped],
  ['a committed run with incomplete audit', crashIncomplete],
] as const

describe('T-R1 (swap half): a crash-kept record blocks its skill and changes nothing', () => {
  for (const [label, crash] of CRASHES) {
    it(`${label}: the same skill refuses recovery-pending, every byte stays, another skill commits`, async () => {
      const fx = makeFixture({ 'SKILL.md': '# v1\n' })
      const other = otherSkill(fx, 'other-skill', { 'SKILL.md': '# other\n' })
      const crashed = await crash(fx)
      const before = frozen(fx, crashed)
      const OP2 = opIdN('c')
      const wideBefore = frozenWide(fx, crashed, [OP2])

      const p2 = plan(fx, [modify('SKILL.md', '# next\n')])
      const fx2 = { ...fx, opDir: opDirOf(fx, OP2) }
      const run2 = await runSpied(p2, ALL_DELETES, { opId: OP2 })

      const r = refusedOf(run2.result)
      expect(r).toMatchObject({ reason: 'recovery-pending', blockedBy: [OP_ID], staged: 'parked' })
      expect(r.detail).toContain(fx.realDir)
      // (`runSpied` feeds the trace into `events`.)
      expect(run2.events).toContainEqual({ op: 'record-scan', path: fx.staging })
      // Nothing the crash left was touched, by snapshot and by spy.
      expect(frozenWide(fx, crashed, [OP2])).toEqual(wideBefore)
      expect(frozen(fx, crashed)).toEqual(before)
      expect(treeDeletes(fx2, run2.events)).toEqual([])
      const touched = deletesOf(run2.events).filter(
        (e) =>
          e.path === fx.opDir ||
          e.path.startsWith(`${fx.opDir}${path.sep}`) ||
          e.path.startsWith(`${fx.realDir}${path.sep}`)
      )
      expect(touched).toEqual([])
      // The spy sees this run's own metadata being unlinked, so it was watching.
      expect(
        deletesOf(run2.events).some((e) => e.path === path.join(fx2.opDir, 'owner.json'))
      ).toBe(true)
      expect(p2.manifest.writes).toBe(0)
      expect(p2.manifest.entry).toEqual(p2.manifest.preEntry)

      // Another skill in the same root commits.
      const o = await attempt(other, opIdN('d'))
      expect(o.result.status).toBe('committed')
      expect(o.p.manifest.writes).toBe(1)
      expect(frozen(fx, crashed)).toEqual(before)
    })
  }

  it('an op dir with owner.json and new/ and no record (a crash before step 5) blocks nothing', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const other = otherSkill(fx, 'other-skill', { 'SKILL.md': '# other\n' })
    expect((await attempt(other, opIdN('d'))).result.status).toBe('committed') // makes ST
    const lone = opDirOf(fx, opIdN('e'))
    fs.mkdirSync(path.join(lone, 'new'), { recursive: true })
    fs.writeFileSync(path.join(lone, 'new', 'SKILL.md'), '# half built\n')
    fs.writeFileSync(path.join(lone, 'owner.json'), '{}')
    const before = deepSnapshot(lone)

    const r = await attempt(fx, opIdN('f'))

    expect(r.result.status).toBe('committed')
    // The scan ran over a staging that holds the lone op dir.
    expect(r.trace).toContainEqual({ op: 'record-scan', path: fx.staging })
    expect(fs.existsSync(path.join(lone, 'record.json'))).toBe(false)
    expect(deepSnapshot(lone)).toEqual(before)
  })
})

describe('T-R1 (swap half): a step-1 failure with a built N meets the record scan too', () => {
  // The plan goes stale (the live folder edited after it), so the build's check of the copy
  // against preTree fails with changed-since-plan: N is complete but postTree is not set.
  function stalePlan(fx: ReturnType<typeof makeFixture>) {
    const p = plan(fx, [modify('SKILL.md', '# next\n')])
    fs.appendFileSync(path.join(fx.realDir, 'SKILL.md'), 'edited after planning\n')
    return p
  }
  async function staleRun(
    fx: ReturnType<typeof makeFixture>,
    p: ReturnType<typeof plan>,
    opId: string,
    options: SwapOptions = {}
  ) {
    const fx2 = { ...fx, opDir: opDirOf(fx, opId) }
    const r = await runSpied(p, ALL_DELETES, { ...options, opId })
    return { p, fx2, ...r }
  }

  it('with a pending record: refused recovery-pending, its own failed build kept, the crash untouched', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const crashed = await crashStopped(fx)
    const OP2 = opIdN('c')
    const stale = stalePlan(fx)
    const wideBefore = frozenWide(fx, crashed, [OP2])

    const run = await staleRun(fx, stale, OP2)

    const r = refusedOf(run.result)
    const kept = path.join(areaOf(fx), `${OP2}.failed-build`)
    expect(r).toMatchObject({
      reason: 'recovery-pending',
      blockedBy: [OP_ID],
      staged: 'kept',
      keptAs: { kind: 'failed-build', path: kept },
    })
    // The failed build itself was kept whole, and it is a complete copy of the edited folder.
    expect(fs.readFileSync(path.join(kept, 'SKILL.md'), 'utf8')).toContain('edited after planning')
    expect(run.events).toContainEqual({ op: 'record-scan', path: fx.staging })
    expect(frozenWide(fx, crashed, [OP2])).toEqual(wideBefore)
    expect(treeDeletes(run.fx2, run.events)).toEqual([])
  })

  it('control: the same stale-plan failure with no record keeps its own reason and has no blockedBy', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const run = await staleRun(fx, stalePlan(fx), opIdN('c'))

    const r = refusedOf(run.result)
    expect(r).toMatchObject({ reason: 'changed-since-plan', staged: 'kept' })
    expect(r.keptAs?.kind).toBe('failed-build')
    expect(r.blockedBy).toBeUndefined()
    // The scan ran and found nothing to report.
    expect(run.events).toContainEqual({ op: 'record-scan', path: fx.staging })
  })

  it('(UD45 branch) with an UNREADABLE record in ST: refused recovery-record-unreadable naming it', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const seed = otherSkill(fx, 'seed-skill', { 'SKILL.md': '# seed\n' })
    expect((await attempt(seed, opIdN('d'))).result.status).toBe('committed') // makes ST
    const bad = opIdN('f')
    plantRecordText(fx, bad, '{ not json')

    const run = await staleRun(fx, stalePlan(fx), opIdN('c'))

    expect(refusedOf(run.result)).toMatchObject({
      reason: 'recovery-record-unreadable',
      blockedBy: [bad],
      staged: 'kept',
    })
    expect(run.events).toContainEqual({ op: 'record-scan', path: fx.staging })
    expect(treeDeletes(run.fx2, run.events)).toEqual([])
  })

  it('(UD45 branch) with a staging that cannot be listed: keeps the build reason, no blockedBy; the stub fired', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const seed = otherSkill(fx, 'seed-skill', { 'SKILL.md': '# seed\n' })
    expect((await attempt(seed, opIdN('d'))).result.status).toBe('committed') // makes ST
    const stale = stalePlan(fx)
    const orig = fs.promises.readdir
    const hits: string[] = []
    const stub = (async (...args: unknown[]) => {
      if (args[0] === fx.staging) {
        hits.push(String(args[0]))
        const e = new Error('EACCES: permission denied') as NodeJS.ErrnoException
        e.code = 'EACCES'
        throw e
      }
      return (orig as unknown as (...a: unknown[]) => Promise<unknown>)(...args)
    }) as unknown as typeof fs.promises.readdir
    try {
      // Installed once the build has made N, so only the abort path's scan meets it.
      const run = await staleRun(fx, stale, opIdN('c'), {
        hooks: {
          afterCopy: () => {
            fs.promises.readdir = stub
          },
        },
      })
      const r = refusedOf(run.result)
      expect(hits.length).toBeGreaterThan(0)
      expect(r.reason).toBe('changed-since-plan')
      expect(r.blockedBy).toBeUndefined()
    } finally {
      fs.promises.readdir = orig
    }
  })
})

describe('T-R3 (swap half): precedence and scope', () => {
  it('an unreadable record wins over a verified record naming this skill, and only it is named', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const crashed = await crashStopped(fx)
    const bad = opIdN('f')
    plantRecordText(fx, bad, '{ not json')
    const before = frozen(fx, crashed)

    const r = refusedOf((await attempt(fx, opIdN('c'))).result)

    expect(r).toMatchObject({ reason: 'recovery-record-unreadable', blockedBy: [bad] })
    expect(frozen(fx, crashed)).toEqual(before)
    // Control: with the unreadable record gone, the same skill is pending, not unreadable.
    fs.rmSync(opDirOf(fx, bad), { recursive: true })
    const r2 = refusedOf((await attempt(fx, opIdN('d'))).result)
    expect(r2).toMatchObject({ reason: 'recovery-pending', blockedBy: [OP_ID] })
  })

  it('a pending record blocks only its own skill: two pending skills, two other skills commit', async () => {
    const fx = makeFixture({ 'SKILL.md': '# x\n' })
    const y = otherSkill(fx, 'skill-y', { 'SKILL.md': '# y\n' })
    const p = otherSkill(fx, 'skill-p', { 'SKILL.md': '# p\n' })
    const q = otherSkill(fx, 'skill-q', { 'SKILL.md': '# q\n' })
    const opX = opIdN('1')
    const opY = opIdN('2')
    const cx = await crashStopped(fx, opX)
    const cy = await crashIncomplete(y, opY)
    const bx = frozen(fx, cx)
    const by = frozen(y, cy)

    // Each crashed skill is blocked by its own record only.
    expect(refusedOf((await attempt(fx, opIdN('c'))).result)).toMatchObject({
      reason: 'recovery-pending',
      blockedBy: [opX],
    })
    expect(refusedOf((await attempt(y, opIdN('d'))).result)).toMatchObject({
      reason: 'recovery-pending',
      blockedBy: [opY],
    })
    // The two others commit, each past both records.
    for (const [skill, id] of [
      [p, 'e'],
      [q, 'f'],
    ] as const) {
      const r = await attempt(skill, opIdN(id))
      expect(r.result.status).toBe('committed')
      expect(r.trace).toContainEqual({ op: 'record-scan', path: fx.staging })
    }
    expect(frozen(fx, cx)).toEqual(bx)
    expect(frozen(y, cy)).toEqual(by)
  })

  // A record names a skill by `realDir` or `comparedPath`, each against either of the target's.
  const NAMING: Array<[string, boolean, (mine: string, other: string) => object]> = [
    ['realDir matches', true, (mine, other) => ({ realDir: mine, comparedPath: other })],
    ['comparedPath matches', true, (mine, other) => ({ realDir: other, comparedPath: mine })],
    ['neither matches', false, (_mine, other) => ({ realDir: other, comparedPath: other })],
  ]
  for (const [label, blocks, over] of NAMING) {
    it(`a verified record naming the skill by one field: ${label} -> ${blocks ? 'recovery-pending' : 'commits'}`, async () => {
      const fx = makeFixture({ 'SKILL.md': '# v1\n' })
      const other = otherSkill(fx, 'other-skill', { 'SKILL.md': '# other\n' })
      expect((await attempt(other, opIdN('d'))).result.status).toBe('committed') // makes ST
      const alias = path.join(fx.base, 'alias-of-skill')
      plantRecord(fx, opIdN('9'), over(fx.realDir, alias))
      const r = await attempt(fx, opIdN('c'))
      if (blocks) {
        expect(refusedOf(r.result)).toMatchObject({
          reason: 'recovery-pending',
          blockedBy: [opIdN('9')],
        })
        expect(hashOf(fx.realDir)).toBe(r.p.input.preTree)
      } else {
        expect(r.result.status).toBe('committed')
      }
    })
  }
})

describe('T-R3 (swap half): a staging that cannot be listed', () => {
  async function withListingFailing(failing: boolean) {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const seed = otherSkill(fx, 'seed-skill', { 'SKILL.md': '# seed\n' })
    expect((await attempt(seed, opIdN('d'))).result.status).toBe('committed') // makes ST
    const orig = fs.promises.readdir
    const hits: string[] = []
    const stub = (async (...args: unknown[]) => {
      if (args[0] === fx.staging) {
        hits.push(String(args[0]))
        const e = new Error('EACCES: permission denied') as NodeJS.ErrnoException
        e.code = 'EACCES'
        throw e
      }
      return (orig as unknown as (...a: unknown[]) => Promise<unknown>)(...args)
    }) as unknown as typeof fs.promises.readdir
    const hooks = failing
      ? {
          afterBuild: () => {
            fs.promises.readdir = stub
          },
        }
      : {}
    try {
      const r = await attempt(fx, opIdN('c'), { hooks })
      return { fx, r, hits }
    } finally {
      fs.promises.readdir = orig
    }
  }

  it('a failing listing of ST refuses staging-unsafe and names the errno; the stub fired', async () => {
    const { fx, r, hits } = await withListingFailing(true)
    const refused = refusedOf(r.result)
    expect(refused.reason).toBe('staging-unsafe')
    expect(refused.detail).toContain('EACCES')
    expect(refused.detail).toContain(fx.staging)
    expect(hits.length).toBeGreaterThan(0)
    expect(hashOf(fx.realDir)).toBe(r.p.input.preTree)
  })

  it('control: the same run with a working listing commits', async () => {
    const { r } = await withListingFailing(false)
    expect(r.result.status).toBe('committed')
  })
})

/** The T-R1 snapshot itself: what it sees and what it leaves out (governance round 2). */
describe('frozenWide: what the T-R1 snapshot sees', () => {
  it('sees an empty directory removed and another op index line changed; not a dir of only skipped entries, or own lines', () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const mine = opIdN('d')
    const index = path.join(fx.stateRoot, 'parked-index.jsonl')
    fs.mkdirSync(path.join(fx.staging, 'empty-dir'), { recursive: true })
    fs.writeFileSync(index, `{"opId":"${OP_ID}","n":1}\n`)
    const before = frozenWide(fx, { p }, [mine])

    // Left out: a directory holding only this run's own park, and its own index line.
    fs.mkdirSync(path.join(fx.staging, '.skillsmith-parked', mine), { recursive: true })
    fs.appendFileSync(index, `{"opId":"${mine}","n":2}\n`)
    expect(frozenWide(fx, { p }, [mine])).toEqual(before)

    // Seen: an empty directory removed.
    fs.rmdirSync(path.join(fx.staging, 'empty-dir'))
    expect(frozenWide(fx, { p }, [mine]).staging).not.toEqual(before.staging)
    fs.mkdirSync(path.join(fx.staging, 'empty-dir'))

    // Seen: another op's index line changed.
    fs.writeFileSync(index, `{"opId":"${OP_ID}","n":9}\n{"opId":"${mine}","n":2}\n`)
    expect(frozenWide(fx, { p }, [mine]).index).not.toEqual(before.index)
  })
})

const cycle: Record<string, unknown> = {}
cycle.self = cycle

/**
 * Entries the record can't carry: JSON drops the first three (measured), so
 * the record would not read back; it throws on the last two.
 */
const UNSERIALIZABLE: Array<[string, unknown, string]> = [
  [
    'undefined',
    undefined,
    'would be read as unreadable (malformed): preEntry and postEntry must be JSON values',
  ],
  [
    'a function',
    () => 1,
    'would be read as unreadable (malformed): preEntry and postEntry must be JSON values',
  ],
  [
    'a symbol',
    Symbol('entry'),
    'would be read as unreadable (malformed): preEntry and postEntry must be JSON values',
  ],
  ['a cycle', cycle, "can't be serialized"],
  ['a BigInt', { n: 1n }, "can't be serialized"],
]

describe('T-R1 (swap half): a record never holds an entry JSON drops (retro of PR #3162)', () => {
  for (const key of ['preEntry', 'postEntry'] as const) {
    it.each(UNSERIALIZABLE)(
      `${key}: %s refuses write-failed before step 5 publishes; the root is not blocked`,
      async (_label, value, detail) => {
        const fx = makeFixture({ 'SKILL.md': '# v1\n' })
        const other = otherSkill(fx, 'other-skill', { 'SKILL.md': '# other\n' })
        const p = plan(fx, [modify('SKILL.md', '# next\n')])
        p.input = { ...p.input, [key]: value }
        const OP2 = opIdN('c')
        const run = await runSpied(p, ALL_DELETES, { opId: OP2 })

        const r = refusedOf(run.result)
        expect(r.reason).toBe('write-failed')
        expect(r.detail).toContain(detail)
        // Abort cleanup ran like any step-5 failure: the complete build is parked.
        expect(r.staged).toBe('parked')
        expect(listTree(fx.staging).filter((n) => n.endsWith('record.json'))).toEqual([])
        expect(
          run.events.some(
            (e) => 'op' in e && e.op === 'create' && e.path.endsWith('record.json.tmp')
          )
        ).toBe(false)
        expect(hashOf(fx.realDir)).toBe(p.input.preTree)
        // The root is not blocked: a second skill commits, and the scan reads nothing unreadable.
        const o = await attempt(other, opIdN('d'))
        expect(o.result.status).toBe('committed')
        const scan = await scanStagingRecords(fs.realpathSync(fx.skillsDir), fx.staging)
        expect(scan).toMatchObject({ ok: true, unreadable: [] })
      }
    )
  }

  /** A refused step-5 seal: no record or temp in ST, the build parked, another skill commits. */
  async function sealRefused(entry: unknown, why: string, hint: string) {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const other = otherSkill(fx, 'other-skill', { 'SKILL.md': '# other\n' })
    const p = plan(fx, [modify('SKILL.md', '# next\n')])
    p.input = { ...p.input, preEntry: entry }
    const run = await runSpied(p, ALL_DELETES, { opId: opIdN('c') })
    const r = refusedOf(run.result)
    expect(r.reason).toBe('write-failed')
    expect(r.detail).toContain(`would be read as unreadable (${why}): ${hint}`)
    expect(r.staged).toBe('parked')
    expect(listTree(fx.staging).filter((n) => /record\.json(\.tmp)?$/.test(n))).toEqual([])
    expect(
      run.events.some((e) => 'op' in e && e.op === 'create' && /record\.json/.test(e.path))
    ).toBe(false)
    expect((await attempt(other, opIdN('d'))).result.status).toBe('committed')
    const scan = await scanStagingRecords(fs.realpathSync(fx.skillsDir), fx.staging)
    expect(scan).toMatchObject({ ok: true, unreadable: [] })
  }

  it('an entry that pushes the record over MAX_RECORD_BYTES is refused (too-large); a smaller one commits', async () => {
    await sealRefused(
      { pad: 'x'.repeat(MAX_RECORD_BYTES) },
      'too-large',
      `the record must be at most ${MAX_RECORD_BYTES} bytes`
    )
    // Control: a pad that keeps the record under the cap commits.
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const p = plan(fx, [modify('SKILL.md', '# next\n')])
    p.input = { ...p.input, preEntry: { pad: 'x'.repeat(MAX_RECORD_BYTES - 50_000) } }
    expect((await run(p, { opId: opIdN('c') })).result.status).toBe('committed')
  })

  it('an entry whose toJSON changes between calls is refused: the hash made from one call does not match the bytes from another', async () => {
    let calls = 0
    await sealRefused(
      { toJSON: () => ({ n: ++calls }) },
      'hash-mismatch',
      'an entry serialized differently between calls'
    )
    expect(calls).toBeGreaterThan(1)
  })

  it('control: null entries commit; a kept record with them is read back as pending', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const other = otherSkill(fx, 'other-skill', { 'SKILL.md': '# other\n' })
    expect((await attempt(other, opIdN('d'), {})).result.status).toBe('committed')
    const p = plan(fx, [modify('SKILL.md', '# next\n')])
    p.input = { ...p.input, preEntry: null, postEntry: null }
    expect((await run(p, { opId: opIdN('c') })).result.status).toBe('committed')

    // The same entries with a forced stop keep the record, which the scan accepts.
    const fx2 = makeFixture({ 'SKILL.md': '# v1\n' })
    const p2 = plan(fx2, [modify('SKILL.md', '# next\n')])
    p2.input = { ...p2.input, preEntry: null, postEntry: null }
    p2.manifest.preCommitError = new Error('manifest lock lost')
    const stopped = await run(p2, { opId: opIdN('e') })
    expect(stopped.result.status).toBe('stopped')
    const scan = await scanStagingRecords(fs.realpathSync(fx2.skillsDir), fx2.staging)
    expect(scan).toMatchObject({ ok: true, unreadable: [] })
    expect(scan.ok && scan.pending.map((r) => r.opId)).toEqual([opIdN('e')])
  })

  it('a value JSON changes inside an entry still reads back, as JSON wrote it (UD47, accepted)', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const p = plan(fx, [modify('SKILL.md', '# next\n')])
    p.input = { ...p.input, preEntry: { version: undefined, size: Number.NaN } }
    p.manifest.preCommitError = new Error('manifest lock lost')
    const stopped = await run(p, { opId: opIdN('f') })
    expect(stopped.result.status).toBe('stopped')
    const scan = await scanStagingRecords(fs.realpathSync(fx.skillsDir), fx.staging)
    expect(scan).toMatchObject({ ok: true, unreadable: [] })
    expect(scan.ok && scan.pending.map((r) => r.opId)).toEqual([opIdN('f')])
    const rec = JSON.parse(
      fs.readFileSync(path.join(opDirOf(fx, opIdN('f')), 'record.json'), 'utf8')
    ) as { preEntry: unknown }
    expect(rec.preEntry).toEqual({ size: null })
  })
})
