/**
 * SMI-6531 (A1 step 8-i-a-2): the install record (design § 2, § 6).
 *
 *  - T-FIR1: the sealer's bytes verify; any key removed, added or retyped, or
 *    `op: 'update'` on the install's keys, is `malformed`; the sealer refuses a
 *    `postTree` that is not a hash or is the empty tree's.
 *  - T-FIR2: the scan returns an install record as pending, naming its target;
 *    a write to another skill in the root proceeds; a write to the target is
 *    refused `recovery-pending`, naming the install.
 *  - T-FIR4: each per-op consistency rule makes the record `inconsistent-record`;
 *    the consistent record (same run) is a row.
 *  - The root-wide refusal says "update" only for records that parsed as
 *    updates; a copied install record, or one that does not parse, is an
 *    "operation".
 *  - T-FIR5: prune facts: no `backupDest` from an install record; its own
 *    parked copy (by place, whatever kind prune read) is protected by rule
 *    `live-record` (Q2). Through the real listing: `install.parked.test.ts`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectRecordFacts, protectionOf } from '../../../../src/services/skill-backups.records.js'
import {
  computeInstallRecordSha256,
  EMPTY_TREE_HASH,
  INSTALL_TOP_KEYS,
} from '../../../../src/services/skill-install.record-schema.js'
import type { InstallRecord } from '../../../../src/services/skill-install.record-schema.js'
import { sealInstallRecord } from '../../../../src/services/skill-install.record-seal.js'
import {
  parseRecordBytes,
  verifyRecordBytes,
} from '../../../../src/services/skill-swap.record-schema.js'
import { scanStagingRecords } from '../../../../src/services/skill-swap.records.js'
import { refuseIfRecorded } from '../../../../src/services/skill-swap.scan.js'
import type { SwapState } from '../../../../src/services/skill-swap.ops.js'
import { makeFixture, useTmpCleanup } from '../skill-swap.helpers.js'
import { opReport, s2 } from './recovery.helpers.js'
import { fi0, fi4, installFixture } from './install.helpers.js'
import type { IState } from './install.helpers.js'

useTmpCleanup()

type Body = Omit<InstallRecord, 'recordSha256'>
const bodyOf = (r: InstallRecord): Body => {
  const { recordSha256: _h, ...b } = r
  return structuredClone(b)
}
const bytesOf = (v: unknown): Buffer => Buffer.from(JSON.stringify(v))

describe('T-FIR1: the install record shape', () => {
  it('the sealed bytes verify and parse as an install', () => {
    const st = fi0(installFixture())
    const bytes = fs.readFileSync(path.join(st.opDir, 'record.json'))
    expect(verifyRecordBytes(bytes, st.fx.skillsDir, st.opId)).toMatchObject({
      ok: true,
      record: { op: 'install', opId: st.opId },
    })
  })

  it('every key removed, an extra key, a retyped key, or op "update" is malformed', () => {
    const st = fi0(installFixture())
    const good = st.record as unknown as Record<string, unknown>
    // Positive control in the same run: the unchanged record parses.
    expect(parseRecordBytes(bytesOf(good)).ok).toBe(true)
    const cases: Array<[string, Record<string, unknown>]> = [
      ...INSTALL_TOP_KEYS.map((k): [string, Record<string, unknown>] => {
        const { [k]: _drop, ...rest } = good
        return [`without ${k}`, rest]
      }),
      ['an extra key', { ...good, backupDest: '/x' }],
      ['a retyped pid', { ...good, pid: '1' }],
      ['a retyped postTree', { ...good, postTree: 7 }],
      ['an identity with a number', { ...good, newIdentity: { ...st.record.newIdentity, ino: 1 } }],
      ['op update on the install keys', { ...good, op: 'update' }],
    ]
    expect(cases).toHaveLength(INSTALL_TOP_KEYS.length + 5)
    for (const [name, v] of cases) {
      expect(parseRecordBytes(bytesOf(v)), name).toEqual({ ok: false, why: 'malformed' })
    }
  })

  it('a changed field breaks the hash (the body is inside it)', () => {
    const st = fi0(installFixture())
    const v = { ...st.record, postEntry: { version: '0' } }
    expect(parseRecordBytes(bytesOf(v))).toEqual({ ok: false, why: 'hash-mismatch' })
    expect(computeInstallRecordSha256(bodyOf(st.record))).toBe(st.record.recordSha256)
  })

  it('the sealer refuses an empty-tree or non-hash postTree, and accepts a hash (control)', () => {
    const st = fi0(installFixture())
    const b = bodyOf(st.record)
    for (const postTree of [EMPTY_TREE_HASH, 'abc', 'A'.repeat(64)]) {
      expect(
        sealInstallRecord({ ...b, postTree }, st.fx.skillsDir, st.opId),
        postTree
      ).toMatchObject({
        ok: false,
        why: 'bad-post-tree',
      })
    }
    expect(sealInstallRecord(b, st.fx.skillsDir, st.opId).ok).toBe(true)
    expect(sealInstallRecord(b, '/another/root', st.opId)).toMatchObject({
      ok: false,
      why: 'unreadable',
      detail: 'foreign-root',
    })
  })
})

/** The parts of a state `refuseIfRecorded` reads: the root binding, the target, and the trace. */
function writeState(st: IState, dirName: string): SwapState {
  const realDir = path.join(st.fx.skillsDir, dirName)
  return {
    binding: { root: st.fx.skillsDir, stagingDir: st.fx.staging },
    input: { realDir, comparedPath: realDir },
    options: {},
    blockedBy: null,
  } as unknown as SwapState
}

