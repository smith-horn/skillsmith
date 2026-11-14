/**
 * SMI-6531 (A1 step 6c-ii-a): the governance round-2 findings on `listBackups`.
 *
 *  F1  a refused or unreadable store, area or level counts as unmeasured, so the
 *      space warning's "could not be measured" arm fires (it was silent);
 *  F2  `--client` counts what it left out, by kind;
 *  F3  `scope.areaPaths` narrows what is shown, never UD61 rule (c) or the warning;
 *  F4  protection is three-way: protected, unprotected, or unknown;
 *  F5  a symlinked `.skillsmith-staging` is not followed.
 *
 * Refusals are reached through an injected `lstatSync` owner (portable: the
 * suite does not need root to `chown`), and every one asserts the refusal's own
 * reason first, so a fixture that fails to refuse shows as such.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listBackups } from '../../../src/services/skill-backups.listing.js'
import { protectionOf } from '../../../src/services/skill-backups.records.js'
import type { RecordFacts } from '../../../src/services/skill-backups.records.js'
import { makeBackup } from '../../unit/install/prune.list.helpers.js'
import { hermetic, mkBase, parkAt } from './skill-backups.helpers.js'

const bases: string[] = []
const base = (): string => {
  const b = mkBase()
  bases.push(b)
  return b
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true })
})

const claude = (b: string): string => path.join(b, 'clients', 'claude-code')
/** The threshold is out of reach, so only the "could not be measured" arm can warn. */
const quietCap = { statfs: () => ({ bavail: 1e12, bsize: 1 }), capBytes: 1e12 }

/** `lstatSync(target)` reports another owner; everything else passes through. */
function ownedByAnother(target: string): void {
  const real = fs.lstatSync.bind(fs) as (...a: unknown[]) => unknown
  vi.spyOn(fs, 'lstatSync').mockImplementation(((p: unknown, ...rest: unknown[]) => {
    const st = real(p, ...rest)
    if (p === target && typeof st === 'object' && st !== null) {
      return Object.defineProperty(Object.create(st), 'uid', { value: 1234n })
    }
    return st
  }) as typeof fs.lstatSync)
}

describe('F1: a refused area, level or store counts as unmeasured', () => {
  it('a parked area owned by another user (with a copy in it) fires the unmeasured arm', async () => {
    const b = base()
    parkAt(claude(b), 'big')
    const areaDir = path.join(claude(b), '.skillsmith-parked')
    // Control: unrefused, the same quiet threshold does not warn and nothing is unmeasured.
    const ok = await listBackups({ discovery: hermetic(b), usage: quietCap })
    expect(ok.parked.flatMap((a) => a.rows)).toHaveLength(1)
    expect(ok.warning.warn).toBe(false)
    expect(ok.unmeasured).toBe(0)
    ownedByAnother(areaDir)
    const l = await listBackups({ discovery: hermetic(b), usage: quietCap })
    const view = l.parked.find((a) => a.ref.areaDir === areaDir)
    expect(view?.refused).toMatch(/owned by another user/)
    expect(l.unmeasured).toBeGreaterThan(0)
    expect(l.warning.warn).toBe(true)
    expect(l.warning.message).toMatch(/could not be measured/)
  })

  it('a backup level owned by another user fires it too', async () => {
    const b = base()
    const state = path.join(b, '.skillsmith')
    const bk = makeBackup({ state, skillsDir: claude(b), dirName: 'one', opId: 'op-1' })
    ownedByAnother(path.join(bk.updateDir, 'claude-code'))
    const l = await listBackups({ stateRoot: state, discovery: hermetic(b), usage: quietCap })
    expect(l.backups[0]!.anomalies.map((a) => a.detail)).toContain(
      'owned by another user; not listed'
    )
    expect(l.unmeasured).toBeGreaterThan(0)
    expect(l.warning.warn).toBe(true)
  })

  it('a backup store owned by another user fires it', async () => {
    const b = base()
    const state = path.join(b, '.skillsmith')
    const bk = makeBackup({ state, skillsDir: claude(b), dirName: 'one', opId: 'op-1' })
    ownedByAnother(bk.updateDir)
    const l = await listBackups({ stateRoot: state, discovery: hermetic(b), usage: quietCap })
    expect(l.backups[0]!.refused).toMatch(/owned by another user/)
    expect(l.unmeasured).toBeGreaterThan(0)
    expect(l.warning.warn).toBe(true)
  })

  it('an old MCP store that cannot be read (EACCES) fires it', async () => {
    const b = base()
    const mcp = path.join(claude(b), '.backups')
    fs.mkdirSync(path.join(mcp, 'some-skill'), { recursive: true })
    const real = fs.lstatSync.bind(fs) as (...a: unknown[]) => unknown
    vi.spyOn(fs, 'lstatSync').mockImplementation(((p: unknown, ...rest: unknown[]) => {
      if (p === mcp) throw Object.assign(new Error('denied'), { code: 'EACCES' })
      return real(p, ...rest)
    }) as typeof fs.lstatSync)
    const l = await listBackups({ discovery: hermetic(b), usage: quietCap })
    expect(l.mcpStores).toEqual([])
    expect(l.unmeasured).toBeGreaterThan(0)
    expect(l.warning.warn).toBe(true)
  })

  it('negative: a stray hidden file in the area is an anomaly but does not warn', async () => {
    const b = base()
    parkAt(claude(b), 'one')
    fs.writeFileSync(path.join(claude(b), '.skillsmith-parked', '.DS_Store'), 'x')
    const l = await listBackups({ discovery: hermetic(b), usage: quietCap })
    expect(l.parked.flatMap((a) => a.anomalies).map((x) => x.detail)).toEqual([
      'unrecognised hidden entry; never touched',
    ])
    expect(l.unmeasured).toBe(0)
    expect(l.warning.warn).toBe(false)
  })
})

