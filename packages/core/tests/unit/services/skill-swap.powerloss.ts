/**
 * SMI-6531 (A1 step 4c, review round 1): the power-loss model T-P5 replays a
 * recorded syscall trace through (A1 plan §3.3 sync rule, E27).
 *
 * **What survives a crash.** Every directory-entry change (an entry added,
 * replaced or removed by a `mkdir`, create, `link`, `rename`, `unlink`,
 * `rmdir` or park) is pending until its directory is synced, which makes every
 * pending change in that directory durable. At a crash, any combination of the
 * pending changes may have reached disk, independently per change, subject to
 * two rules a journaling filesystem keeps:
 *
 *  - a `rename` is atomic: while both of its halves are pending, they persist
 *    together;
 *  - a change persists only if the creations of the directories it lands in
 *    persisted (a rename's removal half counts its destination's ancestors):
 *    an entry cannot reach disk inside a directory that never did.
 *
 * Nothing else is assumed: once a directory is synced, its half of a rename is
 * durable whatever happened to the other half, and an unsynced unlink may
 * persist on its own. File data survives once the file is `fsync`ed. A
 * directory the trace mentions before any `mkdir` of it existed before the
 * run and is durable. A park (ADR-166's port syncs nothing) creates the parked
 * area's new directories as pending `mkdir`s, then renames OP into them; the
 * caller's syncs after it (round 1, fix 1) are ordinary `dirsync` events.
 *
 * A tree is one node with a content token: `OLD` for the skill folder as
 * planned, `NEW` for the build in `new/`; a `copy` gives its destination its
 * source's token (the copy syncs its own entries). The old folder itself is
 * tracked by node, not token, so a copy of it never stands in for it.
 *
 * At every crash point (before each event, and after the last), in EVERY
 * permitted combination, the replay fails unless:
 *  1. the old folder (the node first at the path) is reachable;
 *  2. once the path held the new tree in every combination, the new tree stays
 *     reachable;
 *  3. after the manifest write, the path holds the new tree;
 *  4. wherever the path does not hold the old folder, a synced `record.json`
 *     is reachable in OP, unless the update committed and the backup (a copy
 *     or the old folder, token `OLD`) is reachable at exactly `<area>/<opId>`;
 *  5. wherever the copy temp or the backup is reachable, its sidecar or its
 *     sidecar temp is reachable with synced data (so doctor can name it).
 */
import path from 'node:path'
import type { TraceOp } from '../../../src/services/skill-swap.js'

type Token = 'OLD' | 'NEW' | null

interface Node {
  dir: boolean
  token: Token
}

interface Change {
  seq: number
  dir: number
  name: string
  to: number | null
  deps: Set<number>
  pair: number | null
}

export interface ModelPaths {
  /** The skill folder. */
  realDir: string
  /** ST. */
  staging: string
  /** OP. */
  opDir: string
  /** `<area>/<opId>`, the backup's fixed name. */
  backupDest: string
}

export type Verdict =
  | { ok: true; points: number }
  | { ok: false; point: number; why: string; persisted: string[] }

/** More pending units than this at one crash point is a model error, not a pass. */
const MAX_UNITS = 18

class Model {
  private next = 1
  private seq = 1
  private readonly nodes = new Map<number, Node>()
  private readonly base = new Map<number, Map<string, number>>()
  private readonly live = new Map<number, Map<string, number>>()
  private readonly parent = new Map<number, number>()
  private readonly created = new Map<number, number>()
  private readonly pending = new Map<number, Change>()
  private readonly synced = new Set<number>()
  private readonly root: number
  readonly oldNode: number
  newNode: number | null = null
  committed = false

  constructor(paths: ModelPaths) {
    this.root = this.node(true, null)
    this.oldNode = this.ensure(paths.realDir)
    this.nodes.get(this.oldNode)!.token = 'OLD'
  }

  private node(dir: boolean, token: Token): number {
    const id = this.next++
    this.nodes.set(id, { dir, token })
    if (dir) {
      this.live.set(id, new Map())
      this.base.set(id, new Map())
    }
    return id
  }