describe('T-FIR2: the scan treats an install record as pending', () => {
  it('pending, naming its target, with no backupDest; nothing unreadable', async () => {
    const st = fi0(installFixture())
    const scan = await scanStagingRecords(st.fx.skillsDir, st.fx.staging)
    expect(scan).toEqual({
      ok: true,
      unreadable: [],
      pending: [
        {
          opId: st.opId,
          path: path.join(st.opDir, 'record.json'),
          op: 'install',
          comparedPath: st.fx.realDir,
          realDir: st.fx.realDir,
          backupDest: null,
        },
      ],
    })
  })

  it('a write to another skill proceeds; a write to the target is refused, naming the install', async () => {
    const st = fi0(installFixture())
    const other = writeState(st, 'other-skill')
    await expect(refuseIfRecorded(other)).resolves.toBeUndefined()
    expect(other.blockedBy).toBeNull()
    const mine = writeState(st, st.fx.dirName)
    await expect(refuseIfRecorded(mine)).rejects.toMatchObject({
      reason: 'recovery-pending',
      detail: expect.stringContaining(`The last install of ${st.fx.realDir} did not finish`),
    })
    expect(mine.blockedBy).toEqual([st.opId])
  })
})

/** Rewrites OP's record with `mutate` applied, resealed by the production sealer. */
function reseal(st: IState, mutate: (b: Body) => void): void {
  const b = bodyOf(st.record)
  mutate(b)
  const s = sealInstallRecord(b, b.target.skillsDir, st.opId)
  if (!s.ok) throw new Error(`seal: ${s.why} ${s.detail}`)
  fs.writeFileSync(path.join(st.opDir, 'record.json'), s.bytes)
}

describe('T-FIR4: the install consistency rules', () => {
  const rules: Array<[string, (b: Body) => void, string]> = [
    [
      'client',
      (b) => void (b.target.client = 'a/b'),
      'client "a/b" is not a single path component',
    ],
    ['scope', (b) => void (b.target.scope = '..'), 'scope ".." is not a single path component'],
    ['dirName', (b) => void (b.target.dirName = 'x'), 'dirName is not the name of comparedPath'],
    [
      'manifestPath',
      (b) => void (b.target.manifestPath = 'manifest.json'),
      'manifestPath is not an absolute path',
    ],
    [
      'realDir parent',
      (b) => void (b.target.realDir = path.join('/elsewhere', b.target.dirName)),
      'realDir is not directly inside the skills root',
    ],
    [
      'realDir name',
      (b) => void (b.target.realDir = path.join(b.target.skillsDir, 'other')),
      'realDir is not the skills root plus dirName',
    ],
    ['port', (b) => void (b.postEntry = null), 'the manifest port rejects'],
  ]
  for (const [name, mutate, detail] of rules) {
    it(`${name}: inconsistent-record; the unchanged record is a row (control)`, async () => {
      const st = fi0(installFixture())
      expect((await opReport(st)).cls).toMatchObject({ kind: 'state', state: 'FI0' })
      reseal(st, mutate)
      expect((await opReport(st)).cls).toMatchObject({
        kind: 'unreadable',
        why: 'inconsistent-record',
        detail: expect.stringContaining(detail),
      })
    })
  }

  it('postTree that is not a hash: inconsistent-record (the sealer would refuse it; bytes made here)', async () => {
    const st = fi0(installFixture())
    const b = { ...bodyOf(st.record), postTree: 'not-a-hash' }
    const bytes = bytesOf({ ...b, recordSha256: computeInstallRecordSha256(b) })
    fs.writeFileSync(path.join(st.opDir, 'record.json'), bytes)
    expect((await opReport(st)).cls).toMatchObject({
      kind: 'unreadable',
      why: 'inconsistent-record',
      detail: 'postTree is not a tree hash',
    })
  })

  it('postTree of the empty tree: inconsistent-record; a built tree’s hash is a row (control)', async () => {
    const st = fi0(installFixture())
    expect((await opReport(st)).cls).toMatchObject({ kind: 'state', state: 'FI0' })
    const b = { ...bodyOf(st.record), postTree: EMPTY_TREE_HASH }
    const bytes = bytesOf({ ...b, recordSha256: computeInstallRecordSha256(b) })
    fs.writeFileSync(path.join(st.opDir, 'record.json'), bytes)
    expect((await opReport(st)).cls).toMatchObject({
      kind: 'unreadable',
      why: 'inconsistent-record',
      detail: "postTree is not a built tree's hash",
    })
  })
})

