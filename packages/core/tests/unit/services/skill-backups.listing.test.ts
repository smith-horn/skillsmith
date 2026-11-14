/**
 * SMI-6531 (A1 step 6c-ii-a): `listBackups` over real fixtures. Rows: the M4
 * shape (a `backups/` directory holding only unrelated files lists nothing),
 * Q6 (a copy on another device than the state root), Q8 (the index is
 * advisory: missing, stale, and a line naming the wrong path), Q9's fields,
 * T-X14, T-J12's backups half, Q5's listing half, T-K1's listing rows, D7
 * (the old MCP store is reported and counted), and the legacy leftovers.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listBackups } from '../../../src/services/skill-backups.listing.js'
import { protectionOf } from '../../../src/services/skill-backups.records.js'
import type { RecordFacts } from '../../../src/services/skill-backups.records.js'
import { parkedCopyParts } from '../../../src/services/skill-backups.areas.js'
import { makeBackup } from '../../unit/install/prune.list.helpers.js'
import { hermetic, indexLine, mkBase, parkAt } from './skill-backups.helpers.js'

const bases: string[] = []
const base = (): string => {
  const b = mkBase()
  bases.push(b)
  return b
}
afterEach(() => {
  for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true })
})

const claude = (b: string): string => path.join(b, 'clients', 'claude-code')
/** A statfs that makes the threshold `cap` bytes whatever the volume. */
const usage = (cap: number) => ({
  statfs: () => ({ bavail: 1e12, bsize: 1 }),
  capBytes: cap,
})

describe('M4: the owner machine shape', () => {
  it('a backups/ directory with only unrelated files and no update/ lists nothing from it and does not error', async () => {
    const b = base()
    const state = path.join(b, '.skillsmith')
    fs.mkdirSync(path.join(state, 'backups'), { recursive: true })
    fs.writeFileSync(path.join(state, 'backups', 'purge-dead-quarantines-1.csv'), 'a,b\n')
    fs.writeFileSync(path.join(state, 'backups', 'repair-latched-name-rows-1.jsonl'), '{}\n')
    const l = await listBackups({ discovery: hermetic(b), usage: usage(1) })
    expect(l.backups).toHaveLength(1)
    expect(l.backups[0]).toMatchObject({ absent: true, refused: null, areas: [] })
    expect(l.usageEntries).toEqual([])
    expect(JSON.stringify(l.backups)).not.toContain('purge-dead')
    expect(l.warning.message).toBeNull()
  })
})

describe('Q6: a parked copy on another device than the state root', () => {
  it('is listed from the scan with index present, and its warning volume is the parent device', async () => {
    const b = base()
    const state = path.join(b, '.skillsmith')
    fs.mkdirSync(state, { recursive: true })
    const shm = fs.realpathSync(fs.mkdtempSync('/dev/shm/sbk-q6-'))
    // A second area on that device that no index line names: only the scan can reach it.
    const shm2 = fs.realpathSync(fs.mkdtempSync('/dev/shm/sbk-q6b-'))
    try {
      expect(fs.statSync(shm).dev).not.toBe(fs.statSync(state).dev)
      const indexed = parkAt(shm, 'indexed')
      const plain = parkAt(shm2, 'plain')
      indexLine(state, indexed.copyPath, 'op-indexed')
      const l = await listBackups({
        stateRoot: state,
        roots: [shm, shm2],
        discovery: hermetic(b),
        usage: usage(1),
      })
      const rows = l.parked.flatMap((a) => a.rows)
      const byPath = new Map(rows.map((r) => [r.copy.copyPath, r]))
      expect(byPath.get(plain.copyPath)?.index).toBe('missing')
      expect(byPath.get(indexed.copyPath)?.index).toBe('present')
      const dev = String(fs.lstatSync(shm, { bigint: true }).dev)
      expect(l.warning.perVolume.map((v) => v.dev)).toContain(dev)
      expect(l.warning.perVolume.map((v) => v.dev)).not.toContain(
        String(fs.lstatSync(state, { bigint: true }).dev)
      )
    } finally {
      fs.rmSync(shm, { recursive: true, force: true })
      fs.rmSync(shm2, { recursive: true, force: true })
    }
  })

  it('an index line spelled through a symlink to the area still matches (compared by real path)', async () => {
    const b = base()
    const state = path.join(b, '.skillsmith')
    const p = parkAt(claude(b), 'viaLink')
    const link = path.join(b, 'link-to-claude')
    fs.symlinkSync(claude(b), link)
    indexLine(state, p.copyPath.replace(claude(b), link), 'op-viaLink')
    const l = await listBackups({ stateRoot: state, discovery: hermetic(b), usage: usage(1) })
    const row = l.parked.flatMap((a) => a.rows).find((r) => r.copy.copyPath === p.copyPath)
    expect(row?.index).toBe('present')
  })
})

