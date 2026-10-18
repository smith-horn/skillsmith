/**
 * SMI-6531: shared fixtures and the fs interposition seam for the park-tree
 * suites, ported from the SMI-6676 spike's `harness/postmove-seam.mjs`.
 *
 * The seam reassigns methods on the `node:fs` DEFAULT export object, which is
 * what every park module calls through at call time (the boundary test pins
 * that). Hooks run unrecorded.
 */
import fs from 'node:fs'
import type { Stats } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parkTree, computePathTreeHash } from '../../../src/install/park-tree.js'
import { parkTreeIndexed } from '../../../src/install/park-call.js'
import type { ParkOptions, ParkResult } from '../../../src/install/park-result.js'

export const CLIENT = 'test-client'
/** A real caller and its kind: the park refuses a kind that is not the caller's. */
export const CALLER = 'uninstall' as const
export const KIND = 'uninstall'
export const PARKED = '.skillsmith-parked'

type AnyFn = (...args: unknown[]) => unknown
const fsTable = fs as unknown as Record<string, unknown>
const TWO_PATH = new Set(['renameSync', 'linkSync', 'copyFileSync', 'cpSync'])

export interface Fixture {
  root: string
  parent: string
  origin: string
  name: string
  target: string
}

/** parent/tree/{target/orig-f1 (0644), top.txt, link -> orig-link-target}. */
export function buildFixture(prefix = 'park-pm-'): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const parent = path.join(root, 'parent')
  const origin = path.join(parent, 'tree')
  populate(origin)
  return { root, parent, origin, name: 'tree', target: path.join(origin, 'target') }
}

/** Builds the fixture tree at `dir`; two calls yield two hash-identical trees. */
export function populate(dir: string): void {
  fs.mkdirSync(path.join(dir, 'target'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'target', 'orig-f1'), 'original-content-f1')
  fs.chmodSync(path.join(dir, 'target', 'orig-f1'), 0o644)
  fs.writeFileSync(path.join(dir, 'top.txt'), 'top-bytes')
  fs.symlinkSync('orig-link-target', path.join(dir, 'link'))
}

/** A parent holding `tree/sub/f.txt` with `bytes`. */
export function simpleFixture(prefix: string, bytes = 'USERBYTES'): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const parent = path.join(root, 'parent')
  const origin = path.join(parent, 'tree')
  fs.mkdirSync(path.join(origin, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(origin, 'sub', 'f.txt'), bytes)
  return { root, parent, origin, name: 'tree', target: path.join(origin, 'sub') }
}

/** Recursive removal that first restores permissions a test removed. Never follows links. */
export function cleanup(root: string): void {
  const fix = (p: string): void => {
    let st: Stats
    try {
      st = fs.lstatSync(p)
    } catch {
      return
    }
    if (st.isSymbolicLink()) return
    try {
      fs.chmodSync(p, st.isDirectory() ? 0o700 : 0o600)
    } catch {
      /* best effort */
    }
    if (st.isDirectory()) {
      let names: string[] = []
      try {
        names = fs.readdirSync(p)
      } catch {
        /* best effort */
      }
      for (const n of names) fix(path.join(p, n))
    }
  }
  fix(root)
  fs.rmSync(root, { recursive: true, force: true })
}

export const readText = (p: string): string => {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch (err) {
    return `UNREADABLE:${(err as NodeJS.ErrnoException).code ?? String(err)}`
  }
}

export const readJson = (p: unknown): Record<string, unknown> | string => {
  if (typeof p !== 'string') return `NO-PATH:${String(p)}`
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
  } catch (err) {
    return `UNREADABLE:${(err as NodeJS.ErrnoException).code ?? String(err)}`
  }
}

/** A field of a parsed sidecar, or undefined when the sidecar did not parse. */
export const field = (sidecar: Record<string, unknown> | string, k: string): unknown =>
  typeof sidecar === 'string' ? `NO-SIDECAR(${sidecar})` : sidecar[k]

export const guardOf = (origin: string): string => {
  const h = computePathTreeHash(origin)
  if (!h.ok) throw new Error(`fixture hash failed: ${JSON.stringify(h)}`)
  return h.treeHash
}

export const exists = (p: string): boolean =>
  fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined

/** Every entry under `dir` that is not a sidecar. */
export const parkedEntries = (dir: string): string[] =>
  exists(dir) ? fs.readdirSync(dir).filter((n) => !n.endsWith('.json')) : []

export const park = (parent: string, name: string, extra: Partial<ParkOptions> = {}): ParkResult =>
  parkTree(parent, name, { client: CLIENT, caller: CALLER, kind: KIND, ...extra })

