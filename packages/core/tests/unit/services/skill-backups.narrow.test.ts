/**
 * SMI-6531 (A1 step 6c-ii-a): `--root` narrows as well as adds (PLAN 2046,
 * UD22), a workspace state root found from `cwd` (T-J12), and UD70's empty
 * skeletons listed from a real `.prune-*` leftover.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listBackups } from '../../../src/services/skill-backups.listing.js'
import { leftoverLines } from '../../../src/services/skill-backups.render.js'
import { rootKeyFor } from '../../../src/install/prune.classify.js'
import { makeBackup } from '../../unit/install/prune.list.helpers.js'
import {
  makeParent,
  parkCopy,
  removeFixture,
  resumeJobAt,
  runWalker,
  stagedWithInventory,
  statusOf,
} from '../../unit/install/prune.walk.helpers.js'
import { hermetic, mkBase, parkAt } from './skill-backups.helpers.js'

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
const usage = (cap: number) => ({
  statfs: () => ({ bavail: 1e12, bsize: 1 }),
  capBytes: cap,
})

describe('--root narrows as well as adds (PLAN 2046, UD22)', () => {
  const dir = (b: string, n: string): string => {
    const d = path.join(b, n)
    fs.mkdirSync(d, { recursive: true })
    return fs.realpathSync(d)
  }

  it("shows only the named root's folders; another root's copies are absent and counted", async () => {
    const b = base()
    const d = hermetic(b)
    const r1 = dir(b, 'r1')
    // A discovered client root the caller did not name.
    const r2 = fs.realpathSync(path.join(b, 'clients', 'cursor'))
    const mine = parkAt(r1, 'mine')
    const other = parkAt(r2, 'other')
    const native = parkAt(claude(b), 'native')
    const l = await listBackups({ roots: [r1], discovery: d, usage: usage(1) })
    const shown = l.parked.flatMap((a) => a.rows.map((r) => r.copy.copyPath))
    expect(shown).toEqual([mine.copyPath])
    expect(shown).not.toContain(other.copyPath)
    expect(shown).not.toContain(native.copyPath)
    expect(l.narrowedTo).toEqual([r1])
    expect(l.excludedByRoot).toMatchObject({ parkedCopies: 2 })
    // The warning still counts everything on disk, hidden rows included: every copy is in
    // the ledger and among the warning's entries.
    const copies = l.accounting.rows.filter((r) => r.item === 'copy').map((r) => r.path)
    expect(copies.sort()).toEqual([mine.copyPath, other.copyPath, native.copyPath].sort())
    const counted = new Set(l.usageEntries.map((e) => e.path))
    for (const c of [mine.copyPath, other.copyPath, native.copyPath]) {
      expect(counted.has(c)).toBe(true)
    }
  })

  it('backups: by the sidecar restore root or the area key; an unattributable tree is counted, never lost', async () => {
    const b = base()
    const d = hermetic(b)
    const state = path.join(b, '.skillsmith')
    const r1 = dir(b, 'r1')
    const r2 = dir(b, 'r2')
    makeBackup({ state, skillsDir: r1, opId: 'op-mine' })
    makeBackup({ state, skillsDir: r2, opId: 'op-other' })
    // No sidecar, in an area keyed to r2: attributable to neither the sidecar nor a named root.
    makeBackup({ state, skillsDir: r2, opId: 'op-bare', noSidecar: true })
    // No sidecar, in an area keyed to r1: the area path says whose it is.
    makeBackup({ state, skillsDir: r1, dirName: 'bar', opId: 'op-bare-mine', noSidecar: true })
    // A sidecar naming r1 sitting in r2's area: shown (it names a root asked for), unverified.
    makeBackup({ state, skillsDir: r1, opId: 'op-mismatch', areaRootKey: rootKeyFor(r2) })
    const l = await listBackups({ stateRoot: state, roots: [r1], discovery: d })
    const rows = l.backups[0]!.areas.flatMap((a) => a.rows)
    expect(rows.map((r) => r.opId).sort()).toEqual(['op-bare-mine', 'op-mine', 'op-mismatch'])
    expect(rows.find((r) => r.opId === 'op-mismatch')?.classification.klass).toBe('unverified')
    expect(l.excludedByRoot).toMatchObject({ backupTrees: 2 })
  })

  it('without --root nothing is narrowed and nothing is counted as excluded', async () => {
    const b = base()
    const d = hermetic(b)
    parkAt(dir(b, 'r2'), 'other')
    const l = await listBackups({ discovery: d })
    expect(l.narrowedTo).toBeNull()
    expect(l.excludedByRoot).toBeNull()
  })
})

describe('T-J12 (workspace half)', () => {
  it('a <workspace>/.skillsmith state root and its skills root are found from cwd', async () => {
    const b = base()
    const d = hermetic(b)
    const ws = path.join(b, 'ws')
    const wsSkills = path.join(ws, '.claude', 'skills')
    fs.mkdirSync(wsSkills, { recursive: true })
    const parkedHere = parkAt(fs.realpathSync(wsSkills), 'wsfolder')
    const kept = makeBackup({ state: path.join(ws, '.skillsmith'), skillsDir: wsSkills })
    const l = await listBackups({ discovery: { ...d, cwd: ws } })
    expect(l.discovery.stateRoots).toContain(fs.realpathSync(path.join(ws, '.skillsmith')))
    expect(l.parked.flatMap((a) => a.rows).map((r) => r.copy.copyPath)).toContain(
      parkedHere.copyPath
    )
    const trees = l.backups.flatMap((s) =>
      s.areas.flatMap((a) => a.rows.map((r) => r.copy.copyPath))
    )
    expect(trees).toContain(fs.realpathSync(kept.copyPath))
    // Control: from a directory outside any workspace, neither is found.
    const away = await listBackups({ discovery: d })
    expect(away.parked.flatMap((a) => a.rows)).toEqual([])
    expect(away.backups.flatMap((s) => s.areas)).toEqual([])
  })
})

describe('UD70: a real .prune-* leftover in state skeleton', () => {
  it('lists every empty folder the resume left, for removal by hand', async () => {
    const b = base()
    const d = hermetic(b)
    const fx = makeParent('sbk-skel-')
    try {
      const c = parkCopy(fx.parent, 't', { extraDirs: 1 })
      const S = stagedWithInventory(c)
      expect(statusOf(runWalker(resumeJobAt(S)))).toBe('stopped/skeleton-left')
      const l = await listBackups({ roots: [fx.parent], discovery: d })
      const views = l.parked.flatMap((a) => a.leftovers)
      expect(views).toHaveLength(1)
      const left = views[0]!.leftover
      expect(left.state).toBe('skeleton')
      expect(left.skeletons?.length).toBeGreaterThan(1)
      const text = leftoverLines(views[0]!).join('\n')
      for (const sk of left.skeletons ?? []) {
        expect(text).toContain(`empty folder a resume left, remove by hand: ${sk}`)
        expect(fs.statSync(sk).isDirectory()).toBe(true)
      }
    } finally {
      removeFixture(fx)
    }
  })
})
