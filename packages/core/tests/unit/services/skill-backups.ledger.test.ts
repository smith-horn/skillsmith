/**
 * SMI-6531 (A1 step 6c-ii-a): the ledger invariant behind `doctor backups`.
 *
 * One fixture plants every kind of entry in every store and at every level,
 * plus injected faults (unreadable, vanished, another owner, another device).
 * The invariant: every planted path has exactly one ledger row, with the
 * expected disposition; every other row is a store or area root that is
 * absent; no path got two rows; and the space warning's entries are exactly the
 * rows that are not exempt, so with `capBytes: 0` each of them counts.
 *
 * Every assertion that can fail names the planted paths that broke it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listBackups } from '../../../src/services/skill-backups.listing.js'
import type { BackupsListing } from '../../../src/services/skill-backups.listing.js'
import { rootKeyFor } from '../../../src/install/prune.classify.js'
import { makeBackup } from '../../unit/install/prune.list.helpers.js'
import { hermetic, indexLine, mkBase, parkAt } from './skill-backups.helpers.js'

const bases: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true })
})

type Want =
  | 'measured'
  | 'unmeasured'
  | 'exempt:absent'
  | 'exempt:vanished'
  | 'exempt:legacy-leftover'

interface Faults {
  enoent: string[]
  uid: string[]
  dev: string[]
  readdirEacces: string[]
  /** lstat of exactly this path fails with EACCES (the entry exists; it cannot be looked at). */
  lstatEacces: string[]
  /** readdir of this path works once (the lister's read) and fails with EACCES after. */
  readdirEaccesSecond: string[]
}

/** Path-exact fs faults; every other call passes through. */
function inject(f: Faults): void {
  const readCount = new Map<string, number>()
  const realL = fs.lstatSync.bind(fs) as (...a: unknown[]) => unknown
  vi.spyOn(fs, 'lstatSync').mockImplementation(((p: unknown, ...rest: unknown[]) => {
    if (typeof p === 'string' && f.enoent.includes(p)) {
      // Really gone from now on, as a name that vanished between the listing and the look.
      fs.rmSync(p, { recursive: true, force: true })
      throw Object.assign(new Error('gone'), { code: 'ENOENT' })
    }
    if (typeof p === 'string' && f.lstatEacces.includes(p)) {
      throw Object.assign(new Error('denied'), { code: 'EACCES' })
    }
    const st = realL(p, ...rest)
    if (typeof p === 'string' && typeof st === 'object' && st !== null) {
      if (f.uid.includes(p))
        return Object.defineProperty(Object.create(st), 'uid', { value: 1234n })
      if (f.dev.includes(p)) {
        return Object.defineProperty(Object.create(st), 'dev', { value: 987654321n })
      }
    }
    return st
  }) as typeof fs.lstatSync)
  const realR = fs.readdirSync.bind(fs) as (...a: unknown[]) => unknown
  vi.spyOn(fs, 'readdirSync').mockImplementation(((p: unknown, ...rest: unknown[]) => {
    if (typeof p === 'string' && f.readdirEacces.includes(p)) {
      throw Object.assign(new Error('denied'), { code: 'EACCES' })
    }
    if (typeof p === 'string' && f.readdirEaccesSecond.includes(p)) {
      const n = (readCount.get(p) ?? 0) + 1
      readCount.set(p, n)
      if (n > 1) throw Object.assign(new Error('denied'), { code: 'EACCES' })
    }
    return realR(p, ...rest)
  }) as typeof fs.readdirSync)
}

const mkdir = (p: string): string => {
  fs.mkdirSync(p, { recursive: true })
  return p
}
const file = (p: string, bytes = 10): string => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, 'x'.repeat(bytes))
  return p
}