  /** The live node at `p`; a missing component existed before the run and is durable. */
  private ensure(p: string): number {
    let cur = this.root
    for (const part of p.split('/').filter(Boolean)) {
      let id = this.live.get(cur)!.get(part)
      if (id === undefined) {
        id = this.node(true, null)
        this.live.get(cur)!.set(part, id)
        this.base.get(cur)!.set(part, id)
        this.parent.set(id, cur)
      }
      cur = id
    }
    return cur
  }

  /** The live node at `p`; a missing component is made now, as a pending `mkdir`. */
  private ensurePending(p: string): number {
    let cur = this.root
    for (const part of p.split('/').filter(Boolean)) {
      let id = this.live.get(cur)!.get(part)
      if (id === undefined) {
        id = this.node(true, null)
        this.created.set(id, this.change(cur, part, id, this.chain(cur)))
      }
      cur = id
    }
    return cur
  }

  private lookup(p: string): number | null {
    let cur = this.root
    for (const part of p.split('/').filter(Boolean)) {
      const id = this.live.get(cur)?.get(part)
      if (id === undefined) return null
      cur = id
    }
    return cur
  }

  /** The pending creations of `dir` and its ancestors. */
  private chain(dir: number): Set<number> {
    const out = new Set<number>()
    for (
      let d: number | undefined = dir;
      d !== undefined && d !== this.root;
      d = this.parent.get(d)
    ) {
      const s = this.created.get(d)
      if (s !== undefined && this.pending.has(s)) out.add(s)
    }
    return out
  }

  private change(dir: number, name: string, to: number | null, deps: Set<number>): number {
    const seq = this.seq++
    this.pending.set(seq, { seq, dir, name, to, deps, pair: null })
    if (to === null) this.live.get(dir)!.delete(name)
    else {
      this.live.get(dir)!.set(name, to)
      if (this.nodes.get(to)!.dir) this.parent.set(to, dir)
    }
    return seq
  }

  private split(p: string): [number, string] {
    return [this.ensure(path.dirname(p)), path.basename(p)]
  }

  private rename(from: string, to: string, pendingParents: boolean): void {
    const id = this.lookup(from)
    if (id === null) throw new Error(`model: rename of a missing ${from}`)
    const [pa, na] = this.split(from)
    const pb = pendingParents ? this.ensurePending(path.dirname(to)) : this.ensure(path.dirname(to))
    const chain = this.chain(pb)
    const add = this.change(pb, path.basename(to), id, chain)
    const rem = this.change(pa, na, null, new Set([add, ...chain]))
    this.pending.get(add)!.pair = rem
    this.pending.get(rem)!.pair = add
  }

  apply(t: TraceOp): void {
    switch (t.op) {
      case 'mkdir': {
        const [d, n] = this.split(t.path)
        const id = this.node(true, null)
        this.created.set(id, this.change(d, n, id, this.chain(d)))
        return
      }
      case 'create': {
        const [d, n] = this.split(t.path)
        this.change(d, n, this.node(false, null), this.chain(d))
        return
      }
      case 'fsync': {
        const id = this.lookup(t.path)
        if (id !== null) this.synced.add(id)
        return
      }
      case 'dirsync':
        this.sync(this.ensure(t.path))
        return
      case 'rename':
        this.rename(t.path, t.dest, false)
        return
      case 'link': {
        const id = this.lookup(t.path)
        if (id === null) throw new Error(`model: link of a missing ${t.path}`)
        const [d, n] = this.split(t.dest)
        this.change(d, n, id, this.chain(d))
        return
      }
      case 'unlink':
      case 'rmdir': {
        const [d, n] = this.split(t.path)
        this.change(d, n, null, new Set())
        return
      }
      case 'copy': {
        const src = this.lookup(t.path)
        const token: Token =
          path.basename(t.dest) === 'new' ? 'NEW' : src === null ? null : this.nodes.get(src)!.token
        const at = this.lookup(t.dest)
        if (at !== null) this.nodes.get(at)!.token = token
        else {
          const [d, n] = this.split(t.dest)
          const id = this.node(true, token)
          this.created.set(id, this.change(d, n, id, this.chain(d)))
        }
        if (token === 'NEW') this.newNode = this.lookup(t.dest)
        return
      }
      case 'manifest-write':
        this.committed = true
        return
      case 'park':
        if (t.dest !== null) this.rename(t.path, t.dest, true)
        return
      default:
        return
    }
  }