describe('the root-wide refusal names the kind of operation only when it is known', () => {
  /** Copies `from`'s record into another op dir of `st`'s root: it parses, but names another op dir. */
  function copyRecordInto(st: IState, from: string): void {
    const dir = path.join(st.fx.staging, 'e'.repeat(32))
    fs.mkdirSync(dir)
    fs.copyFileSync(from, path.join(dir, 'record.json'))
  }
  const refusal = async (st: IState) => {
    const other = writeState(st, 'other-skill')
    let detail = ''
    await refuseIfRecorded(other).catch((e: { reason: string; detail: string }) => {
      expect(e.reason).toBe('recovery-record-unreadable')
      detail = e.detail
    })
    return detail
  }

  it('a copied install record: "unfinished operation"; a copied update record: "unfinished update"', async () => {
    const st = fi0(installFixture())
    copyRecordInto(st, path.join(st.opDir, 'record.json'))
    const scan = await scanStagingRecords(st.fx.skillsDir, st.fx.staging)
    expect(scan.ok && scan.unreadable).toEqual([
      expect.objectContaining({ why: 'foreign-op-dir', op: 'install' }),
    ])
    expect(await refusal(st)).toContain('A record of an unfinished operation in')

    const u = await s2(makeFixture({ 'SKILL.md': '# v1\n' }))
    const v = fi0(installFixture())
    copyRecordInto(v, path.join(u.opDir, 'record.json'))
    expect(await refusal(v)).toContain('A record of an unfinished update in')
  })

  it('a record that does not parse: its kind is unknown, so "operation"', async () => {
    const st = fi0(installFixture())
    const dir = path.join(st.fx.staging, 'e'.repeat(32))
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'record.json'), '{')
    expect(await refusal(st)).toContain('A record of an unfinished operation in')
  })
})

describe('T-FIR5: prune facts of a live install record', () => {
  it('no backupDest; its own parked copy is protected live-record, a copy elsewhere is not', async () => {
    const st = await fi4(installFixture())
    const facts = await collectRecordFacts([st.fx.skillsDir])
    const recordPath = path.join(st.opDir, 'record.json')
    expect(facts.live.get(st.opId)).toBe(recordPath)
    expect(facts.liveInstalls?.get(st.opId)).toEqual({ path: recordPath, realDir: st.fx.realDir })
    expect([...(facts.backupDests?.keys() ?? [])]).toEqual([])
    const q = (kind: string) => ({
      copyPath: st.parked,
      opId: st.opId,
      kind,
      sourceUnchanged: null,
      store: 'parked' as const,
    })
    expect(protectionOf(facts, new Map(), q('install-rollback'))).toEqual({
      status: 'protected',
      rule: 'live-record',
      path: recordPath,
    })
    // Whatever kind prune read for it (none, for a held park or no sidecar): the place decides.
    expect(protectionOf(facts, new Map(), { ...q('install-rollback'), kind: null })).toMatchObject({
      status: 'protected',
    })
    // A copy with the same opId anywhere else is not this rule's (another area, another name).
    const elsewhere = path.join(
      st.fx.staging,
      '.skillsmith-parked',
      st.opId,
      `${st.fx.dirName}-0123abcd`
    )
    expect(
      protectionOf(facts, new Map(), { ...q('install-rollback'), copyPath: elsewhere })
    ).toEqual({
      status: 'unprotected',
    })
    const renamed = path.join(path.dirname(st.parked), 'other-skill-0123abcd')
    expect(protectionOf(facts, new Map(), { ...q('install-rollback'), copyPath: renamed })).toEqual(
      {
        status: 'unprotected',
      }
    )
    // A backup-store copy of the opId stays covered by rule (b), as before.
    expect(protectionOf(facts, new Map(), { ...q('unused-new'), store: 'backup' })).toMatchObject({
      status: 'protected',
      rule: 'live-record',
    })
  })

  it('once the record is gone, the parked copy is unprotected', async () => {
    const st = await fi4(installFixture())
    fs.rmSync(st.opDir, { recursive: true })
    const facts = await collectRecordFacts([st.fx.skillsDir])
    expect(facts.live.size).toBe(0)
    expect(
      protectionOf(facts, new Map(), {
        copyPath: st.parked,
        opId: st.opId,
        kind: 'install-rollback',
        sourceUnchanged: null,
        store: 'parked',
      })
    ).toEqual({ status: 'unprotected' })
  })
})