/** Plants every kind; returns the expected disposition of every planted path. */
function plant(b: string) {
  const want: Record<string, Want> = {}
  const faults: Faults = {
    enoent: [],
    uid: [],
    dev: [],
    readdirEacces: [],
    lstatEacces: [],
    readdirEaccesSecond: [],
  }
  const claude = path.join(b, 'clients', 'claude-code')
  const cursor = path.join(b, 'clients', 'cursor')
  const target = mkdir(path.join(b, 'linktarget'))
  file(path.join(target, 'f'), 4000)

  // Parked area of the claude root.
  const keep = parkAt(claude, 'keep', { opId: 'op-keep' })
  const area = path.dirname(keep.opDir)
  want[area] = 'measured'
  want[keep.opDir] = 'measured'
  want[keep.copyPath] = 'measured'
  want[keep.sidecarPath] = 'measured'
  want[file(path.join(keep.opDir, 'gone-11111111.json'))] = 'measured' // orphan sidecar
  want[path.dirname(file(path.join(keep.opDir, '.foo', 'big'), 1_000_000))] = 'measured'
  const opLink = mkdir(path.join(area, 'op-link'))
  want[opLink] = 'measured'
  const lnk = path.join(opLink, 'lnk-12345678')
  fs.symlinkSync(target, lnk) // a parked copy whose root is a symlink: measured as the link
  want[lnk] = 'measured'
  want[mkdir(path.join(area, '.prune-x'))] = 'measured'
  want[file(path.join(area, '.DS_Store'))] = 'measured'
  want[path.dirname(file(path.join(area, '.stuff', 'big'), 1_000_000))] = 'measured'
  const opSym = path.join(area, 'op-sym')
  fs.symlinkSync(target, opSym)
  want[opSym] = 'unmeasured'
  const opEacces = mkdir(path.join(area, 'op-eacces'))
  file(path.join(opEacces, 'x-33333333', 'f'))
  faults.readdirEacces.push(opEacces)
  want[opEacces] = 'unmeasured'
  const opGone = mkdir(path.join(area, 'op-gone'))
  faults.enoent.push(opGone)
  want[opGone] = 'exempt:vanished'
  want[mkdir(path.join(area, 'op-empty'))] = 'measured'
  // lstat refused (EACCES) on an op-dir entry and on an op dir: unreadable, never "vanished".
  const entryEacces = file(path.join(keep.opDir, 'eperm-entry'))
  faults.lstatEacces.push(entryEacces)
  want[entryEacces] = 'unmeasured'
  const opLstat = mkdir(path.join(area, 'op-lstat-eacces'))
  file(path.join(opLstat, 'x-55555555', 'f'))
  faults.lstatEacces.push(opLstat)
  want[opLstat] = 'unmeasured'
  // An op dir the lister read fine and the sweep then could not read.
  const second = parkAt(claude, 'second', { opId: 'op-second' })
  faults.readdirEaccesSecond.push(second.opDir)
  want[second.opDir] = 'unmeasured'
  want[second.copyPath] = 'measured'

  // The cursor root: its area refused (another owner), its staging directory a symlink.
  parkAt(cursor, 'theirs', { opId: 'op-theirs' })
  const cursorArea = path.join(cursor, '.skillsmith-parked')
  faults.uid.push(cursorArea)
  want[cursorArea] = 'unmeasured'
  const cursorStaging = path.join(cursor, '.skillsmith-staging')
  fs.symlinkSync(target, cursorStaging)
  want[cursorStaging] = 'unmeasured'

  // State A (home): a readable index with a valid line to an index-only area, a malformed
  // line and a stale line; and the update backup store.
  const stateA = path.join(b, '.skillsmith')
  const victim = parkAt(path.join(b, 'elsewhere'), 'victim', { opId: 'op-victim' })
  const idxA = indexLine(stateA, victim.copyPath, 'op-victim')
  want[path.dirname(victim.opDir)] = 'measured'
  want[victim.opDir] = 'measured'
  want[victim.copyPath] = 'measured'
  want[victim.sidecarPath] = 'measured'
  fs.appendFileSync(idxA, 'not json at all\n')
  want[`${idxA}:2`] = 'unmeasured'
  const stale = path.join(area, 'op-stale', 'stale-22222222')
  indexLine(stateA, stale, 'op-stale')
  want[stale] = 'exempt:absent'

  const bk = makeBackup({ state: stateA, skillsDir: claude, dirName: 'one', opId: 'op-1' })
  const u = bk.updateDir
  const rk = path.dirname(bk.areaPath)
  want[u] = 'measured'
  want[path.dirname(rk)] = 'measured'
  want[rk] = 'measured'
  want[bk.areaPath] = 'measured'
  want[bk.copyPath] = 'measured'
  want[bk.sidecarPath] = 'measured'
  want[file(path.join(bk.areaPath, '.tmp-op-9'))] = 'measured'
  want[mkdir(path.join(bk.areaPath, '.prune-y'))] = 'measured'
  want[file(path.join(bk.areaPath, 'op-z.json'))] = 'measured' // orphan sidecar
  want[file(path.join(bk.areaPath, '.hidden'))] = 'measured'
  want[path.dirname(file(path.join(bk.areaPath, '.hdir', 'data'), 50_000))] = 'measured'
  for (const at of [path.join(u, 'linkclient'), path.join(path.dirname(rk), 'linkkey')]) {
    fs.symlinkSync(target, at)
    want[at] = 'unmeasured'
  }
  const linkArea = path.join(rk, 'linkarea')
  fs.symlinkSync(target, linkArea)
  want[linkArea] = 'unmeasured'
  const otherOwner = path.join(u, 'other-owner')
  file(path.join(otherOwner, 'rk', 'a', 'op-2', 'f'))
  faults.uid.push(otherOwner)
  want[otherOwner] = 'unmeasured'
  const otherDev = path.join(u, 'other-dev')
  file(path.join(otherDev, 'rk', 'a', 'op-3', 'f'))
  faults.dev.push(otherDev)
  want[otherDev] = 'unmeasured'
  const rkEacces = mkdir(path.join(path.dirname(rk), 'rk-eacces'))
  file(path.join(rkEacces, 'a', 'op-4', 'f'))
  faults.readdirEacces.push(rkEacces)
  want[rkEacces] = 'unmeasured'
  const goneLevel = mkdir(path.join(rk, 'gone'))
  faults.enoent.push(goneLevel)
  want[goneLevel] = 'exempt:vanished'

  // State B (a workspace): its index is a directory (EISDIR).
  const ws = path.join(b, 'ws')
  mkdir(path.join(ws, '.claude', 'skills'))
  const idxB = mkdir(path.join(ws, '.skillsmith', 'parked-index.jsonl'))
  want[idxB] = 'unmeasured'

  // The old MCP store and a legacy leftover.
  const mcp = path.join(claude, '.backups')
  file(path.join(mcp, 'some-skill', 'SKILL.md'), 20_000)
  want[mcp] = 'measured'
  const legacy = mkdir(
    path.join(claude, `.foo.skillsmith-removing-${'0123456789abcdef'.repeat(2)}`)
  )
  file(path.join(legacy, 'big'), 20_000)
  want[legacy] = 'exempt:legacy-leftover'

  return {
    want,
    faults,
    claude,
    ws,
    hiddenByRootClaude: [
      cursorArea,
      cursorStaging,
      path.join(path.dirname(rk), 'linkkey'),
      rkEacces,
    ],
  }
}