  /** A `dirsync`: every pending change in `dir` becomes durable. */
  private sync(dir: number): void {
    this.base.set(dir, new Map(this.live.get(dir)!))
    const done = new Set<number>()
    for (const c of this.pending.values()) if (c.dir === dir) done.add(c.seq)
    for (const s of done) this.pending.delete(s)
    for (const c of this.pending.values()) {
      for (const s of done) c.deps.delete(s)
      if (c.pair !== null && done.has(c.pair)) c.pair = null
    }
  }

  /** Every permitted set of persisted pending changes. */
  *states(): Generator<Set<number>> {
    const units: number[][] = []
    const seen = new Set<number>()
    for (const c of this.pending.values()) {
      if (seen.has(c.seq)) continue
      const unit = c.pair !== null ? [c.seq, c.pair] : [c.seq]
      for (const s of unit) seen.add(s)
      units.push(unit)
    }
    if (units.length > MAX_UNITS) throw new Error(`model: ${units.length} pending units`)
    for (let mask = 0; mask < 1 << units.length; mask++) {
      const s = new Set<number>()
      units.forEach((u, i) => {
        if (mask & (1 << i)) for (const x of u) s.add(x)
      })
      let ok = true
      for (const x of s) for (const d of this.pending.get(x)!.deps) if (!s.has(d)) ok = false
      if (ok) yield s
    }
  }

  /** A view of the namespace in which exactly `persisted` of the pending changes reached disk. */
  view(persisted: Set<number>) {
    const dirs = new Map<number, Map<string, number>>()
    const entries = (d: number): Map<string, number> => {
      let m = dirs.get(d)
      if (m === undefined) {
        m = new Map(this.base.get(d) ?? [])
        for (const c of this.pending.values()) {
          if (c.dir !== d || !persisted.has(c.seq)) continue
          if (c.to === null) m.delete(c.name)
          else m.set(c.name, c.to)
        }
        dirs.set(d, m)
      }
      return m
    }
    const resolve = (p: string): number | null => {
      let cur = this.root
      for (const part of p.split('/').filter(Boolean)) {
        const id = entries(cur).get(part)
        if (id === undefined) return null
        cur = id
      }
      return cur
    }
    const reachable = new Set<number>([this.root])
    const stack = [this.root]
    while (stack.length > 0) {
      const d = stack.pop()!
      for (const kid of entries(d).values()) {
        if (reachable.has(kid)) continue
        reachable.add(kid)
        if (this.nodes.get(kid)!.dir) stack.push(kid)
      }
    }
    const token = (id: number | null): Token => (id === null ? null : this.nodes.get(id)!.token)
    const syncedFile = (p: string): boolean => {
      const id = resolve(p)
      return id !== null && this.synced.has(id)
    }
    return { resolve, reachable, token, syncedFile }
  }

  describe(persisted: Set<number>): string[] {
    return [...this.pending.values()]
      .filter((c) => persisted.has(c.seq))
      .map((c) => `${c.name}${c.to === null ? ' removed' : ' added'}`)
  }
}

