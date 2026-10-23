/**
 * SMI-6531 (A1 step 4c): T-F1's swap half, a full state root during the
 * cross-device publish, never deleting (UD13).
 *
 * A real disk is not filled: the container's `/dev/shm` is shared, so `ENOSPC`
 * is forced at the copy's file creates (`fs.promises.open` under the copy
 * temp), at the backup sidecar's temp, and at the parked sidecar
 * (`fs.writeFileSync`); the space check's `statfs` is stubbed to report too
 * little room. Each stub hits only its own path and records that it fired, so
 * a test that never reached it fails rather than passing on a run the stub
 * never touched.
 *
 * Doctor finishing once there is space, and its own `--apply` attempts, are
 * step 6's; these tests assert the state it reads.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SwapResult } from '../../../src/services/skill-swap.js'
import { ALL_DELETES, contentOf, runSpied } from './skill-swap.abort.helpers.js'
import {
  areaOf,
  hashOf,
  modify,
  OP_ID,
  plan,
  readRecord,
  useTmpCleanup,
} from './skill-swap.helpers.js'
import type { Fixture } from './skill-swap.helpers.js'
import {
  areaNames,
  errnoError,
  parkedCopies,
  partials,
  sidecarOf,
  treeDeletesX,
  useOtherDeviceCleanup,
  xdevFixture,
} from './skill-swap.xdev.helpers.js'

useTmpCleanup()
useOtherDeviceCleanup()

const FILES = { 'SKILL.md': '# v1\n', 'a.txt': 'a\n', 'sub/b.txt': 'b\n', 'sub/c.txt': 'c\n' }
type AnyFn = (...a: unknown[]) => unknown
const restores: Array<() => void> = []
afterEach(() => {
  for (const r of restores.splice(0).reverse()) r()
})

/** Replaces `obj[name]` with `impl(orig)` until the test ends. */
function stub(obj: object, name: string, impl: (orig: AnyFn) => AnyFn): void {
  const t = obj as Record<string, AnyFn>
  const orig = t[name]!
  t[name] = impl(orig.bind(obj) as AnyFn)
  restores.push(() => {
    t[name] = orig
  })
}

type Committed = Extract<SwapResult, { status: 'committed' }>
function committedOf(r: SwapResult): Committed {
  expect(r.status).toBe('committed')
  if (r.status !== 'committed') throw new Error('unreachable')
  return r
}

/** The update committed with the record kept, the old folder intact in OP, nothing parked. */
function assertStoppedAtPublish(fx: Fixture, pre: string, r: Committed, reason: string) {
  expect(r).toMatchObject({
    incomplete: { step: 'publish', reason },
    recordPath: path.join(fx.opDir, 'record.json'),
  })
  readRecord(path.join(fx.opDir, 'record.json'))
  expect(fs.readFileSync(path.join(fx.realDir, 'SKILL.md'), 'utf8')).toBe('# v2\n')
  expect(hashOf(path.join(fx.opDir, 'old'))).toBe(pre)
  expect(parkedCopies(fx)).toEqual([])
  expect(r.extraCopy).toBeUndefined()
}

/** `ENOSPC` from the copy's second file create under the copy temp; returns how often it fired. */
function enospcAtCopy(fx: Fixture): { fired: number } {
  const hit = { fired: 0 }
  const temp = path.join(areaOf(fx), `.tmp-${OP_ID}`)
  let creates = 0
  stub(fs.promises, 'open', (orig) => async (...a: unknown[]) => {
    if (String(a[0]).startsWith(`${temp}/`) && ++creates === 2) {
      hit.fired++
      throw errnoError('ENOSPC')
    }
    return orig(...a)
  })
  return hit
}

describe('T-F1: ENOSPC during the cross-device copy', () => {
  it('keeps the partial temp as partial-copy with sourceUnchanged: true, and stops write-failed naming the device', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const hit = enospcAtCopy(fx)
    const run = await runSpied(p, ALL_DELETES)
    expect(hit.fired).toBe(1)
    const r = committedOf(run.result)
    assertStoppedAtPublish(fx, p.input.preTree, r, 'write-failed')
    expect(r.incomplete?.detail).toMatch(/no space is left on .* \(device \d+\) \(ENOSPC at /)
    expect(r.incomplete?.detail).toContain(areaOf(fx))
    const kept = partials(areaOf(fx))
    expect(kept).toHaveLength(1)
    expect(Object.keys(contentOf(kept[0]!)).length).toBeGreaterThan(0)
    expect(sidecarOf(kept[0]!)).toMatchObject({ kind: 'partial-copy', sourceUnchanged: true })
    expect(areaNames(areaOf(fx)).filter((n) => n.startsWith('.tmp-'))).toEqual([])
    // The backup's own sidecar is published (P1/P2); dest itself does not exist.
    expect(fs.existsSync(path.join(areaOf(fx), `${OP_ID}.json`))).toBe(true)
    expect(fs.existsSync(path.join(areaOf(fx), OP_ID))).toBe(false)
    expect(treeDeletesX(fx, run.events)).toEqual([])
  })

  it('records sourceUnchanged: false when the source changed after its sidecar', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const hit = enospcAtCopy(fx)
    const run = await runSpied(p, ALL_DELETES, {
      hooks: { afterSidecar: () => fs.appendFileSync(path.join(fx.opDir, 'old', 'a.txt'), 'x\n') },
    })
    expect(hit.fired).toBe(1)
    assertStoppedAtPublish(
      fx,
      hashOf(path.join(fx.opDir, 'old')),
      committedOf(run.result),
      'write-failed'
    )
    const kept = partials(areaOf(fx))
    expect(kept).toHaveLength(1)
    expect(sidecarOf(kept[0]!)).toMatchObject({ kind: 'partial-copy', sourceUnchanged: false })
    expect(treeDeletesX(fx, run.events)).toEqual([])
  })
})