describe('Q8: the parked index is advisory', () => {
  it('(a) a copy with no index line is listed, index missing', async () => {
    const b = base()
    const p = parkAt(claude(b), 'orphaned')
    const l = await listBackups({ discovery: hermetic(b) })
    const row = l.parked.flatMap((a) => a.rows).find((r) => r.copy.copyPath === p.copyPath)
    expect(row).toBeDefined()
    expect(row?.index).toBe('missing')
  })

  it('(b) a line whose copy is gone raises no error and is reported stale', async () => {
    const b = base()
    const state = path.join(b, '.skillsmith')
    const gone = parkAt(claude(b), 'gone')
    const kept = parkAt(claude(b), 'kept')
    indexLine(state, gone.copyPath, 'op-gone')
    indexLine(state, kept.copyPath, 'op-kept')
    fs.rmSync(gone.opDir, { recursive: true, force: true })
    const l = await listBackups({ stateRoot: state, discovery: hermetic(b) })
    expect(l.index.stale.map((s) => [s.line.entry.path, s.reason])).toEqual([
      [gone.copyPath, 'copy-gone'],
    ])
    const rows = l.parked.flatMap((a) => a.rows)
    expect(rows.map((r) => r.copy.copyPath)).toEqual([kept.copyPath])
  })

  it('(c) a line naming an existing path that is not <area>/<opId>/<name>-<8hex> is not listed, and counts as unmeasured', async () => {
    const b = base()
    const state = path.join(b, '.skillsmith')
    // Real directories with content sit at every rejected path.
    const victims = [
      path.join(b, 'elsewhere', 'victim'),
      path.join(b, 'notparked', 'op', 'foo-12345678'),
      path.join(b, 'x', '.skillsmith-parked', 'op', 'foo'),
      path.join(b, 'y', '.skillsmith-parked', 'op', 'foo-ZZZZZZZZ'),
    ]
    for (const v of victims) {
      fs.mkdirSync(v, { recursive: true })
      fs.writeFileSync(path.join(v, 'f'), 'z'.repeat(9000))
      indexLine(state, v, 'op')
    }
    const l = await listBackups({ stateRoot: state, discovery: hermetic(b), usage: usage(1) })
    expect(l.index.facts.rejected.map((r) => r.path).sort()).toEqual([...victims].sort())
    expect(l.parked.flatMap((a) => a.rows)).toEqual([])
    // Never walked (a line the index cannot vouch for may name anything), never silent either.
    const unmeasured = l.accounting.rows.filter((r) => r.disposition.kind === 'unmeasured')
    expect(unmeasured.map((r) => r.path).sort()).toEqual([...victims].sort())
    expect(l.warning.message).toMatch(/4 entries could not be measured/)
  })

  it('(c) control: a rejected line naming a path that does not exist is absent, and quiet', async () => {
    const b = base()
    const state = path.join(b, '.skillsmith')
    const gone = path.join(b, 'elsewhere', 'victim')
    indexLine(state, gone, 'op')
    const l = await listBackups({ stateRoot: state, discovery: hermetic(b), usage: usage(1) })
    expect(l.index.facts.rejected.map((r) => r.path)).toEqual([gone])
    expect(l.accounting.rows.find((r) => r.path === gone)?.disposition).toEqual({
      kind: 'exempt',
      reason: 'absent',
    })
    expect(l.warning.message).toBeNull()
  })

  it('parkedCopyParts accepts exactly the shape and nothing else', () => {
    const ok = '/r/.skillsmith-parked/op-1/foo-0123abcd'
    expect(parkedCopyParts(ok)).toEqual({
      areaDir: '/r/.skillsmith-parked',
      opId: 'op-1',
      name: 'foo-0123abcd',
    })
    for (const bad of [
      'relative/.skillsmith-parked/op/foo-0123abcd',
      '/r/.skillsmith-parked/op/foo-0123abc',
      '/r/.skillsmith-parked/op/foo-0123abcdz',
      '/r/other/op/foo-0123abcd',
      '/r/.skillsmith-parked/.hidden/foo-0123abcd',
      '/.skillsmith-parked/foo-0123abcd',
    ]) {
      expect(parkedCopyParts(bad)).toBeNull()
    }
  })
})