describe('F2: --client counts what it left out', () => {
  it('a parked copy of another client, and another client area with its temps, are counted by kind', async () => {
    const b = base()
    const state = path.join(b, '.skillsmith')
    const other = parkAt(claude(b), 'theirs')
    const sc = JSON.parse(fs.readFileSync(other.sidecarPath, 'utf8')) as Record<string, unknown>
    fs.writeFileSync(other.sidecarPath, JSON.stringify({ ...sc, client: 'cursor' }))
    parkAt(claude(b), 'mine', { opId: 'op-mine' })
    makeBackup({ state, skillsDir: claude(b), dirName: 'one', opId: 'op-1' })
    const cursor = makeBackup({
      state,
      skillsDir: claude(b),
      client: 'cursor',
      dirName: 'two',
      opId: 'op-2',
    })
    fs.writeFileSync(path.join(cursor.areaPath, '.tmp-abc'), 'x')
    const l = await listBackups({ stateRoot: state, client: 'claude-code', discovery: hermetic(b) })
    expect(l.parked.flatMap((a) => a.rows).map((r) => r.copy.name)).toEqual([
      expect.stringContaining('mine'),
    ])
    expect(l.backups[0]!.areas.map((a) => a.client)).toEqual(['claude-code'])
    expect(l.excludedByClient).toEqual({ parkedCopies: 1, backupTrees: 1, otherEntries: 1 })
  })

  it('no --client: nothing is excluded and the field is null', async () => {
    const b = base()
    parkAt(claude(b), 'mine')
    const l = await listBackups({ discovery: hermetic(b) })
    expect(l.excludedByClient).toBeNull()
  })
})

describe('F3: scope narrows what is shown, not UD61 rule (c)', () => {
  const plant = (b: string) => {
    const state = path.join(b, '.skillsmith')
    parkAt(claude(b), 'rec', { caller: 'doctor-park', opId: 'op-X' })
    const bk = makeBackup({ state, skillsDir: claude(b), dirName: 'one', opId: 'op-X' })
    return { state, bk }
  }

  it('control: unscoped, a parked unreadable record protects the tree with its opId', async () => {
    const b = base()
    const { state } = plant(b)
    const l = await listBackups({ stateRoot: state, discovery: hermetic(b) })
    const row = l.backups[0]!.areas[0]!.rows[0]!
    expect(row.protection).toMatchObject({
      status: 'protected',
      rule: 'parked-unreadable-record',
    })
  })

  it('scoped to the backup area only, the out-of-scope parked record still protects it', async () => {
    const b = base()
    const { state, bk } = plant(b)
    const l = await listBackups({
      stateRoot: state,
      discovery: hermetic(b),
      scope: { areaPaths: [bk.areaPath] },
    })
    expect(l.parked.flatMap((a) => a.rows)).toEqual([])
    const row = l.backups[0]!.areas[0]!.rows[0]!
    expect(row.protection).toMatchObject({
      status: 'protected',
      rule: 'parked-unreadable-record',
    })
  })

  it('scoped away from a big parked copy, the space warning still counts it', async () => {
    const b = base()
    const state = path.join(b, '.skillsmith')
    parkAt(claude(b), 'big')
    const bk = makeBackup({ state, skillsDir: claude(b), dirName: 'one', opId: 'op-1' })
    const l = await listBackups({
      stateRoot: state,
      discovery: hermetic(b),
      scope: { areaPaths: [bk.areaPath] },
      usage: { statfs: () => ({ bavail: 1e12, bsize: 1 }), capBytes: 1000 },
    })
    expect(l.parked.flatMap((a) => a.rows)).toEqual([])
    expect(l.warning.message).toContain('big')
  })
})

