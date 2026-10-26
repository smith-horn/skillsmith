/**
 * SMI-6531 (A1 step 6a-i): what the classifier says before a row can match
 * (empty, no record, unreadable, inconsistent, another user's), role
 * resolution's refusals, and the publish sub-states (T-J9, T-J10's state
 * halves; plan §3.3 "Publish sub-states", "The one-device sidecar rewrite").
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyOp } from '../../../../src/services/skill-recovery.classify.js'
import { ClassifierReader } from '../../../../src/services/skill-recovery.reader.js'
import { computeRecordSha256 } from '../../../../src/services/skill-swap.js'
import type { SwapRecord } from '../../../../src/services/skill-swap.js'
import type { KeepGroup, PState } from '../../../../src/services/skill-recovery.types.js'
import { makeFixture, OP_ID, useTmpCleanup } from '../skill-swap.helpers.js'
import { opDirOf, opIdN, otherSkill } from '../skill-swap.scan.helpers.js'
import {
  copyTree,
  destOf,
  journalOf,
  keepTree,
  opReport,
  report,
  s0,
  s1,
  s2,
  sidecarFor,
  writeEntry,
  writeJournalLine,
} from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'

useTmpCleanup()

const file = () => makeFixture({ 'SKILL.md': '# v1\n' })

describe('an op dir with no verified record', () => {
  it('empty: listed as empty-op-dir, beside a crashed op dir that is a row', async () => {
    const fx = file()
    const st = await s2(fx)
    fs.mkdirSync(opDirOf(fx, opIdN('e')))
    const root = await report(st)
    const kinds = Object.fromEntries(root.ops.map((o) => [o.opId, o.cls.kind]))
    expect(kinds).toEqual({ [OP_ID]: 'state', [opIdN('e')]: 'empty-op-dir' })
  })

  it('no record.json: no-record, with its owner, entries and park intent', async () => {
    const fx = file()
    const st = await s2(fx)
    const dir = opDirOf(fx, opIdN('b'))
    fs.mkdirSync(path.join(dir, 'new'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: 4242, host: 'h', uid: 7 }))
    fs.writeFileSync(path.join(dir, 'park-intent.json'), '{}')
    fs.writeFileSync(path.join(dir, 'record.json.tmp'), 'half a record')
    const root = await report(st)
    const op = root.ops.find((o) => o.opId === opIdN('b'))!
    expect(op.cls).toMatchObject({
      kind: 'no-record',
      owner: { pid: 4242, host: 'h', uid: 7 },
      hasParkIntent: true,
      recordTmp: path.join(dir, 'record.json.tmp'),
    })
    if (op.cls.kind === 'no-record') expect(op.cls.entries).toContain('new')
    expect(root.ops.find((o) => o.opId === OP_ID)!.cls.kind).toBe('state')
  })

  it('an unparseable owner.json is listed with nothing known about its owner', async () => {
    const fx = file()
    const st = await s2(fx)
    const dir = opDirOf(fx, opIdN('c'))
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'owner.json'), 'not json')
    const op = (await report(st)).ops.find((o) => o.opId === opIdN('c'))!
    expect(op.cls).toMatchObject({ kind: 'no-record', owner: { pid: null, host: null, uid: null } })
  })

  it("a stat that is denied is another user's op dir; the same op dir un-denied is a row", async () => {
    const fx = file()
    const st = await s2(fx)
    const ctx = {
      root: fs.realpathSync(fx.skillsDir),
      stagingDir: fx.staging,
      euid: process.geteuid?.() ?? 0,
      journalFile: journalOf(fx),
    }
    const denied = await classifyOp(
      new ClassifierReader({
        statOverride: (p, real) => (p === st.opDir ? { ok: false, errno: 'EACCES' } : real),
      }),
      ctx,
      st.opId
    )
    expect(denied).toMatchObject({ kind: 'other-user', errno: 'EACCES' })
    expect((await classifyOp(new ClassifierReader(), ctx, st.opId)).kind).toBe('state')
  })
})

/** Rewrites `record.json` in place with `mutate` applied to its body, re-hashed. */
function rewriteRecord(st: State, mutate: (b: Omit<SwapRecord, 'recordSha256'>) => void): void {
  const recPath = path.join(st.opDir, 'record.json')
  const { recordSha256: _h, ...body } = JSON.parse(fs.readFileSync(recPath, 'utf8')) as SwapRecord
  mutate(body)
  fs.writeFileSync(recPath, JSON.stringify({ ...body, recordSha256: computeRecordSha256(body) }))
}

