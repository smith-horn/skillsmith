/**
 * SMI-6531 (A1 step 6a-iii): fixtures for doctor's cross-device suites.
 *
 * The state root is on another device than the skills root (`xdevFixture`:
 * `/dev/shm` against `os.tmpdir()`, a real `EXDEV`). A crashed state is made
 * by a real `swapInPlace` run stopped at one of its cross-device `publishTree`
 * boundaries (step 12, after the commit and the audit), so doctor is proven
 * against what the writer leaves. `actSpied` runs a doctor action with the
 * fs delete spy and the trace on one timeline.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { expect } from 'vitest'
import type { SwapOptions, TraceOp } from '../../../../src/services/skill-swap.js'
import type { RecoveryRunOptions } from '../../../../src/services/skill-recovery.run.types.js'
import { ALL_DELETES, spyFs, treeDeletes } from '../skill-swap.abort.helpers.js'
import type { Event, FsEvent } from '../skill-swap.abort.helpers.js'
import { areaOf, modify, OP_ID, plan, run } from '../skill-swap.helpers.js'
import type { Fixture } from '../skill-swap.helpers.js'
import { parkedCopies, xdevFixture } from '../skill-swap.xdev.helpers.js'
import { syncManifest } from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'
import { act } from './recovery.act.helpers.js'
import type { Acted } from './recovery.act.helpers.js'

export const XFILES = { 'SKILL.md': '# v1\n', 'a.txt': 'a\n', 'sub/b.txt': 'b\n' }

/** A fresh cross-device fixture. */
export const xfile = (): Fixture => xdevFixture(XFILES)

/** An `Error` that a hook throws to stand for a kill. */
export const killed = (where: string): never => {
  throw new Error(`killed at ${where}`)
}

/**
 * S3 across devices with O's keep stopped at a step-12 boundary: a real update
 * committed and audited, then `options` (a throwing hook, a stub) stopped its
 * cross-device publish of O, with the record kept.
 */
export async function xs3(
  options: SwapOptions,
  fx: Fixture = xfile()
): Promise<State & { trace: TraceOp[] }> {
  const p = plan(fx, [modify('SKILL.md', '# v2\n')])
  const r = await run(p, options)
  expect(r.result).toMatchObject({
    status: 'committed',
    incomplete: { step: 'publish' },
    recordPath: path.join(fx.opDir, 'record.json'),
  })
  const st: State = { fx, p, opId: OP_ID, opDir: fx.opDir }
  syncManifest(st)
  return { ...st, trace: r.trace }
}

/** The copy temp of the backup. */
export const copyTemp = (fx: Fixture): string => path.join(areaOf(fx), `.tmp-${OP_ID}`)

/** The backup's fixed path. */
export const backupOf = (fx: Fixture): string => path.join(areaOf(fx), OP_ID)

/** A doctor action with the fs delete spy and the trace on one timeline. */
export async function actSpied(
  st: State,
  action: 'apply' | 'undo',
  opts: RecoveryRunOptions = {}
): Promise<Acted & { events: Event[] }> {
  const events: Event[] = []
  const restore = spyFs(ALL_DELETES, events)
  try {
    const a = await act(
      st,
      action,
      {},
      {
        ...opts,
        swap: { ...opts.swap, trace: (t) => events.push(t) },
      }
    )
    return { ...a, events }
  } finally {
    restore()
  }
}

/**
 * The deletes that are not doctor's own metadata: `treeDeletes`' exemptions,
 * plus a sidecar in the area replaced by a rewrite, the park intent's temp and
 * the parked area's probes. A tree entry never appears here.
 */
export function treeDeletesDoctor(fx: Fixture, events: Event[]): FsEvent[] {
  const area = areaOf(fx)
  return treeDeletes(fx, events).filter(
    (e) =>
      !(path.dirname(e.path) === area && e.path.endsWith('.json')) &&
      e.path !== path.join(fx.opDir, 'park-intent.json.tmp')
  )
}

/** The sha256 of every regular file's bytes under `dirs`, other than Skillsmith's metadata JSON. */
export function contentSet(...dirs: string[]): Set<string> {
  const out = new Set<string>()
  const walk = (p: string): void => {
    const s = fs.lstatSync(p)
    if (s.isDirectory()) {
      for (const n of fs.readdirSync(p)) walk(path.join(p, n))
      return
    }
    if (!s.isFile() || p.endsWith('.json') || p.endsWith('.json.tmp') || p.endsWith('.jsonl'))
      return
    out.add(crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'))
  }
  for (const d of dirs) if (fs.existsSync(d)) walk(d)
  return out
}

/** Every content hash in `before` is still somewhere in `after` (a parked copy counts). */
export function nothingLost(before: Set<string>, after: Set<string>): void {
  expect(before.size).toBeGreaterThan(0)
  const lost = [...before].filter((h) => !after.has(h))
  expect(lost).toEqual([])
}

/** The one parked copy of OP, whole. */
export function theParkedCopy(fx: Fixture): string {
  const copies = parkedCopies(fx)
  expect(copies).toHaveLength(1)
  return copies[0]!
}

/** The partial-copy trees (not sidecars) in the area. */
export function partialTrees(fx: Fixture): string[] {
  const area = areaOf(fx)
  if (!fs.existsSync(area)) return []
  return fs
    .readdirSync(area)
    .filter((n) => n.startsWith(`${OP_ID}.partial-copy`) && !n.endsWith('.json'))
    .sort()
    .map((n) => path.join(area, n))
}