/** `park` through `parkTreeIndexed`, the only entry point that accepts `indexPath`. */
export const parkIndexed = (
  parent: string,
  name: string,
  extra: Partial<ParkOptions> = {}
): Promise<ParkResult> =>
  parkTreeIndexed(parent, name, { client: CLIENT, caller: CALLER, kind: KIND, ...extra })

const asPath = (p: unknown): string | null =>
  typeof p === 'string'
    ? p
    : Buffer.isBuffer(p)
      ? p.toString('utf8')
      : p instanceof URL
        ? p.pathname
        : null

const inside = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child)
  return rel !== '' && !(rel === '..' || rel.startsWith('..' + path.sep)) && !path.isAbsolute(rel)
}

export type Scope = 'origin' | 'desc' | 'dest' | null
export interface TraceEntry {
  fn: string
  p0: string | null
  p1: string | null
  scope: Scope
  scope2: Scope
}
export interface HookRun {
  result: ParkResult
  trace: TraceEntry[]
  renameIdx: number
  fired: { recheck: boolean; rename: boolean; afterRename: boolean }
  hookErrors: { key: string; message: string }[]
}

/**
 * Runs `parkTree(parentAbs, name, options)` with every fs *Sync interposed.
 *  - onRecheck(): before the 3rd root lstat of the origin (a guarded park's
 *    pre-rename re-check, after its own hash): the spike's 'post-hash' window.
 *  - onRename(): before the root renameSync ('at-rename').
 *  - onAfterRename({destPath}): once, before the first op-directory call after
 *    the root rename returned.
 *  - onCall(...): before every scoped call, unrecorded.
 */
export function runWithHooks(a: {
  parentAbs: string
  name: string
  options: ParkOptions & { opId: string }
  onRecheck?: () => void
  onRename?: () => void
  onAfterRename?: (x: { destPath: string }) => void
  onCall?: (x: {
    fn: string
    p0: string | null
    scope: Scope
    renameReturned: boolean
    destPath: string | null
  }) => void
}): HookRun {
  const originPath = path.resolve(a.parentAbs, a.name)
  const opDir = path.resolve(a.parentAbs, PARKED, a.options.opId)
  const scopeOf = (p: unknown): Scope => {
    const s = asPath(p)
    if (s === null) return null
    const abs = path.resolve(s)
    if (abs === originPath) return 'origin'
    if (inside(abs, originPath)) return 'desc'
    if (inside(abs, opDir)) return 'dest'
    return null
  }
  const names = Object.keys(fs).filter(
    (k) => k.endsWith('Sync') && typeof fsTable[k] === 'function'
  )
  const pristine = new Map(names.map((n) => [n, fsTable[n] as AnyFn]))
  const trace: TraceEntry[] = []
  const fired = { recheck: false, rename: false, afterRename: false }
  const hookErrors: { key: string; message: string }[] = []
  let recording = false
  let inHook = false
  let rootLstats = 0
  let renameReturned = false
  let destPath: string | null = null
  const runHook = <T>(key: keyof typeof fired, fn: ((x: T) => void) | undefined, arg: T): void => {
    if (fired[key] || typeof fn !== 'function') return
    fired[key] = true
    inHook = true
    try {
      fn(arg)
    } catch (err) {
      hookErrors.push({ key, message: String((err as Error)?.message ?? err) })
    } finally {
      inHook = false
    }
  }
  for (const n of names) {
    const orig = pristine.get(n) as AnyFn
    fsTable[n] = function seam(this: unknown, ...args: unknown[]): unknown {
      if (!recording || inHook) return orig.apply(this, args)
      const scope = scopeOf(args[0])
      const scope2 = TWO_PATH.has(n) ? scopeOf(args[1]) : null
      if (scope === null && scope2 === null) return orig.apply(this, args)
      if (n === 'lstatSync' && scope === 'origin' && ++rootLstats === 3) {
        runHook('recheck', a.onRecheck, undefined)
      }
      const rootRename = n === 'renameSync' && scope === 'origin'
      if (rootRename) runHook('rename', a.onRename, undefined)
      if (renameReturned && (scope === 'dest' || scope2 === 'dest')) {
        runHook('afterRename', a.onAfterRename, { destPath: destPath as string })
      }
      if (typeof a.onCall === 'function') {
        inHook = true
        try {
          a.onCall({ fn: n, p0: asPath(args[0]), scope, renameReturned, destPath })
        } catch (err) {
          hookErrors.push({ key: 'onCall', message: String((err as Error)?.message ?? err) })
        } finally {
          inHook = false
        }
      }
      const p0 = asPath(args[0])
      const p1 = TWO_PATH.has(n) ? asPath(args[1]) : null
      trace.push({
        fn: n,
        p0: p0 === null ? null : path.resolve(p0),
        p1: p1 === null ? null : path.resolve(p1),
        scope,
        scope2,
      })
      const out = orig.apply(this, args)
      if (rootRename && !renameReturned) {
        renameReturned = true
        destPath = path.resolve(asPath(args[1]) as string)
      }
      return out
    }
  }
  let result: ParkResult
  try {
    recording = true
    result = parkTree(a.parentAbs, a.name, a.options)
  } finally {
    recording = false
    for (const n of names) fsTable[n] = pristine.get(n)
  }
  const renameIdx = trace.findIndex((e) => e.fn === 'renameSync' && e.scope === 'origin')
  return { result, trace, renameIdx, fired, hookErrors }
}