describe('an unreadable record', () => {
  const corruptions: Array<[string, string, (st: State) => void]> = [
    [
      'not json',
      'not-json',
      (st) => fs.writeFileSync(path.join(st.opDir, 'record.json'), '{ nope'),
    ],
    [
      'malformed',
      'malformed',
      (st) => fs.writeFileSync(path.join(st.opDir, 'record.json'), '{"schema":1}'),
    ],
    [
      'hash mismatch',
      'hash-mismatch',
      (st) => {
        const p = path.join(st.opDir, 'record.json')
        const rec = JSON.parse(fs.readFileSync(p, 'utf8')) as SwapRecord
        rec.pid += 1
        fs.writeFileSync(p, JSON.stringify(rec))
      },
    ],
    [
      'a directory',
      'not-a-file',
      (st) => {
        fs.rmSync(path.join(st.opDir, 'record.json'))
        fs.mkdirSync(path.join(st.opDir, 'record.json'))
      },
    ],
  ]
  for (const [label, why, corrupt] of corruptions) {
    it(`${label}: unreadable (${why}), beside a neighbour that classifies`, async () => {
      const fx = file()
      const other = otherSkill(fx, 'other-skill', { 'SKILL.md': '# other\n' })
      const good = await s2(other, opIdN('b'))
      const bad = await s2(fx)
      corrupt(bad)
      const root = await report(bad)
      const byId = new Map(root.ops.map((o) => [o.opId, o.cls]))
      expect(byId.get(OP_ID)).toMatchObject({ kind: 'unreadable', why })
      expect(byId.get(good.opId)?.kind).toBe('state')
    })
  }

  const inconsistent: Array<[string, (b: Omit<SwapRecord, 'recordSha256'>) => void]> = [
    ['an op that is not update', (b) => void ((b as { op: string }).op = 'install')],
    ['a client that is not one path component', (b) => void (b.target.client = '../x')],
    ['a scope that is not one path component', (b) => void (b.target.scope = 'a/b')],
    ['a dirName that is not the name of comparedPath', (b) => void (b.target.dirName = 'other')],
    ['a manifestPath that is not absolute', (b) => void (b.target.manifestPath = 'manifest.json')],
    [
      'a manifestPath not named manifest.json',
      (b) =>
        void (b.target.manifestPath = path.join(path.dirname(b.target.manifestPath), 'm.json')),
    ],
    [
      'a realDir not directly inside the root',
      (b) => void (b.target.realDir = path.join(b.target.realDir, 'sub')),
    ],
    [
      'a backupDest that is not the area plus the opId',
      (b) => void (b.backupDest = `${b.backupDest}x`),
    ],
    ['entries the manifest port rejects', (b) => void (b.postEntry = b.preEntry)],
  ]
  for (const [label, mutate] of inconsistent) {
    it(`${label}: unreadable (inconsistent-record), the remedy --park`, async () => {
      const fx = file()
      const st = await s2(fx)
      expect((await opReport(st)).cls.kind).toBe('state')
      rewriteRecord(st, mutate)
      const op = await opReport(st)
      expect(op.cls).toMatchObject({ kind: 'unreadable', why: 'inconsistent-record' })
    })
  }
})

