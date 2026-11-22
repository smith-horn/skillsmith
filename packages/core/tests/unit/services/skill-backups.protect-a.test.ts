/**
 * SMI-6531 (A1 step 6c-ii-b): UD61(a) as its own fact (design note M-P3): a
 * live record's `backupDest` protects that exact tree, named `backup-dest`,
 * whatever its opId or kind. The scan carries `backupDest` from the verified
 * record; `collectRecordFacts` maps each to its record; `protectionOf` checks
 * it before rules (b) and (c).
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectRecordFacts, protectionOf } from '../../../src/services/skill-backups.records.js'
import type { RecordFacts } from '../../../src/services/skill-backups.records.js'
import { scanStagingRecords } from '../../../src/services/skill-swap.records.js'
import { computeRecordSha256 } from '../../../src/services/skill-swap.js'
import type { SwapRecord } from '../../../src/services/skill-swap.js'
import { listBackups } from '../../../src/services/skill-backups.listing.js'
import { makeBackup } from '../install/prune.list.helpers.js'
import { hermetic, mkBase } from './skill-backups.helpers.js'

const bases: string[] = []
afterEach(() => {
  for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true })
})
const ident = { dev: '1', ino: '2', birthtimeNs: '3', fmt: '4' }

/** A verified live record of `root` for `opId`, whose `backupDest` is `dest`. */
function putRecord(root: string, opId: string, dest: string): string {
  const realDir = path.join(root, 'foo')
  const body = {
    schema: 1,
    op: 'update',
    opId,
    pid: 1,
    host: 'h',
    uid: 1,
    target: {
      comparedPath: realDir,
      realDir,
      skillsDir: root,
      manifestPath: path.join(root, 'manifest.json'),
      manifestKey: 'foo',
      client: 'claude-code',
      scope: 'global',
      dirName: 'foo',
    },
    rootIdentity: { ...ident },
    opDirIdentity: { ...ident },
    oldIdentity: { ...ident },
    newIdentity: { ...ident },
    preTree: 'pre',
    postTree: 'post',
    preEntry: { version: '1.0.0' },
    postEntry: { version: '2.0.0' },
    backupDest: dest,
  } as Omit<SwapRecord, 'recordSha256'>
  const dir = path.join(root, '.skillsmith-staging', opId)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'record.json')
  fs.writeFileSync(file, JSON.stringify({ ...body, recordSha256: computeRecordSha256(body) }))
  return file
}

function setup(): { root: string; dest: string; rec: string } {
  const b = mkBase('protect-a-')
  bases.push(b)
  const root = path.join(b, 'skills')
  fs.mkdirSync(root)
  const dest = path.join(b, '.skillsmith', 'backups', 'update', 'claude-code', 'k', 'foo', 'op-a')
  return { root, dest, rec: putRecord(root, 'op-a', dest) }
}

describe('UD61(a): the backupDest fact', () => {
  it('the scan carries the verified record’s backupDest', async () => {
    const { root, dest, rec } = setup()
    const scan = await scanStagingRecords(root, path.join(root, '.skillsmith-staging'))
    expect(scan).toEqual({
      ok: true,
      pending: [
        {
          opId: 'op-a',
          path: rec,
          op: 'update',
          comparedPath: path.join(root, 'foo'),
          realDir: path.join(root, 'foo'),
          backupDest: dest,
        },
      ],
      unreadable: [],
    })
  })

  it('collectRecordFacts maps each backupDest to its record', async () => {
    const { root, dest, rec } = setup()
    const facts = await collectRecordFacts([root])
    expect([...(facts.backupDests ?? new Map())]).toEqual([[dest, rec]])
  })

  it('M-P3: the tree at backupDest is protected and the rule is named backup-dest', async () => {
    const { root, dest, rec } = setup()
    const facts = await collectRecordFacts([root])
    const none = new Map<string, string>()
    expect(
      protectionOf(facts, none, {
        copyPath: dest,
        opId: 'op-a',
        kind: 'backup',
        sourceUnchanged: null,
      })
    ).toEqual({ status: 'protected', rule: 'backup-dest', path: rec })
  })

  it('M-P3: without rule (b) (an opId no record has), the tree at backupDest is still protected by (a)', async () => {
    const { root, dest, rec } = setup()
    const facts = await collectRecordFacts([root])
    const q = { copyPath: dest, opId: 'op-other', kind: 'undone', sourceUnchanged: null }
    expect(protectionOf(facts, new Map(), q)).toEqual({
      status: 'protected',
      rule: 'backup-dest',
      path: rec,
    })
  })

  it('M-P3: (a) has no partial-copy exception, unlike (b)', () => {
    const facts: RecordFacts = {
      live: new Map([['op-a', '/r/st/op-a/record.json']]),
      backupDests: new Map([['/a/op-a.partial-copy', '/r/st/op-a/record.json']]),
      unreadable: [],
      scanFailures: [],
    }
    const q = (copyPath: string) =>
      protectionOf(facts, new Map(), {
        copyPath,
        opId: 'op-a',
        kind: 'partial-copy',
        sourceUnchanged: true,
      })
    expect(q('/a/op-a.partial-copy')).toMatchObject({ status: 'protected', rule: 'backup-dest' })
    expect(q('/a/op-a.partial-copy.2')).toEqual({ status: 'unprotected' })
  })

  it('the listing names rule backup-dest for the tree a live record names (end to end)', async () => {
    const b = mkBase('protect-a-list-')
    bases.push(b)
    const claude = path.join(b, 'clients', 'claude-code')
    const state = path.join(b, '.skillsmith')
    const bk = makeBackup({ state, skillsDir: claude, opId: 'op-a' })
    const rec = putRecord(claude, 'op-a', bk.copyPath)
    const l = await listBackups({ stateRoot: state, discovery: hermetic(b) })
    const row = l.backups.flatMap((s) => s.areas.flatMap((a) => a.rows))[0]!
    expect(row.copy.copyPath).toBe(bk.copyPath)
    expect(row.protection).toEqual({ status: 'protected', rule: 'backup-dest', path: rec })
  })

  it('control: another path, with neither (a) nor (b), is unprotected', async () => {
    const { root, dest } = setup()
    const facts = await collectRecordFacts([root])
    const q = {
      copyPath: `${dest}.undone`,
      opId: 'op-other',
      kind: 'undone',
      sourceUnchanged: null,
    }
    expect(protectionOf(facts, new Map(), q)).toEqual({ status: 'unprotected' })
  })
})
