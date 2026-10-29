/**
 * SMI-6531 (#3209 retro): one fixture per shape of every `RecoveryClass` kind,
 * for the property suite over the plan table's refusal hints
 * (`recovery.plan.hint.test.ts`).
 *
 * Every `RecoveryClass` kind is built through the real classifier (`opReport`)
 * from a real crash, moved the way a user, a copy or a kill would move it,
 * some also through the reader's `statOverride` seam for a race or an errno
 * the container cannot produce on demand: C3 (the op dir's own `lstat` failing
 * with `EIO`, or its listing failing with `ENOTDIR`) and `other-user` (its
 * `lstat` denied with `EACCES`) are built that way.
 *
 * Two variants are extra typed literals beside those, because the seam
 * replaces `stat` only and the listing reads the real filesystem, where a root
 * test process is refused nothing:
 *  - C3 with the op dir's listing failing with `EIO`;
 *  - `other-user` with a known owner uid: the op dir `lstat`ed, then its
 *    listing denied with `EACCES`, which needs a second user.
 *
 * The groups are keyed by class kind with `satisfies`, so a new kind fails to
 * compile here until it has fixtures; `allFixtures` requires every group to be
 * non-empty and every fixture to classify as its group's kind.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { expect } from 'vitest'
import type { RecoveryClass, StatFact } from '../../../../src/services/skill-recovery.types.js'
import type { ListOptions } from '../../../../src/services/skill-recovery.listing.js'
import { areaOf, makeFixture } from '../skill-swap.helpers.js'
import { renamedOp } from './recovery.abandon.helpers.js'
import { act, killAt } from './recovery.act.helpers.js'
import { abortLeft, ALIVE, DEAD } from './recovery.clean.helpers.js'
import { keepTree, opReport, s0, s1, s2, s3, un1, un2, writeEntry } from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'
import { killed, xs3 } from './recovery.xdev.helpers.js'

type Kind = RecoveryClass['kind']

export interface Builder {
  name: string
  /** What the classified class must match, beyond its kind. */
  want?: Record<string, unknown>
  build: () => Promise<RecoveryClass>
}

export interface PlanFixture {
  name: string
  kind: Kind
  cls: RecoveryClass
}

const file = () => makeFixture({ 'SKILL.md': '# v1\n' })

const classOf = async (st: State | Promise<State>, over: ListOptions = {}) =>
  (await opReport(await st, over)).cls

/** A `.DS_Store` in the op dir: an entry no finish removes (O2). */
function stray(st: State): State {
  fs.writeFileSync(path.join(st.opDir, '.DS_Store'), '')
  return st
}

const keepOld = (st: State) => (keepTree(st, 'old', 'backup'), st)
const keepNew = (st: State) => (keepTree(st, 'new', 'unused-new'), st)
const keepUndone = (st: State) => (keepTree(st, 'undone', 'undone'), st)

/** S2 with the manifest entry neither pre nor post (S2′), optionally after its keep. */
async function primed(postKeep: boolean): Promise<State> {
  const fx = file()
  const st = await s2(fx)
  if (postKeep) keepTree(st, 'old', 'backup')
  writeEntry(fx, { version: '9.9.9' })
  return st
}

/** `old/` replaced by a copy of itself: the right content, not the folder written (identity-changed). */
function copyOld(st: State): State {
  const copy = path.join(st.opDir, 'old')
  fs.cpSync(copy, `${copy}.c`, { recursive: true })
  fs.rmSync(copy, { recursive: true })
  fs.renameSync(`${copy}.c`, copy)
  return st
}

/** S2 whose record bytes no longer match its hash (`hash-mismatch`): unreadable. */
async function corrupt(): Promise<State> {
  const st = await s2(file())
  const rec = path.join(st.opDir, 'record.json')
  const body = JSON.parse(fs.readFileSync(rec, 'utf8')) as { pid: number }
  body.pid += 1
  fs.writeFileSync(rec, JSON.stringify(body))
  return st
}

/** A doctor cross-device finish killed right after it unlinked the record: a verifying move-source intent. */
async function doctorLeft(): Promise<State> {
  const st = await xs3({ hooks: { afterBackupMove: () => killed('afterBackupMove') } })
  const first = await act(st, 'apply', {}, killAt('afterRecordUnlink'))
  expect(first.result.status).toBe('done')
  expect(fs.readdirSync(st.opDir).sort()).toEqual(['old', 'park-intent.json'])
  return st
}