describe('role resolution refuses what is not exactly one of source, keep or nothing', () => {
  it('two verified keeps for one role are anything else; one is the post-keep row', async () => {
    const fx = file()
    const st = await s0(fx)
    const first = keepTree(st, 'new', 'unused-new')
    const op1 = await opReport(st)
    expect(op1.cls).toMatchObject({ kind: 'state', state: 'S0', postKeep: true })
    // A second verified keep of the same role: a copy of the first, kept as another kind.
    const second = destOf(st, 'edited-new')
    copyTree(first, second)
    fs.writeFileSync(`${second}.json`, JSON.stringify(sidecarFor(st, second, 'edited-new')))
    const op2 = await opReport(st)
    expect(op2.cls.kind).toBe('anything-else')
    if (op2.cls.kind === 'anything-else') expect(op2.cls.reason).toContain('2 kept copies')
  })

  it('a keep that does not verify (its tree hash differs from its sidecar) is not a keep', async () => {
    const fx = file()
    const st = await s2(fx)
    const dest = keepTree(st, 'old', 'backup')
    expect((await opReport(st)).cls).toMatchObject({ kind: 'state', postKeep: true })
    fs.writeFileSync(path.join(dest, 'SKILL.md'), '# edited after it was kept\n')
    const op = await opReport(st)
    // O is neither a source nor a verified keep any more.
    expect(op.cls.kind).toBe('anything-else')
  })

  it('a sidecar that names another operation is a keep none of the sub-states names', async () => {
    const fx = file()
    const st = await s2(fx)
    keepTree(st, 'old', 'backup', { move: false, over: { opId: opIdN('f') } })
    const op = await opReport(st)
    expect(op.cls.kind).toBe('anything-else')
    if (op.cls.kind === 'anything-else') expect(op.cls.reason).toContain('sidecar')
  })

  it('a post-keep O is S2 or S3 by the manifest alone', async () => {
    const fx = file()
    const st = await s2(fx)
    keepTree(st, 'old', 'backup')
    writeEntry(fx, { version: '2.0.0' })
    expect((await opReport(st)).cls).toMatchObject({ state: 'S3', postKeep: true })
  })
})

function groupsOf(op: Awaited<ReturnType<typeof opReport>>): KeepGroup[] {
  if (op.cls.kind === 'state' || op.cls.kind === 'ab' || op.cls.kind === 'identity-changed') {
    return op.cls.facts.groups
  }
  if (op.cls.kind === 'anything-else' && op.cls.facts !== null) return op.cls.facts.groups
  throw new Error(`no facts on ${op.cls.kind}`)
}

async function stateOfBackup(st: State): Promise<PState | null> {
  return groupsOf(await opReport(st)).find((g) => g.kind === 'backup')?.state ?? null
}