describe('Q9 and T-X14: what a parked row carries', () => {
  it('origin, kind, class, a size on disk, an age and the index state; a copy without its sidecar is held/sidecar-absent', async () => {
    const b = base()
    const withCar = parkAt(claude(b), 'with')
    const without = parkAt(claude(b), 'without')
    fs.unlinkSync(without.sidecarPath)
    const l = await listBackups({ discovery: hermetic(b) })
    const rows = new Map(l.parked.flatMap((a) => a.rows).map((r) => [r.copy.copyPath, r]))
    const w = rows.get(withCar.copyPath)
    expect(w).toMatchObject({
      origin: path.join(claude(b), 'with'),
      kind: 'uninstall',
      index: 'missing',
    })
    expect(w?.classification.klass).toBe('clean')
    expect(w?.allocatedBytes).toBeGreaterThan(5000)
    expect(typeof w?.ageDays).toBe('number')
    const n = rows.get(without.copyPath)
    expect(n?.classification).toMatchObject({ klass: 'held', reason: 'sidecar-absent' })
  })
})

describe('T-J12 (backups half) and Q5 (listing half): discovery', () => {
  it('~/.agents/skills symlinked into ~/.claude/skills is one listed area, not two', async () => {
    const b = base()
    const d = hermetic(b)
    fs.rmSync(path.join(b, 'clients', 'agents'), { recursive: true })
    fs.symlinkSync(claude(b), path.join(b, 'clients', 'agents'))
    const p = parkAt(claude(b), 'once')
    const l = await listBackups({ discovery: d })
    const rows = l.parked.flatMap((a) => a.rows).filter((r) => r.copy.copyPath === p.copyPath)
    expect(rows).toHaveLength(1)
    expect(l.parked.filter((a) => a.rows.length > 0)).toHaveLength(1)
  })

  it('a client root no manifest names is listed without --root; --state-root reads that state root', async () => {
    const b = base()
    const p = parkAt(path.join(b, 'clients', 'cursor'), 'first-install')
    const state = path.join(b, 'other-state')
    const kept = makeBackup({ state, skillsDir: claude(b) })
    const l = await listBackups({ stateRoot: state, discovery: hermetic(b) })
    expect(l.parked.flatMap((a) => a.rows).map((r) => r.copy.copyPath)).toContain(p.copyPath)
    expect(l.discovery.stateRoots).toEqual([state])
    expect(l.backups[0]?.areas[0]?.rows.map((r) => r.copy.copyPath)).toEqual([kept.copyPath])
  })

  it('an area only the index names (an `author init --path` target) is listed through the index', async () => {
    const b = base()
    const state = path.join(b, '.skillsmith')
    const outside = path.join(b, 'elsewhere')
    fs.mkdirSync(outside)
    const p = parkAt(outside, 'inited', { opId: 'op-init' })
    indexLine(state, p.copyPath, 'op-init')
    const l = await listBackups({ stateRoot: state, discovery: hermetic(b) })
    const area = l.parked.find((a) => a.ref.origin === 'indexed')
    expect(area?.ref.areaDir).toBe(path.join(outside, '.skillsmith-parked'))
    expect(area?.rows.map((r) => r.copy.copyPath)).toEqual([p.copyPath])
    expect(area?.rows[0]?.index).toBe('present')
  })
})

