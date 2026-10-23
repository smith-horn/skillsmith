/**
 * SMI-6531 (A1 step 4b): shared fixtures for the abort-cleanup suites.
 *
 * `spyFs` wraps fs functions on the `node:fs` default object (which the
 * source looks up at call time) and records each call's first path into one
 * timeline, which the trace sink can share, so a test can assert the order of
 * traced steps and raw syscalls together. `deletesOf` reads the deletes out of
 * such a timeline, and `treeDeletes` keeps only those that are not abort
 * cleanup's own metadata, a clock-gate probe, the emptied op dir or a lock
 * file: the plan's "no unlink or rmdir of any tree entry".
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect } from 'vitest'
import type { SwapOptions, SwapResult, TraceOp } from '../../../src/services/skill-swap.js'
import { OP_ID, run } from './skill-swap.helpers.js'
import type { Fixture, Planned, Run } from './skill-swap.helpers.js'

export type FsEvent = { fs: string; path: string; dest?: string }
export type Event = FsEvent | TraceOp

const DELETE_SYNC = ['unlinkSync', 'rmdirSync', 'rmSync'] as const
const DELETE_CB = ['unlink', 'rmdir', 'rm'] as const
/** Every delete entry point, sync, callback and promise. */
export const DELETES = [...DELETE_SYNC, ...DELETE_CB].map(String)

type AnyFn = (...args: unknown[]) => unknown
const table = fs as unknown as Record<string, AnyFn>
const promises = fs.promises as unknown as Record<string, AnyFn>

/**
 * Wraps `names` (sync or callback fs functions, and `promises.<name>`) so each
 * call is pushed onto `into` before it runs. Returns the restore function.
 */
export function spyFs(names: string[], into: Event[]): () => void {
  const saved: Array<[Record<string, AnyFn>, string, AnyFn]> = []
  for (const full of names) {
    const [obj, name, label] = full.startsWith('promises.')
      ? [promises, full.slice('promises.'.length), full]
      : [table, full, full]
    const orig = obj[name] as AnyFn
    saved.push([obj, name, orig])
    obj[name] = function spied(this: unknown, ...args: unknown[]): unknown {
      const e: FsEvent = { fs: label, path: String(args[0]) }
      if (typeof args[1] === 'string') e.dest = args[1]
      into.push(e)
      return orig.apply(this, args)
    }
  }
  return () => {
    for (const [obj, name, orig] of saved.reverse()) obj[name] = orig
  }
}

/** Every delete function, in all three families. */
export const ALL_DELETES = [...DELETES, ...DELETE_CB.map((n) => `promises.${n}`)]

/** Runs the swap with the trace and the given fs spies feeding one timeline. */
export async function runSpied(
  p: Planned,
  fsNames: string[],
  options: SwapOptions = {}
): Promise<Run & { events: Event[] }> {
  const events: Event[] = []
  const restore = spyFs(fsNames, events)
  try {
    const r = await run(p, { ...options, trace: (t) => events.push(t) })
    return { ...r, events }
  } finally {
    restore()
  }
}

export const isFs = (e: Event): e is FsEvent => 'fs' in e

/** The deletes in a timeline. */
export const deletesOf = (events: Event[]): FsEvent[] =>
  events.filter(isFs).filter((e) => ALL_DELETES.includes(e.fs))

/**
 * The deletes that are not abort cleanup's own: its metadata files in OP, a
 * clock-gate probe in ST, `rmdir` of the op dir, and lock files.
 */
export function treeDeletes(fx: Fixture, events: Event[]): FsEvent[] {
  const meta = new Set(
    ['owner.json', 'owner.json.tmp', 'record.json', 'record.json.tmp', 'park-intent.json.tmp'].map(
      (n) => path.join(fx.opDir, n)
    )
  )
  return deletesOf(events).filter((e) => {
    if (meta.has(e.path)) return false
    if (e.path === fx.opDir && e.fs.includes('rmdir')) return false
    if (
      path.dirname(e.path) === fx.staging &&
      path.basename(e.path).startsWith('.skillsmith-probe-')
    )
      return false
    if (/\.lock(\.reclaim)?$/.test(e.path)) return false
    // The backup area's sidecar temp (publishTree's metadata publish).
    if (e.path.endsWith('.json.tmp') && e.path.startsWith(fx.stateRoot)) return false
    return true
  })
}

/** `ST/.skillsmith-parked/<opId>`. */
export const parkedOpArea = (fx: Fixture): string =>
  path.join(fx.staging, '.skillsmith-parked', OP_ID)

/** The one parked copy of OP (`<opId>-<rnd>`), asserting there is exactly one with its sidecar. */
export function parkedCopy(fx: Fixture): string {
  const area = parkedOpArea(fx)
  const names = fs.readdirSync(area).sort()
  const trees = names.filter((n) => !n.endsWith('.json'))
  expect(trees).toHaveLength(1)
  expect(trees[0]).toMatch(new RegExp(`^${OP_ID}-[0-9a-f]{8}$`))
  return path.join(area, trees[0]!)
}

/** The parked index's lines for this fixture's state root. */
export function indexLines(fx: Fixture): Array<Record<string, unknown>> {
  const p = path.join(fx.stateRoot, 'parked-index.jsonl')
  if (!fs.existsSync(p)) return []
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

/** Narrows a result to `refused`. */
export function refusedOf(r: SwapResult): Extract<SwapResult, { status: 'refused' }> {
  expect(r.status).toBe('refused')
  if (r.status !== 'refused') throw new Error('unreachable')
  return r
}

/** Every file's bytes in `dir`, by relative path (symlinks as `-> text`). */
export function contentOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (rel: string): void => {
    const abs = path.join(dir, rel)
    const s = fs.lstatSync(abs)
    if (s.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(abs)}`
    else if (s.isFile()) out[rel] = fs.readFileSync(abs, 'utf8')
    else if (s.isDirectory()) {
      if (rel !== '') out[`${rel}/`] = 'dir'
      for (const n of fs.readdirSync(abs).sort()) walk(rel === '' ? n : `${rel}/${n}`)
    }
  }
  walk('')
  return out
}

/** Collects stderr lines through the `stderr` option. */
export function stderrSink(): { lines: string[]; stderr: (l: string) => void } {
  const lines: string[] = []
  return { lines, stderr: (l) => lines.push(l) }
}