describe('F4: protection is three-way', () => {
  const facts = (over: Partial<RecordFacts>): RecordFacts => ({
    live: new Map(),
    unreadable: [],
    scanFailures: [],
    ...over,
  })
  const q = { opId: 'op-1', kind: 'backup', sourceUnchanged: null }

  it('protected, unprotected, and unknown for each reason', () => {
    const none = new Map<string, string>()
    expect(protectionOf(facts({ live: new Map([['op-1', '/r']]) }), none, q)).toEqual({
      status: 'protected',
      rule: 'live-record',
      path: '/r',
    })
    expect(protectionOf(facts({}), none, q)).toEqual({ status: 'unprotected' })
    const failed = facts({ scanFailures: [{ root: '/root', path: '/root/s', errno: 'EACCES' }] })
    expect(protectionOf(failed, none, q)).toEqual({
      status: 'unknown',
      reason: 'records under /root could not be read (EACCES)',
    })
    const unreadable = facts({
      unreadable: [{ root: '/root2', record: { path: '/root2/x', opId: 'op-9', why: 'not-json' } }],
    })
    expect(protectionOf(unreadable, none, q)).toEqual({
      status: 'unknown',
      reason: 'an unreadable update record in /root2 may protect it',
    })
  })

  it('a listing whose records could not be scanned says unknown, not unprotected', async () => {
    const b = base()
    const state = path.join(b, '.skillsmith')
    makeBackup({ state, skillsDir: claude(b), dirName: 'one', opId: 'op-1' })
    fs.mkdirSync(claude(b), { recursive: true })
    fs.writeFileSync(path.join(claude(b), '.skillsmith-staging'), 'not a directory')
    const l = await listBackups({ stateRoot: state, discovery: hermetic(b) })
    expect(l.records.scanFailures.map((f) => f.root)).toContain(claude(b))
    const row = l.backups[0]!.areas[0]!.rows[0]!
    expect(row.protection).toEqual({
      status: 'unknown',
      reason: expect.stringContaining('could not be read'),
    })
  })

  it('a refused parked area may hide the parked unreadable record (rule c): unknown, not unprotected', async () => {
    const b = base()
    const state = path.join(b, '.skillsmith')
    parkAt(claude(b), 'rec', { caller: 'doctor-park', opId: 'op-X' })
    makeBackup({ state, skillsDir: claude(b), dirName: 'one', opId: 'op-X' })
    const areaDir = path.join(claude(b), '.skillsmith-parked')
    ownedByAnother(areaDir)
    const l = await listBackups({ stateRoot: state, discovery: hermetic(b) })
    expect(l.parked.find((a) => a.ref.areaDir === areaDir)?.refused).toMatch(/another user/)
    const row = l.backups[0]!.areas[0]!.rows[0]!
    expect(row.protection).toMatchObject({ status: 'unknown' })
  })

  it('a parked copy with the same opId whose kind is unknown (no sidecar): unknown, not unprotected', async () => {
    const b = base()
    const state = path.join(b, '.skillsmith')
    const p = parkAt(claude(b), 'rec', { caller: 'doctor-park', opId: 'op-X' })
    fs.rmSync(p.sidecarPath)
    makeBackup({ state, skillsDir: claude(b), dirName: 'one', opId: 'op-X' })
    const l = await listBackups({ stateRoot: state, discovery: hermetic(b) })
    expect(l.parked.flatMap((a) => a.rows).map((r) => r.kind)).toEqual([null])
    const row = l.backups[0]!.areas[0]!.rows[0]!
    expect(row.protection).toMatchObject({ status: 'unknown' })
  })
})

describe('F5: a symlinked .skillsmith-staging is not followed', () => {
  it("the target is not listed as this root's staging area, and the link is an anomaly", async () => {
    const b = base()
    const target = path.join(b, 'elsewhere')
    fs.mkdirSync(target)
    const parked = parkAt(target, 'victim')
    fs.mkdirSync(claude(b), { recursive: true })
    fs.symlinkSync(target, path.join(claude(b), '.skillsmith-staging'))
    const l = await listBackups({ discovery: hermetic(b) })
    expect(l.parked.flatMap((a) => a.rows).map((r) => r.copy.copyPath)).toEqual([])
    expect(l.parked.flatMap((a) => a.anomalies).map((x) => x.path)).toContain(
      path.join(claude(b), '.skillsmith-staging')
    )
    expect(fs.existsSync(parked.copyPath)).toBe(true)
  })
})
