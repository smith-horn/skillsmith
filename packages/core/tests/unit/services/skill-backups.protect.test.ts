/**
 * SMI-6531 (A1 step 6c-ii-b, /governance Major 1): UD61 for PARKED copies is
 * decided once, by the listing, from the whole machine's facts, exactly as for
 * a backup, and the planner only reads it. So a parked copy's protection, and
 * its selection, do not change with `scope`, `--root` or `--client`.
 *
 * Real listings over parks made by the real `parkTree`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { computePathTreeHash, parkTree } from '../../../src/install/park-tree.js'
import { planPrune } from '../../../src/install/prune.select.js'
import type {
  LockAssignment,
  PrunePlan,
  PruneRequest,
} from '../../../src/install/prune.plan.types.js'
import { listBackups } from '../../../src/services/skill-backups.listing.js'
import type { ListBackupsOptions } from '../../../src/services/skill-backups.listing.js'
import type {
  BackupsListing,
  ParkedRow,
} from '../../../src/services/skill-backups.listing.types.js'
import { hermetic, mkBase, parkAt } from './skill-backups.helpers.js'
import type { Parked } from './skill-backups.helpers.js'

const bases: string[] = []
const base = (): string => {
  const b = mkBase('sbk-protect-')
  bases.push(b)
  return b
}
afterEach(() => {
  for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true })
})

const client = (b: string, id = 'claude-code'): string => path.join(b, 'clients', id)
const state = (b: string): string => path.join(b, '.skillsmith')

/** `parkAt` with the sidecar naming `clientId`, for the `--client` narrowing. */
function parkAs(parent: string, name: string, opId: string, clientId: string): Parked {
  const origin = path.join(parent, name)
  fs.mkdirSync(origin, { recursive: true })
  fs.writeFileSync(path.join(origin, 'SKILL.md'), `skill ${name}\n`)
  const h = computePathTreeHash(origin)
  if (!h.ok) throw new Error(`parkAs: hash failed (${h.reason})`)
  const r = parkTree(parent, name, {
    client: clientId as 'cursor',
    caller: 'doctor-park',
    kind: 'unreadable-record',
    guardHash: h.treeHash,
    opId,
  })
  if (r.status !== 'parked' || r.path === null || r.sidecarPath === null) {
    throw new Error(`parkAs: park returned ${r.status}/${r.reason}`)
  }
  return { copyPath: r.path, sidecarPath: r.sidecarPath, opDir: path.dirname(r.path) }
}

const list = (b: string, o: Partial<ListBackupsOptions> = {}): Promise<BackupsListing> =>
  listBackups({ stateRoot: state(b), discovery: hermetic(b), ...o })

const rows = (l: BackupsListing): ParkedRow[] => l.parked.flatMap((a) => a.rows)
const rowOf = (l: BackupsListing, cp: string): ParkedRow | undefined =>
  rows(l).find((r) => r.copy.copyPath === cp)

/** Lock 1 of each parked copy's area root, so only protection can keep a copy. */
function plan(l: BackupsListing, r: Partial<PruneRequest>): PrunePlan {
  const locks = new Map<string, LockAssignment>()
  for (const v of l.parked) {
    for (const row of v.rows) {
      locks.set(row.copy.copyPath, { kind: 'lock1', path: `${v.ref.root}/.lock`, root: v.ref.root })
    }
  }
  return planPrune(
    l,
    { now: Date.now() + 60_000, includeKept: false, allowChanged: [], ...r },
    locks
  )
}
const selected = (p: PrunePlan): string[] => p.groups.flatMap((g) => g.items.map((i) => i.copyPath))
const reasonOf = (p: PrunePlan, cp: string) => p.excluded.find((e) => e.copyPath === cp)?.reason