/** `withFsStub` for an async body: the stub stays until the promise settles. */
export async function withAsyncFsStub<T>(
  name: string,
  impl: (orig: AnyFn) => AnyFn,
  body: () => Promise<T>
): Promise<T> {
  const orig = fsTable[name] as AnyFn
  fsTable[name] = impl(orig.bind(fs) as AnyFn)
  try {
    return await body()
  } finally {
    fsTable[name] = orig
  }
}

/** Replaces `fs[name]` for the duration of `body`, restoring it after. */
export function withFsStub<T>(name: string, impl: (orig: AnyFn) => AnyFn, body: () => T): T {
  const orig = fsTable[name] as AnyFn
  fsTable[name] = impl(orig.bind(fs) as AnyFn)
  try {
    return body()
  } finally {
    fsTable[name] = orig
  }
}

/**
 * A `renameSync` stub that, right after the real rename of `origin`, writes a
 * file into the parked copy, so a guarded park's post-move check finds it
 * changed and returns `held`. Use with `withFsStub('renameSync', …)`.
 */
export const writeAfterRename =
  (origin: string) =>
  (orig: AnyFn): AnyFn =>
  (...args: unknown[]) => {
    const out = orig(...args)
    if (args[0] === origin) fs.writeFileSync(path.join(String(args[1]), 'late.txt'), 'late')
    return out
  }

/** An Error carrying an errno code, as fs throws. */
export function errnoError(code: string): NodeJS.ErrnoException {
  const e = new Error(`forced ${code}`) as NodeJS.ErrnoException
  e.code = code
  return e
}

/**
 * Counts every delete call, in all three fs API families (A1 plan row R2:
 * spying one family alone misses a recursive delete), while `body` runs.
 */
export function countDeletes<T>(body: () => T): { value: T; deletes: string[] } {
  const deletes: string[] = []
  const syncNames = ['unlinkSync', 'rmdirSync', 'rmSync']
  const cbNames = ['unlink', 'rmdir', 'rm']
  const promises = fs.promises as unknown as Record<string, unknown>
  const saved: [Record<string, unknown>, string, unknown][] = []
  const wrap = (obj: Record<string, unknown>, n: string, label: string): void => {
    const orig = obj[n] as AnyFn
    saved.push([obj, n, orig])
    obj[n] = function counted(this: unknown, ...args: unknown[]): unknown {
      deletes.push(`${label}(${String(args[0])})`)
      return orig.apply(this, args)
    }
  }
  for (const n of syncNames) wrap(fsTable, n, n)
  for (const n of cbNames) wrap(fsTable, n, n)
  for (const n of cbNames) wrap(promises, n, `promises.${n}`)
  try {
    return { value: body(), deletes }
  } finally {
    for (const [obj, n, orig] of saved.reverse()) obj[n] = orig
  }
}

/**
 * Runs `body` with EVERY fs `*Sync` function replaced by one that records the
 * call and throws (or, with `passThrough`, records and calls through), inside
 * the three-family delete spy. A call that validates
 * its input "before any filesystem work" must leave `touched` empty.
 */
export function withAllFsTrapped<T>(
  body: () => T,
  { passThrough = false }: { passThrough?: boolean } = {}
): {
  value: T
  touched: string[]
  deletes: string[]
} {
  const touched: string[] = []
  const names = Object.keys(fs).filter(
    (k) => k.endsWith('Sync') && typeof fsTable[k] === 'function'
  )
  const saved = new Map(names.map((n) => [n, fsTable[n]]))
  const { value, deletes } = countDeletes(() => {
    for (const n of names) {
      const orig = saved.get(n) as AnyFn
      fsTable[n] = function trapped(this: unknown, ...args: unknown[]): unknown {
        touched.push(`${n}(${String(args[0])})`)
        if (passThrough) return orig.apply(this, args)
        throw new Error(`filesystem touched: ${n}`)
      }
    }
    try {
      return body()
    } finally {
      for (const n of names) fsTable[n] = saved.get(n)
    }
  })
  return { value, touched, deletes }
}
