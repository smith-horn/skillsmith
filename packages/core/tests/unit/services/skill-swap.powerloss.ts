/**
 * SMI-6531 (A1 step 4c): the power-loss model T-P5 replays a recorded syscall
 * trace through (A1 plan §3.3 sync rule, E27).
 *
 * A directory entry survives a crash only if its directory was synced after
 * the change: each directory node keeps a `live` entry map and a `durable` one,
 * and a `dirsync` copies live onto durable. File data survives once the file
 * is `fsync`ed. A directory that existed before the trace (its first mention is
 * not its own `mkdir`) is durable from the start, as the skill folder is.
 *
 * A tree is one node with a content token: `OLD` for the skill folder as
 * planned, `NEW` for the build in `new/`, and a `copy` event gives its
 * destination its source's token. A copy's own entries are synced by the copy
 * itself (`copyTreeNoFollow` syncs each file and directory), so its token is
 * durable with the node; whether the node is reachable still depends on its
 * parent's sync. A park is a rename the park call does not sync (ADR-166's park
 * syncs nothing), so a crash after it can only leave the op dir where it was.
 *
 * At every crash point (before each event, and after the last) the durable
 * namespace must satisfy, else the replay fails naming the point:
 *  1. the old tree (a node with token `OLD`) is reachable;
 *  2. once the path durably held the new tree, the new tree stays reachable;
 *  3. the manifest at `postEntry` (a `manifest-write` event has happened) only
 *     while the path durably holds the new tree;
 *  4. while the path does not durably hold the old tree, a durable, synced
 *     `record.json` exists in OP, unless the update committed and a copy of the
 *     old tree is durable outside the staging directory (the backup).
 */
import path from 'node:path'
import type { TraceOp } from '../../../src/services/skill-swap.js'

type Token = 'OLD' | 'NEW' | null

interface Node {
  dir: boolean
  token: Token
}

export interface ModelPaths {
  /** The skill folder. */
  realDir: string
  /** ST. */
  staging: string
  /** OP. */
  opDir: string
}

export type Verdict = { ok: true; points: number } | { ok: false; point: number; why: string }

class Model {
  private next = 1
  private readonly nodes = new Map<number, Node>()
  private readonly live = new Map<number, Map<string, number>>()
  private readonly durable = new Map<number, Map<string, number>>()
  private readonly synced = new Set<number>()
  private readonly root: number
  committed = false

  constructor(paths: ModelPaths) {
    this.root = this.node(true, null, true)
    const id = this.ensure(paths.realDir)
    this.nodes.get(id)!.token = 'OLD'
  }

  private node(dir: boolean, token: Token, durableNow: boolean): number {
    const id = this.next++
    this.nodes.set(id, { dir, token })
    if (dir) {
      this.live.set(id, new Map())
      this.durable.set(id, new Map())
    }
    if (durableNow && !dir) this.synced.add(id)
    return id
  }

  /** The live node at `p`, creating any missing component as a pre-existing, durable directory. */
  private ensure(p: string): number {
    let cur = this.root
    for (const part of p.split('/').filter(Boolean)) {
      const kids = this.live.get(cur)!
      let id = kids.get(part)
      if (id === undefined) {
        id = this.node(true, null, true)
        kids.set(part, id)
        this.durable.get(cur)!.set(part, id)
      }
      cur = id
    }
    return cur
  }

  private lookup(p: string, ns: 'live' | 'durable'): number | null {
    const maps = ns === 'live' ? this.live : this.durable
    let cur = this.root
    for (const part of p.split('/').filter(Boolean)) {
      const id = maps.get(cur)?.get(part)
      if (id === undefined) return null
      cur = id
    }
    return cur
  }

  private place(p: string, id: number | null): void {
    const parent = this.ensure(path.dirname(p))
    if (id === null) this.live.get(parent)!.delete(path.basename(p))
    else this.live.get(parent)!.set(path.basename(p), id)
  }