describe('T-J9: the publish sub-states, read from the sidecar and where the tree is', () => {
  it('P0: a sidecar temp only, the tree still in OP', async () => {
    const fx = file()
    const st = await s2(fx)
    const dest = destOf(st, 'backup')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(`${dest}.json.tmp`, '')
    const op = await opReport(st)
    expect(await stateOfBackup(st)).toBe('P0')
    expect(op.cls).toMatchObject({ kind: 'state', state: 'S2' })
    const g = groupsOf(op)[0]!
    expect(g.sidecarTmp?.emptySingleLink).toBe(true)
  })

  it('P1: the sidecar published, the tree still in OP; a changed source is hashChanged', async () => {
    const fx = file()
    const st = await s2(fx)
    keepTree(st, 'old', 'backup', { move: false })
    expect(await stateOfBackup(st)).toBe('P1')
    expect(groupsOf(await opReport(st))[0]!.hashChanged).toBe(false)
    fs.writeFileSync(path.join(st.opDir, 'old', 'SKILL.md'), '# edited after the sidecar\n')
    expect(groupsOf(await opReport(st))[0]!.hashChanged).toBe(true)
  })

  it('P5: the tree kept and gone from OP; a P4 (source still there) is a different state', async () => {
    const fx = file()
    const st = await s2(fx)
    keepTree(st, 'old', 'backup')
    expect(await stateOfBackup(st)).toBe('P5')

    const fx2 = file()
    const st2 = await s2(fx2)
    // P4: copied across devices, the source left in OP (UD28).
    keepTree(st2, 'old', 'backup', { move: false })
    copyTree(path.join(st2.opDir, 'old'), destOf(st2, 'backup'))
    expect(await stateOfBackup(st2)).toBe('P4')
    const groups = groupsOf(await opReport(st2))
    expect(groups[0]!.crossDevice).toBe(true)
  })

  it('P4 whose source changed after the copy is not P4: anything else, and --abandon only', async () => {
    const fx = file()
    const st = await s2(fx)
    keepTree(st, 'old', 'backup', { move: false })
    copyTree(path.join(st.opDir, 'old'), destOf(st, 'backup'))
    fs.writeFileSync(path.join(st.opDir, 'old', 'SKILL.md'), '# changed after the copy\n')
    const op = await opReport(st)
    expect(op.cls.kind).toBe('anything-else')
  })

  it('P2: a copy temp that does not match; P3: one that does', async () => {
    const fx = file()
    const st = await s2(fx)
    keepTree(st, 'old', 'backup', { move: false })
    const tmpTree = path.join(path.dirname(destOf(st, 'backup')), `.tmp-${st.opId}`)
    fs.mkdirSync(tmpTree)
    fs.writeFileSync(path.join(tmpTree, 'SKILL.md'), '# half a copy\n')
    expect(await stateOfBackup(st)).toBe('P2')
    fs.rmSync(tmpTree, { recursive: true })
    copyTree(path.join(st.opDir, 'old'), tmpTree)
    expect(await stateOfBackup(st)).toBe('P3')
  })

  it('a tree and a copy temp both at their names is unclassified, never a sub-state', async () => {
    const fx = file()
    const st = await s2(fx)
    keepTree(st, 'old', 'backup', { move: false })
    copyTree(path.join(st.opDir, 'old'), destOf(st, 'backup'))
    copyTree(
      path.join(st.opDir, 'old'),
      path.join(path.dirname(destOf(st, 'backup')), `.tmp-${st.opId}`)
    )
    expect(await stateOfBackup(st)).toBeNull()
    expect((await opReport(st)).cls.kind).toBe('anything-else')
  })
})

describe('the one-device sidecar rewrite (R1-R3)', () => {
  const tmpOf = (st: State): string => `${destOf(st, 'backup')}.json.tmp`

  it("R1: the old sidecar and a different temp, the temp this op's with the source's hash", async () => {
    const fx = file()
    const st = await s2(fx)
    keepTree(st, 'old', 'backup', { move: false })
    fs.writeFileSync(path.join(st.opDir, 'old', 'SKILL.md'), '# edited after the sidecar\n')
    fs.writeFileSync(
      tmpOf(st),
      JSON.stringify(sidecarFor(st, path.join(st.opDir, 'old'), 'backup'))
    )
    expect(await stateOfBackup(st)).toBe('R1')
    const g = groupsOf(await opReport(st))[0]!
    expect(g.sidecarTmp).toMatchObject({ thisOps: true, sameInodeAsSidecar: false })
  })

  it("R2: the old sidecar unlinked, the temp this op's, the source present, dest absent", async () => {
    const fx = file()
    const st = await s2(fx)
    const dest = destOf(st, 'backup')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(
      tmpOf(st),
      JSON.stringify(sidecarFor(st, path.join(st.opDir, 'old'), 'backup'))
    )
    expect(await stateOfBackup(st)).toBe('R2')
  })

  it('R3: the sidecar and the temp are the same inode', async () => {
    const fx = file()
    const st = await s2(fx)
    keepTree(st, 'old', 'backup', { move: false })
    fs.linkSync(`${destOf(st, 'backup')}.json`, tmpOf(st))
    expect(await stateOfBackup(st)).toBe('R3')
  })

  it("a temp of another op in the same place is not R2: it is not this op's", async () => {
    const fx = file()
    const st = await s2(fx)
    const dest = destOf(st, 'backup')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(
      tmpOf(st),
      JSON.stringify(sidecarFor(st, path.join(st.opDir, 'old'), 'backup', { opId: opIdN('f') }))
    )
    expect(await stateOfBackup(st)).not.toBe('R2')
  })
})