describe('T-K1 (listing rows) and the newest-per-group fact', () => {
  it('an unrecognised kind is unverified; two clients sit in separate areas, each restore root listed', async () => {
    const b = base()
    const state = path.join(b, '.skillsmith')
    const cursorRoot = path.join(b, 'clients', 'cursor')
    makeBackup({ state, skillsDir: claude(b), opId: 'op-pre', kind: 'pre-rename' })
    makeBackup({ state, skillsDir: claude(b), opId: 'op-c1', client: 'claude-code' })
    makeBackup({ state, skillsDir: cursorRoot, opId: 'op-c2', client: 'cursor' })
    const l = await listBackups({ stateRoot: state, discovery: hermetic(b) })
    const rows = l.backups[0]!.areas.flatMap((a) => a.rows)
    expect(rows.find((r) => r.opId === 'op-pre')?.classification.klass).toBe('unverified')
    const areas = l.backups[0]!.areas
    expect(new Set(areas.map((a) => a.client))).toEqual(new Set(['claude-code', 'cursor']))
    expect(rows.find((r) => r.opId === 'op-c1')?.skillsDir).toBe(claude(b))
    expect(rows.find((r) => r.opId === 'op-c2')?.skillsDir).toBe(cursorRoot)
  })

  it('a sidecar naming another client inside this client area is unverified and never grouped by its own fields', async () => {
    const b = base()
    const state = path.join(b, '.skillsmith')
    makeBackup({
      state,
      skillsDir: claude(b),
      opId: 'op-real',
      sidecar: { createdAt: '2026-01-01T00:00:00.000Z' },
    })
    makeBackup({
      state,
      skillsDir: claude(b),
      client: 'cursor',
      areaClient: 'claude-code',
      areaRootKey: undefined,
      opId: 'op-copied',
      sidecar: { createdAt: '2026-06-01T00:00:00.000Z' },
    })
    const l = await listBackups({ stateRoot: state, discovery: hermetic(b) })
    const rows = l.backups[0]!.areas.flatMap((a) => a.rows)
    const copied = rows.find((r) => r.opId === 'op-copied')
    expect(copied?.classification).toMatchObject({ klass: 'unverified', reason: 'area-mismatch' })
    expect(copied?.newestOfGroup).toBe(false)
    expect(rows.find((r) => r.opId === 'op-real')?.newestOfGroup).toBe(true)
  })

  it('exactly the newest backup of each (client, skillsDir, dirName) is marked', async () => {
    const b = base()
    const state = path.join(b, '.skillsmith')
    const times = ['2026-01-01', '2026-03-01', '2026-02-01']
    times.forEach((t, i) =>
      makeBackup({
        state,
        skillsDir: claude(b),
        opId: `op-${i}`,
        sidecar: { createdAt: `${t}T00:00:00.000Z` },
      })
    )
    makeBackup({
      state,
      skillsDir: claude(b),
      dirName: 'bar',
      opId: 'op-bar',
      sidecar: { createdAt: '2020-01-01T00:00:00.000Z' },
    })
    const l = await listBackups({ stateRoot: state, discovery: hermetic(b) })
    const rows = l.backups[0]!.areas.flatMap((a) => a.rows)
    expect(
      rows
        .filter((r) => r.newestOfGroup)
        .map((r) => r.opId)
        .sort()
    ).toEqual(['op-1', 'op-bar'])
  })

  // GPT-5.6-Sol gate (PR-12, PLAN:2046): the group is (client, skillsDir, dirName),
  // not the physical area, so one newest across every state root and every scope.
  const twoStateRoots = (b: string) => {
    const ws = path.join(b, 'ws')
    fs.mkdirSync(path.join(ws, '.claude', 'skills'), { recursive: true })
    const old = makeBackup({
      state: path.join(b, '.skillsmith'),
      skillsDir: claude(b),
      opId: 'op-old',
      sidecar: { createdAt: '2026-01-01T00:00:00.000Z' },
    })
    makeBackup({
      state: path.join(ws, '.skillsmith'),
      skillsDir: claude(b),
      opId: 'op-new',
      sidecar: { createdAt: '2026-03-01T00:00:00.000Z' },
    })
    return { ws, old }
  }

  it('one group spread over two state roots has exactly one newest', async () => {
    const b = base()
    const { ws } = twoStateRoots(b)
    const l = await listBackups({ discovery: { ...hermetic(b), cwd: ws } })
    expect(l.discovery.stateRoots).toHaveLength(2)
    const rows = l.backups.flatMap((s) => s.areas.flatMap((a) => a.rows))
    expect(rows.map((r) => r.opId).sort()).toEqual(['op-new', 'op-old'])
    expect(
      rows
        .filter((r) => r.newestOfGroup)
        .map((r) => r.opId)
        .sort()
    ).toEqual(['op-new'])
  })

  it('a scope that shows only the older tree still does not call it newest', async () => {
    const b = base()
    const { ws, old } = twoStateRoots(b)
    const l = await listBackups({
      discovery: { ...hermetic(b), cwd: ws },
      scope: { areaPaths: [old.areaPath] },
    })
    const rows = l.backups.flatMap((s) => s.areas.flatMap((a) => a.rows))
    expect(rows.map((r) => r.opId)).toEqual(['op-old'])
    expect(rows[0]!.newestOfGroup).toBe(false)
  })
})