const kindOf = (l: BackupsListing, p: string): string => {
  const r = l.accounting.rows.find((x) => x.path === p)
  if (r === undefined) return 'NO ROW'
  const d = r.disposition
  return d.kind === 'exempt' ? `exempt:${d.reason}` : d.kind
}

/** A symlink measured as the link may hold no blocks; a path that is not on disk is not one. */
const isSymlink = (p: string): boolean => {
  try {
    return fs.lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

const zeroCap = { statfs: () => ({ bavail: 1e12, bsize: 1 }), capBytes: 0 }

describe('the ledger invariant', () => {
  it('every planted path has exactly one row with its expected disposition, and nothing else is counted', async () => {
    const b = mkBase('sbk-ledger-')
    bases.push(b)
    const { want, faults, ws } = plant(b)
    inject(faults)
    const l = await listBackups({ discovery: { ...hermetic(b), cwd: ws }, usage: zeroCap })
    expect(l.discovery.stateRoots).toHaveLength(2)

    // 1. Each planted path: its row and its disposition.
    const wrong = Object.entries(want)
      .map(([p, w]) => ({ path: p, want: w, got: kindOf(l, p) }))
      .filter((x) => x.got !== x.want)
    expect(wrong).toEqual([])

    // 2. No path was offered two rows.
    expect(l.accounting.duplicates).toEqual([])

    // 3. Every row not planted is a store or area root that does not exist.
    const unplanted = l.accounting.rows
      .filter((r) => !(r.path in want))
      .filter((r) => !(r.disposition.kind === 'exempt' && r.disposition.reason === 'absent'))
      .map((r) => r.path)
    expect(unplanted).toEqual([])

    // 4. The warning's entries are exactly the rows that are not exempt.
    const counted = new Map(l.usageEntries.map((e) => [e.path, e]))
    const shouldCount = Object.entries(want).filter(([, w]) => !w.startsWith('exempt'))
    const notCounted = shouldCount.map(([p]) => p).filter((p) => !counted.has(p))
    expect(notCounted).toEqual([])
    const exemptCounted = Object.entries(want)
      .filter(([p, w]) => w.startsWith('exempt') && counted.has(p))
      .map(([p]) => p)
    expect(exemptCounted).toEqual([])

    // 5. With capBytes 0, each counted row is enough to warn on its own: it holds bytes or is
    // unmeasured. A symlink measured as the link may hold no blocks (an inline target).
    const silent = shouldCount
      .map(([p]) => p)
      .filter((p) => {
        const e = counted.get(p)
        if (e === undefined || e.unmeasured > 0) return false
        const bytes = [...e.units.values()].reduce((n, x) => n + x, 0)
        return bytes === 0 && !isSymlink(p)
      })
    expect(silent).toEqual([])
    expect(l.warning.warn).toBe(true)

    // 6. Every item the listing shows is a ledger row of its own kind, so a narrowing that
    // hides it counts it (a row the sweep supplied would be structure, counted by nothing).
    const shownAs: [string, string][] = [
      ...l.parked.flatMap((a) => [
        ...a.rows.map((r): [string, string] => [r.copy.copyPath, 'copy']),
        ...a.leftovers.map((v): [string, string] => [v.leftover.S, 'entry']),
        ...a.orphanSidecars.map((o): [string, string] => [o, 'entry']),
        ...a.anomalies.map((x): [string, string] => [x.path, 'entry']),
      ]),
      ...l.backups.flatMap((s) => [
        ...s.anomalies.map((x): [string, string] => [x.path, 'entry']),
        ...s.areas.flatMap((a) => [
          ...a.rows.map((r): [string, string] => [r.copy.copyPath, 'copy']),
          ...a.temps.map((t): [string, string] => [t.path, 'entry']),
          ...a.leftovers.map((v): [string, string] => [v.leftover.S, 'entry']),
          ...a.orphanSidecars.map((o): [string, string] => [o, 'entry']),
          ...a.anomalies.map((x): [string, string] => [x.path, 'entry']),
        ]),
      ]),
    ]
    const itemOf = new Map(l.accounting.rows.map((r) => [r.path, r.item]))
    const misfiled = shownAs
      .map(([p, item]) => ({ path: p, want: item, got: itemOf.has(p) ? itemOf.get(p) : 'NO ROW' }))
      .filter((x) => x.got !== x.want)
    expect(misfiled).toEqual([])
    expect(shownAs.length).toBeGreaterThan(20)

    const unmeasured = shouldCount.filter(([, w]) => w === 'unmeasured').length
    expect(l.unmeasured).toBe(unmeasured)
  })

  it('--root counts every hidden row by what it is, anomalies and refused areas included', async () => {
    const b = mkBase('sbk-ledger-root-')
    bases.push(b)
    const { faults, ws, claude, hiddenByRootClaude } = plant(b)
    inject(faults)
    const l = await listBackups({
      roots: [claude],
      discovery: { ...hermetic(b), cwd: ws },
      usage: zeroCap,
    })
    expect(l.narrowedTo).toEqual([claude])
    expect(rootKeyFor(claude)).not.toBe('linkkey')
    expect(
      l.excludedByRoot,
      `hidden entries planted: ${hiddenByRootClaude.join(', ')}; the index-only copy`
    ).toEqual({
      parkedCopies: 1,
      backupTrees: 0,
      otherEntries: hiddenByRootClaude.length,
      olderStores: 0,
    })
    // The warning is computed before narrowing: the hidden refused area still counts.
    expect(l.usageEntries.map((e) => e.path)).toEqual(expect.arrayContaining(hiddenByRootClaude))
  })
})