describe('AB, and a record.json.tmp beside the record', () => {
  it('a sidecar of kind abandoned-* for this op is AB', async () => {
    const fx = file()
    const st = await s2(fx)
    keepTree(st, 'old', 'abandoned-old', { move: false })
    const op = await opReport(st)
    expect(op.cls.kind).toBe('ab')
    if (op.cls.kind === 'ab') expect(op.cls.abandoned).toEqual([`${st.opId}.abandoned-old`])
  })

  it("a record.json.tmp that is not provably this op's makes the op anything else", async () => {
    const fx = file()
    const st = await s2(fx)
    fs.writeFileSync(path.join(st.opDir, 'record.json.tmp'), "someone else's bytes")
    const op = await opReport(st)
    expect(op.cls.kind).toBe('anything-else')
    if (op.cls.kind === 'anything-else') expect(op.cls.reason).toContain('record.json.tmp')
  })

  it('an empty single-link record.json.tmp is provably nothing: the op still classifies', async () => {
    const fx = file()
    const st = await s2(fx)
    fs.writeFileSync(path.join(st.opDir, 'record.json.tmp'), '')
    expect((await opReport(st)).cls.kind).toBe('state')
  })

  it('a record.json.tmp carrying a full-device marker beside a matching record marks the op', async () => {
    const fx = file()
    const st = await s2(fx)
    const recPath = path.join(st.opDir, 'record.json')
    const { recordSha256: _h, ...body } = JSON.parse(fs.readFileSync(recPath, 'utf8')) as SwapRecord
    const marked = {
      ...body,
      fullDevice: { cause: 'ENOSPC', stage: 'copy', area: '/a', opId: st.opId, dest: '/a/x' },
    } as Omit<SwapRecord, 'recordSha256'>
    fs.writeFileSync(
      path.join(st.opDir, 'record.json.tmp'),
      JSON.stringify({ ...marked, recordSha256: computeRecordSha256(marked) })
    )
    const op = await opReport(st)
    expect(op.cls.kind).toBe('state')
    if (op.cls.kind === 'state') expect(op.cls.facts.fullDevice).toMatchObject({ cause: 'ENOSPC' })
  })

  it('a record.json.tmp with a marker but another body leaves both and is unreadable', async () => {
    const fx = file()
    const st = await s2(fx)
    const recPath = path.join(st.opDir, 'record.json')
    const { recordSha256: _h, ...body } = JSON.parse(fs.readFileSync(recPath, 'utf8')) as SwapRecord
    const marked = {
      ...body,
      pid: body.pid + 1,
      fullDevice: { cause: 'ENOSPC', stage: 'copy', area: '/a', opId: st.opId, dest: '/a/x' },
    } as Omit<SwapRecord, 'recordSha256'>
    fs.writeFileSync(
      path.join(st.opDir, 'record.json.tmp'),
      JSON.stringify({ ...marked, recordSha256: computeRecordSha256(marked) })
    )
    expect((await opReport(st)).cls).toMatchObject({
      kind: 'unreadable',
      why: 'inconsistent-record',
    })
  })
})

describe('the audit journal is a derived fact, and a torn tail does not hide it', () => {
  it('present, absent and torn are all reported; a non-update line with the opId is not present', async () => {
    const fx = file()
    const st = await s1(fx)
    const read = async () => {
      const c = (await opReport(st)).cls
      if (c.kind !== 'state') throw new Error(c.kind)
      return c.facts.journal
    }
    expect(await read()).toMatchObject({ present: false, torn: false })
    writeJournalLine(fx, st.opId, 'apply')
    expect(await read()).toMatchObject({ present: false })
    writeJournalLine(fx, st.opId, 'update')
    expect(await read()).toMatchObject({ present: true, torn: false })
    writeJournalLine(fx, opIdN('f'), 'update', true)
    expect(await read()).toMatchObject({ present: true, torn: true })
  })
})