/** `statfs` of the backup area reporting `free` bytes; returns how often it was asked. */
function tooLittleSpace(fx: Fixture, free: bigint): { asked: number } {
  const hit = { asked: 0 }
  stub(fs.promises, 'statfs', (orig) => async (...a: unknown[]) => {
    const s = (await orig(...a)) as fs.BigIntStatsFs
    if (a[0] !== areaOf(fx)) return s
    hit.asked++
    return { ...s, bsize: 1n, bavail: free }
  })
  return hit
}

describe('T-F1: the space check', () => {
  it('refuses state-root-full naming doctor backups --prune, before any copy temp exists', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    // 64 bytes free: far below the tree's bytes plus 64 KiB.
    const hit = tooLittleSpace(fx, 64n)
    const run = await runSpied(p, ALL_DELETES)
    expect(hit.asked).toBe(1)
    const r = committedOf(run.result)
    assertStoppedAtPublish(fx, p.input.preTree, r, 'state-root-full')
    expect(r.incomplete?.detail).toContain('skillsmith doctor backups --prune')
    expect(areaNames(areaOf(fx))).toEqual([`${OP_ID}.json`])
    expect(treeDeletesX(fx, run.events)).toEqual([])
  })

  it('passes at exactly the tree bytes plus 64 KiB', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const bytes = BigInt(Object.values(FILES).reduce((n, t) => n + Buffer.byteLength(t), 0))
    const hit = tooLittleSpace(fx, bytes + 65536n)
    const run = await runSpied(p, ALL_DELETES)
    expect(hit.asked).toBe(1)
    expect(committedOf(run.result).incomplete).toBeUndefined()
  })

  it('one byte less refuses: the boundary is the plan margin, not a looser one', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const bytes = BigInt(Object.values(FILES).reduce((n, t) => n + Buffer.byteLength(t), 0))
    tooLittleSpace(fx, bytes + 65535n)
    const run = await runSpied(p, ALL_DELETES)
    expect(committedOf(run.result).incomplete?.reason).toBe('state-root-full')
  })

  it('no ratchet: three attempts on too little space keep the partial-copy count and the tree bytes the same', async () => {
    const fx = xdevFixture(FILES)
    tooLittleSpace(fx, 1024n)
    const counts: number[] = []
    const trees: string[][] = []
    for (const [i, version] of ['# v2\n', '# v3\n', '# v4\n'].entries()) {
      const p = plan(fx, [modify('SKILL.md', version)])
      const opId = String(i + 1).repeat(32)
      const run = await runSpied(p, ALL_DELETES, { opId })
      expect(committedOf(run.result).incomplete?.reason).toBe('state-root-full')
      counts.push(partials(areaOf(fx)).length)
      // Only sidecars are written: no tree (partial or temp) enters the area.
      trees.push(areaNames(areaOf(fx)).filter((n) => !n.endsWith('.json')))
    }
    expect(counts).toEqual([0, 0, 0])
    expect(trees).toEqual([[], [], []])
  })
})

describe('T-F1: ENOSPC at the backup sidecar', () => {
  it('stops write-failed with the record kept and the old folder in OP, nothing copied', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const tmp = path.join(areaOf(fx), `${OP_ID}.json.tmp`)
    let fired = 0
    stub(fs.promises, 'open', (orig) => async (...a: unknown[]) => {
      if (a[0] === tmp) {
        fired++
        throw errnoError('ENOSPC')
      }
      return orig(...a)
    })
    const run = await runSpied(p, ALL_DELETES)
    expect(fired).toBe(1)
    assertStoppedAtPublish(fx, p.input.preTree, committedOf(run.result), 'write-failed')
    expect(areaNames(areaOf(fx))).toEqual([])
    expect(treeDeletesX(fx, run.events)).toEqual([])
  })
})

describe('T-F1: ENOSPC at the park sidecar', () => {
  it('parked with sidecarError, the status unchanged, the tree whole in the parked area', async () => {
    const fx = xdevFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    let fired = 0
    stub(fs, 'writeFileSync', (orig) => (...a: unknown[]) => {
      const f = String(a[0])
      if (f.includes('.skillsmith-parked') && f.endsWith('.json')) {
        fired++
        throw errnoError('ENOSPC')
      }
      return orig(...a)
    })
    const run = await runSpied(p, ALL_DELETES)
    expect(fired).toBe(1)
    const r = committedOf(run.result)
    expect(r.incomplete).toBeUndefined()
    const copies = parkedCopies(fx)
    expect(copies).toHaveLength(1)
    expect(r.extraCopy).toBe(copies[0])
    expect(r.warnings).toContainEqual({
      code: 'park-metadata-failed',
      path: copies[0],
      sidecarError: 'ENOSPC',
    })
    expect(r.warnings.filter((w) => w.code === 'removal-not-done')).toEqual([])
    expect(fs.existsSync(`${copies[0]}.json`)).toBe(false)
    expect(hashOf(path.join(copies[0]!, 'old'))).toBe(p.input.preTree)
    expect(treeDeletesX(fx, run.events)).toEqual([])
  })
})