/** Replays `trace` and checks every crash point in every permitted combination. */
export function replay(trace: readonly TraceOp[], paths: ModelPaths): Verdict {
  const m = new Model(paths)
  let newWasDurable = false
  const temp = path.join(path.dirname(paths.backupDest), `.tmp-${path.basename(paths.backupDest)}`)
  for (let i = 0; i <= trace.length; i++) {
    let newEverywhere = m.newNode !== null
    for (const s of m.states()) {
      const v = m.view(s)
      const fail = (why: string): Verdict => ({
        ok: false,
        point: i,
        why,
        persisted: m.describe(s),
      })
      const at = v.resolve(paths.realDir)
      if (at !== m.newNode) newEverywhere = false
      if (!v.reachable.has(m.oldNode)) return fail('the old tree is reachable nowhere')
      if (newWasDurable && (m.newNode === null || !v.reachable.has(m.newNode))) {
        return fail('the new tree was durably at the path and is now reachable nowhere')
      }
      if (m.committed && at !== m.newNode) {
        return fail("the manifest is at postEntry while the path doesn't hold the new tree")
      }
      if (at !== m.oldNode) {
        const backedUp = m.committed && v.token(v.resolve(paths.backupDest)) === 'OLD'
        if (!backedUp && !v.syncedFile(path.join(paths.opDir, 'record.json'))) {
          const holds = at === null ? 'nothing' : at === m.newNode ? 'NEW' : 'another entry'
          return fail(`the path holds ${holds} with no durable record.json`)
        }
      }
      if (v.resolve(temp) !== null || v.resolve(paths.backupDest) !== null) {
        const side = `${paths.backupDest}.json`
        if (!v.syncedFile(side) && !v.syncedFile(`${side}.tmp`)) {
          return fail('the copy temp or the backup is reachable without a durable sidecar')
        }
      }
    }
    if (newEverywhere) newWasDurable = true
    if (i < trace.length) m.apply(trace[i]!)
  }
  return { ok: true, points: trace.length + 1 }
}

const isSync = (t: TraceOp | undefined, p: string) => t?.op === 'dirsync' && t.path === p

/** Control (a): the staging sync right after `mkdir OP` dropped. */
export function dropStagingSync(trace: readonly TraceOp[], paths: ModelPaths): TraceOp[] {
  const i = trace.findIndex((t) => t.op === 'mkdir' && t.path === paths.opDir)
  if (i < 0 || !isSync(trace[i + 1]!, paths.staging)) throw new Error('control (a): no such sync')
  return [...trace.slice(0, i + 1), ...trace.slice(i + 2)]
}

/** Index of rename 1 (`realDir` to `OP/old`), which must be followed by its two syncs. */
function rename1(trace: readonly TraceOp[], paths: ModelPaths): number {
  const i = trace.findIndex((t) => t.op === 'rename' && t.path === paths.realDir)
  const root = path.dirname(paths.realDir)
  if (i < 0 || !isSync(trace[i + 1]!, paths.opDir) || !isSync(trace[i + 2]!, root)) {
    throw new Error('control: rename 1 is not followed by sync OP, sync R')
  }
  return i
}

/** Control (b): the syncs between the two renames dropped. */
export function dropSyncsBetweenRenames(trace: readonly TraceOp[], paths: ModelPaths): TraceOp[] {
  const i = rename1(trace, paths)
  return [...trace.slice(0, i + 1), ...trace.slice(i + 3)]
}

/** Control (c): after rename 1, the source parent synced before the destination parent. */
export function destinationAfterSource(trace: readonly TraceOp[], paths: ModelPaths): TraceOp[] {
  const i = rename1(trace, paths)
  return [...trace.slice(0, i + 1), trace[i + 2]!, trace[i + 1]!, ...trace.slice(i + 3)]
}

/** The index of the park event and its three syncs (round 1, fix 1), checked present. */
export function parkSyncs(trace: readonly TraceOp[], paths: ModelPaths): number {
  const i = trace.findIndex((t) => t.op === 'park')
  const landed = path.join(paths.staging, '.skillsmith-parked', path.basename(paths.opDir))
  const want = [landed, path.dirname(landed), paths.staging]
  if (i < 0 || !want.every((d, k) => isSync(trace[i + 1 + k]!, d))) {
    throw new Error('control: the park is not followed by its three syncs')
  }
  return i
}
