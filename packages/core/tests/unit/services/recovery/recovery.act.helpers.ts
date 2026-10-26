/**
 * SMI-6531 (A1 step 6a-ii): fixtures for doctor's `--apply` / `--undo` suites.
 *
 * `act` plans (lock-free, `planRecovery`) and then runs (`executeRecovery`)
 * one action on a crashed state from `recovery.helpers.ts`, with a trace
 * recorder and a removal spy built from the trace. `kills` re-runs an action
 * with a throwing hook at one boundary and then the same action again.
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect } from 'vitest'
import { executeRecovery } from '../../../../src/services/skill-recovery.run.js'
import { planRecovery } from '../../../../src/services/skill-recovery.target.js'
import type {
  RecoveryPlanResult,
  RecoveryRequest,
  RecoveryRunOptions,
  RecoveryRunResult,
} from '../../../../src/services/skill-recovery.run.types.js'
import type { SwapHookPoint, TraceOp } from '../../../../src/services/skill-swap.types.js'
import { areaOf, hashOf } from '../skill-swap.helpers.js'
import { deepSnapshot } from '../skill-swap.scan.helpers.js'
import type { Fixture } from '../skill-swap.helpers.js'
import { journalOf } from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'

export interface Acted {
  planned: RecoveryPlanResult
  result: RecoveryRunResult
  trace: TraceOp[]
}

/** The request for `st`'s op in its own root. */
export function requestOf(
  st: Pick<State, 'fx' | 'opId'>,
  action: 'apply' | 'undo',
  over: Partial<RecoveryRequest> = {}
): RecoveryRequest {
  return {
    action,
    opId: st.opId,
    roots: over.roots ?? [fs.realpathSync(st.fx.skillsDir)],
    euid: process.geteuid?.() ?? 0,
    journalFile: journalOf(st.fx),
    ...over,
  }
}

/** Plans `action` for `st`, then (when offered) runs it. */
export async function act(
  st: Pick<State, 'fx' | 'opId'>,
  action: 'apply' | 'undo',
  over: Partial<RecoveryRequest> = {},
  opts: RecoveryRunOptions = {}
): Promise<Acted> {
  const trace: TraceOp[] = []
  const planned = await planRecovery(requestOf(st, action, over))
  if (planned.status !== 'planned') return { planned, result: planned, trace }
  const result = await executeRecovery(planned, {
    ...opts,
    swap: { ...opts.swap, trace: (t) => trace.push(t) },
  })
  return { planned, result, trace }
}

/** `act`, requiring it to finish. */
export async function done(
  st: Pick<State, 'fx' | 'opId'>,
  action: 'apply' | 'undo',
  over: Partial<RecoveryRequest> = {},
  opts: RecoveryRunOptions = {}
): Promise<Acted & { result: Extract<RecoveryRunResult, { status: 'done' }> }> {
  const a = await act(st, action, over, opts)
  if (a.result.status !== 'done') {
    throw new Error(`expected done, got ${JSON.stringify(a.result).slice(0, 600)}`)
  }
  return a as Acted & { result: Extract<RecoveryRunResult, { status: 'done' }> }
}

/** A hook that throws at its `nth` firing (1-based), simulating a kill at `point`. */
export function killAt(point: SwapHookPoint, nth = 1): RecoveryRunOptions {
  let seen = 0
  return {
    swap: {
      hooks: {
        [point]: () => {
          seen++
          if (seen === nth) throw new Error(`killed at ${point} #${nth}`)
        },
      },
    },
  }
}

/** Options whose hooks count how often each of `points` fires. */
export function counting(points: readonly SwapHookPoint[]): {
  opts: RecoveryRunOptions
  counts: Map<SwapHookPoint, number>
} {
  const counts = new Map<SwapHookPoint, number>()
  const hooks: Partial<Record<SwapHookPoint, () => void>> = {}
  for (const p of points) hooks[p] = () => void counts.set(p, (counts.get(p) ?? 0) + 1)
  return { opts: { swap: { hooks } }, counts }
}

/** Every path the trace removed (unlink or rmdir): the removal spy. */
export const removedBy = (trace: readonly TraceOp[]): string[] =>
  trace.filter((t) => t.op === 'unlink' || t.op === 'rmdir').map((t) => t.path)

/**
 * Asserts each removal is metadata (an op dir's JSON, a sidecar or its temp), a probe
 * or an op dir: no tree. And that at least one removal ran (a spy that saw
 * nothing proves nothing).
 */
export function onlyMetadataRemoved(trace: readonly TraceOp[], fx: Fixture): void {
  const removed = removedBy(trace)
  expect(removed.length).toBeGreaterThan(0)
  for (const p of removed) {
    const name = path.basename(p)
    const meta =
      name === 'record.json' ||
      name === 'owner.json' ||
      name === 'record.json.tmp' ||
      name.endsWith('.json.tmp') ||
      // A sidecar replaced by the rewrite (the plan's rewrite rule).
      (name.endsWith('.json') && path.dirname(p) === areaOf(fx)) ||
      name.startsWith('.skillsmith-probe-') ||
      path.dirname(p) === fx.staging
    expect(meta, `removed ${p}`).toBe(true)
  }
}

/** The kept trees of the fixture's area, by name, with their hashes. */
export function keptTrees(fx: Fixture): Record<string, string> {
  const area = areaOf(fx)
  if (!fs.existsSync(area)) return {}
  const out: Record<string, string> = {}
  for (const n of fs.readdirSync(area).sort()) {
    const p = path.join(area, n)
    if (fs.lstatSync(p).isDirectory()) out[n] = hashOf(p)
  }
  return out
}

/** The area's entry names (trees, sidecars, temps). */
export const areaNames = (fx: Fixture): string[] =>
  fs.existsSync(areaOf(fx)) ? fs.readdirSync(areaOf(fx)).sort() : []

/** The manifest entry for the fixture's skill, as the file holds it. */
export function entryOf(fx: Fixture): unknown {
  const m = JSON.parse(fs.readFileSync(path.join(fx.stateRoot, 'manifest.json'), 'utf8')) as {
    installedSkills: Record<string, unknown>
  }
  return m.installedSkills[fx.dirName]
}

/** The journal's lines that are `update` records for `opId`. */
export function auditLines(fx: Fixture, opId: string): number {
  const f = journalOf(fx)
  if (!fs.existsSync(f)) return 0
  return fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => {
      try {
        const v = JSON.parse(l) as { tool?: string; suggestion_id?: string }
        return v.tool === 'update' && v.suggestion_id === opId
      } catch {
        return false
      }
    }).length
}

/** Lock 1's file and its reclaim: taken and released by any action, never content. */
const isLockFile = (abs: string): boolean =>
  path.basename(abs).startsWith('.skillsmith-writes.lock')

/**
 * The entries under `dirs` (types, modes, inodes, bytes), without directory
 * bookkeeping (mtime, link count) and without lock 1's file, which every
 * action that takes lock 1 creates and removes: what "zero mutation" compares.
 */
export function contentSnapshot(...dirs: string[]): string {
  return dirs.map((d) => deepSnapshot(d, { prune: true, skip: isLockFile })).join('\n--\n')
}