describe('UD61 facts', () => {
  const live = new Map([['op-live', '/r/.skillsmith-staging/op-live/record.json']])
  const facts = { live, unreadable: [], scanFailures: [] } as RecordFacts
  const parkedUnreadable = new Map([['op-bad', '/r/.skillsmith-parked/op-bad/op-bad-12345678']])

  it('a live record protects its opId, except a partial-copy whose source is unchanged', () => {
    const q = (kind: string, su: boolean | null) =>
      protectionOf(facts, parkedUnreadable, { opId: 'op-live', kind, sourceUnchanged: su })
    expect(q('conflict', null)).toEqual({
      status: 'protected',
      rule: 'live-record',
      path: live.get('op-live'),
    })
    expect(q('partial-copy', true)).toEqual({ status: 'unprotected' })
    expect(q('partial-copy', false)).toMatchObject({ rule: 'live-record' })
    expect(q('partial-copy', null)).toMatchObject({ rule: 'live-record' })
  })

  it('a parked unreadable record protects its opId; an unrelated opId is unprotected', () => {
    const q = (opId: string) =>
      protectionOf(facts, parkedUnreadable, { opId, kind: 'undone', sourceUnchanged: null })
    expect(q('op-bad')).toEqual({
      status: 'protected',
      rule: 'parked-unreadable-record',
      path: '/r/.skillsmith-parked/op-bad/op-bad-12345678',
    })
    expect(q('op-other')).toEqual({ status: 'unprotected' })
  })
})

describe('D7: the old MCP store, legacy leftovers and the scope option', () => {
  const plantMcp = (b: string): string => {
    const dir = path.join(claude(b), '.backups', 'some-skill', '20260101_edit')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), 'q'.repeat(20000))
    return path.join(claude(b), '.backups')
  }

  it('is reported with its size and counted in the space warning; without it the same threshold is quiet', async () => {
    const b = base()
    const mcp = plantMcp(b)
    const l = await listBackups({ discovery: hermetic(b), usage: usage(1000) })
    expect(l.mcpStores).toHaveLength(1)
    expect(l.mcpStores[0]).toMatchObject({ path: mcp })
    expect(l.mcpStores[0]!.allocatedBytes).toBeGreaterThan(20000)
    expect(l.warning.warn).toBe(true)
    expect(l.warning.message).toContain('.backups')
    fs.rmSync(mcp, { recursive: true })
    const quiet = await listBackups({ discovery: hermetic(b), usage: usage(1000) })
    expect(quiet.mcpStores).toEqual([])
    expect(quiet.warning.message).toBeNull()
  })

  it('legacy removal leftovers are listed and are not counted by the warning', async () => {
    const b = base()
    const d = hermetic(b)
    const legacy = path.join(claude(b), `.foo.skillsmith-removing-${'0123456789abcdef'.repeat(2)}`)
    fs.mkdirSync(legacy)
    fs.writeFileSync(path.join(legacy, 'big'), 'l'.repeat(20000))
    const l = await listBackups({ discovery: d, usage: usage(1000) })
    expect(l.legacy).toEqual([{ root: claude(b), paths: [legacy], unreadable: null }])
    expect(l.usageEntries).toEqual([])
    expect(l.warning.message).toBeNull()
  })

  it('an unreadable parked index is reported, never silence', async () => {
    const b = base()
    const state = path.join(b, '.skillsmith')
    fs.mkdirSync(path.join(state, 'parked-index.jsonl'), { recursive: true })
    const l = await listBackups({ stateRoot: state, discovery: hermetic(b) })
    expect(l.index.facts.unreadable).toEqual([
      { stateRoot: state, indexPath: path.join(state, 'parked-index.jsonl'), errno: 'EISDIR' },
    ])
  })

  it('scope.areaPaths lists only those areas', async () => {
    const b = base()
    const state = path.join(b, '.skillsmith')
    const a = makeBackup({ state, skillsDir: claude(b), dirName: 'one', opId: 'op-1' })
    makeBackup({ state, skillsDir: claude(b), dirName: 'two', opId: 'op-2' })
    const l = await listBackups({
      stateRoot: state,
      discovery: hermetic(b),
      scope: { areaPaths: [a.areaPath] },
    })
    expect(l.backups[0]!.areas.map((x) => x.areaPath)).toEqual([a.areaPath])
    expect(l.parked.flatMap((x) => x.rows)).toEqual([])
  })
})