describe("Major 1: parked protection is the listing's, three-way, and global", () => {
  it('P1: a parked sibling with the same opId and an unreadable kind makes the copy unknown, never selected', async () => {
    const b = base()
    hermetic(b)
    const x = parkAt(client(b), 'x', { opId: 'op-O' })
    const y = parkAt(client(b, 'cursor'), 'y', { opId: 'op-O' })
    fs.rmSync(y.sidecarPath)
    const l = await list(b)
    expect(rowOf(l, y.copyPath)?.kind).toBeNull()
    expect(rowOf(l, x.copyPath)?.protection).toEqual({
      status: 'unknown',
      reason: `the set-aside copy ${y.copyPath} has this operation id and an unreadable kind`,
    })
    // A copy is never its own `maybe`: the unreadable-kind copy itself is not unknown by itself.
    expect(rowOf(l, y.copyPath)?.protection).toEqual({ status: 'unprotected' })
    const p = plan(l, { op: 'op-O' })
    expect(selected(p)).not.toContain(x.copyPath)
    expect(reasonOf(p, x.copyPath)).toMatchObject({ code: 'protection-unknown' })
  })

  describe('P2: rule (c) across roots holds in a scoped and a narrowed listing', () => {
    const fixture = (b: string): { x: Parked; u: Parked } => {
      hermetic(b)
      const x = parkAt(client(b), 'x', { opId: 'op-O' })
      const u = parkAs(client(b, 'cursor'), 'u', 'op-O', 'cursor')
      return { x, u }
    }
    const protectedByU = (u: Parked) => ({
      status: 'protected',
      rule: 'parked-unreadable-record',
      path: u.copyPath,
    })

    it('control: the full listing shows both, and protects X by U', async () => {
      const b = base()
      const { x, u } = fixture(b)
      const l = await list(b)
      expect(rowOf(l, u.copyPath)?.kind).toBe('unreadable-record')
      expect(rowOf(l, x.copyPath)?.protection).toEqual(protectedByU(u))
      expect(reasonOf(plan(l, { op: 'op-O' }), x.copyPath)).toEqual({
        code: 'protected',
        rule: 'parked-unreadable-record',
        path: u.copyPath,
      })
    })

    it("listBackups({ scope }) of X's area alone: U is not shown, X is still protected and not selected", async () => {
      const b = base()
      const { x, u } = fixture(b)
      const area = path.dirname(x.opDir)
      const l = await list(b, { scope: { areaPaths: [area] } })
      expect(rowOf(l, u.copyPath)).toBeUndefined()
      expect(rowOf(l, x.copyPath)?.protection).toEqual(protectedByU(u))
      const p = plan(l, { op: 'op-O' })
      expect(selected(p)).toEqual([])
      expect(reasonOf(p, x.copyPath)).toMatchObject({ code: 'protected', path: u.copyPath })
    })

    it("--root X's root: U is not shown, X is still protected and not selected", async () => {
      const b = base()
      const { x, u } = fixture(b)
      const l = await list(b, { roots: [client(b)] })
      expect(l.narrowedTo).toEqual([client(b)])
      expect(rowOf(l, u.copyPath)).toBeUndefined()
      expect(rowOf(l, x.copyPath)?.protection).toEqual(protectedByU(u))
      const p = plan(l, { op: 'op-O' })
      expect(selected(p)).toEqual([])
      expect(reasonOf(p, x.copyPath)).toMatchObject({ code: 'protected', path: u.copyPath })
    })

    it('--client claude-code: U (client cursor) is not shown, X is still protected and not selected', async () => {
      const b = base()
      const { x, u } = fixture(b)
      const l = await list(b, { client: 'claude-code' })
      expect(l.excludedByClient?.parkedCopies).toBe(1)
      expect(rowOf(l, u.copyPath)).toBeUndefined()
      expect(rowOf(l, x.copyPath)?.protection).toEqual(protectedByU(u))
      const p = plan(l, { op: 'op-O' })
      expect(selected(p)).toEqual([])
      expect(reasonOf(p, x.copyPath)).toMatchObject({ code: 'protected', path: u.copyPath })
    })
  })

  it('P3: a record scan failure in another root makes a parked copy unknown, never selected', async () => {
    const b = base()
    hermetic(b)
    const x = parkAt(client(b), 'x', { opId: 'op-O' })
    fs.writeFileSync(path.join(client(b, 'cursor'), '.skillsmith-staging'), 'not a directory')
    const l = await list(b)
    expect(l.records.scanFailures.map((f) => f.root)).toContain(client(b, 'cursor'))
    expect(rowOf(l, x.copyPath)?.protection).toEqual({
      status: 'unknown',
      reason: expect.stringContaining(`records under ${client(b, 'cursor')} could not be read`),
    })
    const p = plan(l, { op: 'op-O' })
    expect(selected(p)).toEqual([])
    expect(reasonOf(p, x.copyPath)).toMatchObject({ code: 'protection-unknown' })
  })

  it('control: with none of those facts, the same parked copy is unprotected and selected', async () => {
    const b = base()
    hermetic(b)
    const x = parkAt(client(b), 'x', { opId: 'op-O' })
    const l = await list(b)
    expect(rowOf(l, x.copyPath)?.protection).toEqual({ status: 'unprotected' })
    expect(selected(plan(l, { op: 'op-O' }))).toEqual([x.copyPath])
  })
})