  apply(t: TraceOp): void {
    switch (t.op) {
      case 'mkdir':
        this.place(t.path, this.node(true, null, false))
        return
      case 'create':
        this.place(t.path, this.node(false, null, false))
        return
      case 'fsync': {
        const id = this.lookup(t.path, 'live')
        if (id !== null) this.synced.add(id)
        return
      }
      case 'dirsync': {
        const id = this.ensure(t.path)
        this.durable.set(id, new Map(this.live.get(id)!))
        return
      }
      case 'rename': {
        const id = this.lookup(t.path, 'live')
        if (id === null) throw new Error(`model: rename of a missing ${t.path}`)
        this.place(t.path, null)
        this.place(t.dest, id)
        return
      }
      case 'link': {
        const id = this.lookup(t.path, 'live')
        if (id === null) throw new Error(`model: link of a missing ${t.path}`)
        this.place(t.dest, id)
        return
      }
      case 'unlink':
      case 'rmdir':
        this.place(t.path, null)
        return
      case 'copy': {
        const src = this.lookup(t.path, 'live')
        const token: Token =
          path.basename(t.dest) === 'new' ? 'NEW' : src === null ? null : this.nodes.get(src)!.token
        const at = this.lookup(t.dest, 'live')
        if (at !== null) this.nodes.get(at)!.token = token
        else this.place(t.dest, this.node(true, token, false))
        return
      }
      case 'manifest-write':
        this.committed = true
        return
      case 'park': {
        if (t.dest === null) return
        const id = this.lookup(t.path, 'live')
        if (id === null) throw new Error(`model: park of a missing ${t.path}`)
        this.place(t.path, null)
        this.place(t.dest, id)
        return
      }
      default:
        return
    }
  }

  /** Every durably reachable node, with the path it is reached by (first found). */
  private reachable(): Map<number, string> {
    const out = new Map<number, string>([[this.root, '/']])
    const stack: Array<[number, string]> = [[this.root, '']]
    while (stack.length > 0) {
      const [id, p] = stack.pop()!
      for (const [name, kid] of this.durable.get(id) ?? []) {
        if (out.has(kid)) continue
        const kp = `${p}/${name}`
        out.set(kid, kp)
        if (this.nodes.get(kid)!.dir) stack.push([kid, kp])
      }
    }
    return out
  }

  /** The durable token at `p`, or null. */
  tokenAt(p: string): Token {
    const id = this.lookup(p, 'durable')
    return id === null ? null : this.nodes.get(id)!.token
  }

  check(paths: ModelPaths, newWasDurable: boolean): string | null {
    const seen = this.reachable()
    const withToken = (tok: Token) =>
      [...seen].filter(([id]) => this.nodes.get(id)!.token === tok).map(([, p]) => p)
    const at = this.tokenAt(paths.realDir)
    if (withToken('OLD').length === 0) return 'the old tree is reachable nowhere'
    if (newWasDurable && withToken('NEW').length === 0) {
      return 'the new tree was durably at the path and is now reachable nowhere'
    }
    if (this.committed && at !== 'NEW') {
      return "the manifest is at postEntry while the path doesn't hold the new tree"
    }
    if (at !== 'OLD') {
      const backedUp =
        this.committed && withToken('OLD').some((p) => !p.startsWith(`${paths.staging}/`))
      const rec = this.lookup(path.join(paths.opDir, 'record.json'), 'durable')
      if (!backedUp && (rec === null || !this.synced.has(rec))) {
        return `the path holds ${at ?? 'nothing'} with no durable record.json`
      }
    }
    return null
  }
}

/** Replays `trace` and checks every crash point. */
export function replay(trace: readonly TraceOp[], paths: ModelPaths): Verdict {
  const m = new Model(paths)
  let newWasDurable = false
  for (let i = 0; i <= trace.length; i++) {
    const why = m.check(paths, newWasDurable)
    if (why !== null) return { ok: false, point: i, why }
    if (m.tokenAt(paths.realDir) === 'NEW') newWasDurable = true
    if (i < trace.length) m.apply(trace[i]!)
  }
  return { ok: true, points: trace.length + 1 }
}

const isSync = (t: TraceOp, p: string) => t.op === 'dirsync' && t.path === p

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