/** The op dir's path holds `make()` instead of the crash's op dir. */
async function replaced(make: (opDir: string) => void): Promise<State> {
  const st = await s2(file())
  fs.rmSync(st.opDir, { recursive: true })
  make(st.opDir)
  return st
}

/**
 * A stat seam failing `target` with `errno` from its second stat on: the first is the
 * staging listing's (which would drop a failed entry), the next is the classifier's own.
 */
function afterFirstStat(target: string, errno: string): (p: string, real: StatFact) => StatFact {
  let seen = 0
  return (p, real) => (p === target && seen++ > 0 ? { ok: false, errno } : real)
}

const row = (state: string, postKeep: boolean) => ({ state, postKeep })

export const GROUPS = {
  state: [
    { name: 'S0', want: row('S0', false), build: () => classOf(s0(file())) },
    {
      name: 'S0 post-keep',
      want: row('S0', true),
      build: async () => classOf(keepNew(await s0(file()))),
    },
    { name: 'S1', want: row('S1', false), build: () => classOf(s1(file())) },
    {
      // --apply refuses: the staged copy no longer hashes to what was built.
      name: 'S1, new/ edited after the build',
      want: { ...row('S1', false), facts: { nHashesToPost: false } },
      build: async () => {
        const st = await s1(file())
        fs.appendFileSync(path.join(st.opDir, 'new', 'SKILL.md'), 'edited\n')
        return classOf(st)
      },
    },
    { name: 'S2', want: row('S2', false), build: () => classOf(s2(file())) },
    {
      name: 'S2 post-keep',
      want: row('S2', true),
      build: async () => classOf(keepOld(await s2(file()))),
    },
    { name: "S2'", want: row('S2prime', false), build: () => classOf(primed(false)) },
    { name: "S2' post-keep", want: row('S2prime', true), build: () => classOf(primed(true)) },
    {
      name: 'S2x',
      want: row('S2x', false),
      build: async () => {
        const st = await s2(file())
        fs.rmSync(st.fx.realDir, { recursive: true })
        return classOf(st)
      },
    },
    { name: 'S3', want: row('S3', false), build: () => classOf(s3(file())) },
    {
      name: 'S3 post-keep',
      want: row('S3', true),
      build: async () => classOf(keepOld(await s3(file()))),
    },
    { name: 'UN1', want: row('UN1', false), build: () => classOf(un1(file())) },
    { name: 'UN2', want: row('UN2', false), build: () => classOf(un2(file())) },
    {
      name: 'UN2 post-keep',
      want: row('UN2', true),
      build: async () => classOf(keepUndone(await un2(file()))),
    },
    {
      name: 'S2 + stray',
      want: { ...row('S2', false), facts: { strays: ['.DS_Store'] } },
      build: async () => classOf(stray(await s2(file()))),
    },
    {
      name: "S2' post-keep + stray",
      want: { ...row('S2prime', true), facts: { strays: ['.DS_Store'] } },
      build: async () => classOf(stray(await primed(true))),
    },
    {
      name: 'S2, another uid',
      want: row('S2', false),
      build: async () => classOf(s2(file()), { euid: (process.geteuid?.() ?? 0) + 1 }),
    },
  ],
  moved: [
    { name: 'moved', build: async () => classOf(renamedOp(await s2(file()))) },
    {
      name: 'moved + stray',
      want: { facts: { strays: ['.DS_Store'] } },
      build: async () => classOf(stray(renamedOp(await s2(file())))),
    },
  ],
  'identity-changed': [
    { name: 'identity-changed S2', build: async () => classOf(copyOld(await s2(file()))) },
    { name: "identity-changed S2'", build: async () => classOf(copyOld(await primed(false))) },
    {
      name: 'identity-changed S2 + stray',
      want: { facts: { strays: ['.DS_Store'] } },
      build: async () => classOf(stray(copyOld(await s2(file())))),
    },
    {
      name: 'identity-changed S2, another uid',
      build: async () =>
        classOf(copyOld(await s2(file())), { euid: (process.geteuid?.() ?? 0) + 1 }),
    },
  ],
  ab: [
    {
      name: 'ab',
      build: async () => {
        const st = await s2(file())
        keepTree(st, 'old', 'abandoned-old', { move: false })
        return classOf(st)
      },
    },
    {
      name: 'ab + stray',
      want: { facts: { strays: ['.DS_Store'] } },
      build: async () => {
        const st = await s2(file())
        keepTree(st, 'old', 'abandoned-old', { move: false })
        return classOf(stray(st))
      },
    },
  ],
  'anything-else': [
    {
      name: 'anything-else, S2 with old/ removed',
      build: async () => {
        const st = await s2(file())
        fs.rmSync(path.join(st.opDir, 'old'), { recursive: true })
        const cls = await classOf(st)
        expect(cls).toMatchObject({ facts: expect.objectContaining({ opId: st.opId }) })
        return cls
      },
    },
    {
      name: 'anything-else, an unprovable record.json.tmp',
      build: async () => {
        const st = await s2(file())
        fs.writeFileSync(path.join(st.opDir, 'record.json.tmp'), '{"not":"this record"}')
        const cls = await classOf(st)
        expect(cls).toMatchObject({ facts: expect.objectContaining({ opId: st.opId }) })
        return cls
      },
    },
    {
      // The listing keeps only directories, so a file is there only by a race: a directory when
      // the staging dir was listed, a regular file by the time its op dir is classified (C4).
      name: 'anything-else, a regular file at the op dir path (no facts)',
      want: { facts: null, reason: 'the op dir entry is not a directory' },
      build: async () => {
        const st = await replaced((p) => fs.writeFileSync(p, 'not a directory\n'))
        let seen = 0
        const statOverride = (p: string, real: StatFact): StatFact =>
          p === st.opDir && real.ok && seen++ === 0 ? { ...real, type: 'dir' } : real
        return classOf(st, { reader: { statOverride } })
      },
    },
  ],
  unreadable: [
    {
      name: 'unreadable (hash mismatch)',
      want: { why: 'hash-mismatch' },
      build: async () => classOf(corrupt()),
    },
    {
      name: 'unreadable (a FIFO at record.json)',
      // The park guard's walk fails on the FIFO: --park refuses (parkPlan's guard-walk branch).
      want: { why: 'not-a-file', observed: { hash: { ok: false, reason: 'unsupported-entry' } } },
      build: async () => {
        const st = await s2(file())
        const rec = path.join(st.opDir, 'record.json')
        fs.rmSync(rec)
        execFileSync('mkfifo', [rec])
        return classOf(st)
      },
    },
    {
      // --park refuses: the park binds every entry's identity, and old/'s lstat fails (parkPlan's lstat branch).
      name: 'unreadable (an entry whose lstat fails)',
      want: { why: 'hash-mismatch' },
      build: async () => {
        const st = await corrupt()
        const old = path.join(st.opDir, 'old')
        const statOverride = (p: string, real: StatFact): StatFact =>
          p === old ? { ok: false, errno: 'EIO' } : real
        return classOf(st, { reader: { statOverride } })
      },
    },
    {
      // C3 through the classifier: OP's own lstat fails (EIO) once the staging listing has kept it.
      name: 'unreadable (C3: the op dir cannot be inspected, through the seam)',
      want: {
        why: 'open-failed',
        errno: 'EIO',
        detail: 'the op dir cannot be inspected',
        observed: null,
      },
      build: async () => {
        const st = await s2(file())
        return classOf(st, { reader: { statOverride: afterFirstStat(st.opDir, 'EIO') } })
      },
    },
    {
      // C3 through the classifier: a file at OP's path that every stat calls a directory, so
      // the listing of OP itself fails (ENOTDIR).
      name: 'unreadable (C3: the op dir cannot be listed, through the seam)',
      want: {
        why: 'open-failed',
        errno: 'ENOTDIR',
        detail: 'the op dir cannot be listed',
        observed: null,
      },
      build: async () => {
        const st = await replaced((p) => fs.writeFileSync(p, 'not a directory\n'))
        const statOverride = (p: string, real: StatFact): StatFact =>
          p === st.opDir && real.ok ? { ...real, type: 'dir' } : real
        return classOf(st, { reader: { statOverride } })
      },
    },
    {
      // C3 (extra typed literal): the listing of a real op dir fails with EIO. The seam
      // replaces stat only, the listing reads the real filesystem, and root lists any directory.
      name: 'unreadable (C3: the op dir cannot be listed)',
      build: async () => ({
        kind: 'unreadable',
        opId: 'x',
        opDir: '/st/x',
        why: 'open-failed',
        errno: 'EIO',
        detail: 'the op dir cannot be listed',
        observed: null,
      }),
    },
  ],
  'no-record': [
    {
      name: 'no-record, owner alive',
      want: { clean: { verdict: 'same-host-alive' } },
      build: async () => classOf(abortLeft('abortAfterCheck'), { ownerProbe: ALIVE }),
    },
    {
      name: 'no-record, owner dead',
      want: { clean: { verdict: 'same-host-dead' } },
      build: async () => classOf(abortLeft('abortAfterCheck'), { ownerProbe: DEAD }),
    },
    {
      name: 'no-record, owner dead + stray',
      build: async () => classOf(stray(await abortLeft('abortAfterCheck')), { ownerProbe: DEAD }),
    },
    {
      name: 'no-record, a verifying move-source intent',
      want: { intent: { valid: true, kind: 'move-source', blocked: null } },
      build: async () => classOf(doctorLeft(), { ownerProbe: ALIVE }),
    },
    {
      name: 'no-record, an abort-new intent',
      want: { intent: { valid: true, kind: 'abort-new' } },
      build: async () => classOf(abortLeft('afterIntent'), { ownerProbe: DEAD }),
    },
    {
      // A verifying move-source intent whose state root doctor was not given: its park is blocked.
      name: 'no-record, a blocked move-source intent',
      want: {
        intent: {
          valid: true,
          kind: 'move-source',
          blocked: expect.stringContaining('is not one doctor discovered or was given'),
        },
        clean: { intentBlocked: expect.stringContaining('is not one doctor discovered') },
      },
      build: async () => classOf(doctorLeft(), { ownerProbe: DEAD, stateRoots: [] }),
    },
    {
      // No state root given or discovered: nowhere to keep new/ into (clean.area null).
      name: 'no-record, no state root',
      want: { intent: null, clean: { area: null, groupsBlocked: null } },
      build: async () =>
        classOf(abortLeft('abortAfterCheck'), { ownerProbe: DEAD, stateRoots: [] }),
    },
    {
      // The backup area is a regular file: it cannot be listed (clean.groupsBlocked).
      name: 'no-record, the backup area cannot be listed',
      want: {
        intent: null,
        clean: { groupsBlocked: expect.stringContaining('could not be listed') },
      },
      build: async () => {
        const st = await abortLeft('abortAfterCheck')
        const area = areaOf(st.fx)
        expect(fs.existsSync(area)).toBe(false)
        fs.mkdirSync(path.dirname(area), { recursive: true })
        fs.writeFileSync(area, 'not a directory\n')
        return classOf(st, { ownerProbe: DEAD })
      },
    },
  ],
  'empty-op-dir': [
    { name: 'empty op dir', build: async () => classOf(replaced((p) => fs.mkdirSync(p))) },
  ],
  'other-user': [
    {
      // Through the classifier: OP's own lstat is denied once the staging listing has kept it,
      // so no owner uid is known.
      name: 'other-user (EACCES on the op dir, through the seam)',
      want: { ownerUid: null, errno: 'EACCES' },
      build: async () => {
        const st = await s2(file())
        return classOf(st, { reader: { statOverride: afterFirstStat(st.opDir, 'EACCES') } })
      },
    },
    {
      // Extra typed literal: the listing of an op dir lstat'ed with a known owner uid is denied.
      // That needs a second user (the seam replaces stat only, and tests run as root).
      name: 'other-user (EACCES)',
      build: async () => ({
        kind: 'other-user',
        opId: 'x',
        opDir: '/x',
        ownerUid: 7,
        errno: 'EACCES',
      }),
    },
  ],
} satisfies Record<Kind, Builder[]>

/** Builds every fixture, checking each is non-empty and classifies as its group's kind. */
export async function allFixtures(): Promise<PlanFixture[]> {
  const out: PlanFixture[] = []
  for (const [kind, builders] of Object.entries(GROUPS) as Array<[Kind, Builder[]]>) {
    expect(builders.length, `group ${kind}`).toBeGreaterThan(0)
    for (const b of builders) {
      const cls = await b.build().catch((e: unknown) => {
        throw new Error(`fixture ${b.name}: ${String(e)}`)
      })
      expect(cls.kind, `${b.name}: ${JSON.stringify(cls).slice(0, 300)}`).toBe(kind)
      if (b.want !== undefined) expect(cls, b.name).toMatchObject(b.want)
      out.push({ name: b.name, kind, cls })
    }
  }
  return out
}
