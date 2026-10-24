/**
 * SMI-6531 (A1 step 4c review round 2, owner decision B): the hard rule that
 * caps full-device partial copies at one per backup area. The block and inode
 * estimate stays, as a first-attempt filter only; before any copy, an area
 * that already holds a copy a full device left (`partialCause: 'enospc'`, a
 * partial whose sidecar is missing or unreadable, or a `.tmp-` copy temp)
 * refuses `state-root-full` naming `skillsmith doctor backups --prune`. A
 * `mismatch` or `copy-failed` partial does not block.
 *
 * `ENOSPC` is forced at the copy's file creates (`fs.promises.open`), and for
 * the ratchet a whole device is simulated (`statfs` deliberately reports
 * plenty, so the estimate passes; a create that would not fit fails
 * `ENOSPC`). Each stub records that it fired.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SwapOptions, SwapResult } from '../../../src/services/skill-swap.js'
import { ALL_DELETES, deletesOf, runSpied } from './skill-swap.abort.helpers.js'
import { areaOf, modify, OP_ID, plan, useTmpCleanup } from './skill-swap.helpers.js'
import type { Fixture } from './skill-swap.helpers.js'
import {
  areaNames,
  errnoError,
  partials,
  sidecarOf,
  useOtherDeviceCleanup,
  xdevFixture,
} from './skill-swap.xdev.helpers.js'

useTmpCleanup()
useOtherDeviceCleanup()

const FILES = { 'SKILL.md': '# v1\n', 'a.txt': 'a\n', 'sub/b.txt': 'b\n', 'sub/c.txt': 'c\n' }
const BLOCK = 4096n
type AnyFn = (...a: unknown[]) => unknown
const restores: Array<() => void> = []
afterEach(() => {
  for (const r of restores.splice(0).reverse()) r()
})

function stub(obj: object, name: string, impl: (orig: AnyFn) => AnyFn): () => void {
  const t = obj as Record<string, AnyFn>
  const orig = t[name]!
  t[name] = impl(orig.bind(obj) as AnyFn)
  const restore = () => {
    t[name] = orig
  }
  restores.push(restore)
  return restore
}

type Committed = Extract<SwapResult, { status: 'committed' }>
function committedOf(r: SwapResult): Committed {
  expect(r.status).toBe('committed')
  if (r.status !== 'committed') throw new Error('unreachable')
  return r
}

/** Counts `statfs` calls on the area (the estimate's), passing the real result through. */
function countStatfs(fx: Fixture): { asked: number } {
  const hit = { asked: 0 }
  stub(fs.promises, 'statfs', (orig) => async (...a: unknown[]) => {
    if (a[0] === areaOf(fx)) hit.asked++
    return orig(...a)
  })
  return hit
}

/** `ENOSPC` at the second file create under one opId's copy temp; returns the restore. */
function enospcAtCopy(fx: Fixture, opId: string): { fired: number; restore: () => void } {
  const hit = { fired: 0, restore: () => undefined as void }
  const temp = path.join(areaOf(fx), `.tmp-${opId}`)
  let creates = 0
  hit.restore = stub(fs.promises, 'open', (orig) => async (...a: unknown[]) => {
    if (String(a[0]).startsWith(`${temp}/`) && ++creates === 2) {
      hit.fired++
      throw errnoError('ENOSPC')
    }
    return orig(...a)
  })
  return hit
}

const OP2 = 'b'.repeat(32)
const OP3 = 'c'.repeat(32)
const unfinished = (fx: Fixture) =>
  areaNames(areaOf(fx)).filter(
    (n) => (n.startsWith('.tmp-') || n.includes('.partial-copy')) && !n.endsWith('.json')
  )

async function attempt(fx: Fixture, version: string, opId: string, extra: SwapOptions = {}) {
  const p = plan(fx, [modify('SKILL.md', version)])
  return runSpied(p, ALL_DELETES, { opId, ...extra })
}

describe('the hard rule: at most one full-device copy per area', () => {
  it('the estimate passes but the copy hits ENOSPC; the next update refuses state-root-full before any copy', async () => {
    const fx = xdevFixture(FILES)
    const enospc = enospcAtCopy(fx, OP_ID)
    const first = await attempt(fx, '# v2\n', OP_ID)
    enospc.restore()
    expect(enospc.fired).toBe(1)
    expect(committedOf(first.result).incomplete?.reason).toBe('write-failed')
    const kept = partials(areaOf(fx))
    expect(kept).toHaveLength(1)
    expect(sidecarOf(kept[0]!)).toMatchObject({ kind: 'partial-copy', partialCause: 'enospc' })

    const statfs = countStatfs(fx)
    const second = await attempt(fx, '# v3\n', OP2)
    const r = committedOf(second.result)
    expect(r.incomplete?.reason).toBe('state-root-full')
    expect(r.incomplete?.detail).toContain('skillsmith doctor backups --prune')
    expect(r.incomplete?.detail).toContain(kept[0]!)
    // Refused before the estimate and before any copy: no statfs, no new temp, no new partial.
    expect(statfs.asked).toBe(0)
    expect(unfinished(fx)).toEqual([path.basename(kept[0]!)])
    // Nothing in the area deleted (only this run's own sidecar temp, as metadata).
    const areaDeletes = deletesOf(second.events).filter(
      (e) => e.path.startsWith(`${areaOf(fx)}/`) && !e.path.endsWith('.json.tmp')
    )
    expect(areaDeletes).toEqual([])
    expect(deletesOf(second.events).length).toBeGreaterThan(0)
  })

  it('a mismatch partial does not block: the next update copies and commits', async () => {
    const fx = xdevFixture(FILES)
    let n = 0
    const first = await attempt(fx, '# v2\n', OP_ID, {
      hooks: {
        afterBackupCopy: () => {
          if (n++ === 0) fs.appendFileSync(path.join(fx.opDir, 'old', 'a.txt'), 'late\n')
        },
      },
    })
    expect(committedOf(first.result).incomplete).toBeUndefined()
    const kept = partials(areaOf(fx))
    expect(kept).toHaveLength(1)
    expect(sidecarOf(kept[0]!)).toMatchObject({ partialCause: 'mismatch' })
    const second = await attempt(fx, '# v3\n', OP2)
    expect(committedOf(second.result).incomplete).toBeUndefined()
  })

  it('once the full-device partial is gone (pruned), the next update copies', async () => {
    const fx = xdevFixture(FILES)
    const enospc = enospcAtCopy(fx, OP_ID)
    await attempt(fx, '# v2\n', OP_ID)
    enospc.restore()
    const kept = partials(areaOf(fx))
    expect(kept).toHaveLength(1)
    // The prune (step 6's `doctor backups --prune --apply`), done here by hand.
    fs.rmSync(kept[0]!, { recursive: true })
    fs.rmSync(`${kept[0]!}.json`)
    const next = await attempt(fx, '# v3\n', OP2)
    expect(committedOf(next.result).incomplete).toBeUndefined()
  })

  const PLANTED: Array<[string, (area: string) => void, boolean]> = [
    [
      'a partial without a sidecar (counted as ENOSPC)',
      (a) => fs.mkdirSync(path.join(a, `${OP3}.partial-copy`)),
      true,
    ],
    [
      'a partial whose sidecar is unreadable (counted as ENOSPC)',
      (a) => {
        fs.mkdirSync(path.join(a, `${OP3}.partial-copy`))
        fs.writeFileSync(path.join(a, `${OP3}.partial-copy.json`), '{not json')
      },
      true,
    ],
    [
      'a partial whose sidecar names no cause (counted as ENOSPC)',
      (a) => {
        fs.mkdirSync(path.join(a, `${OP3}.partial-copy`))
        fs.writeFileSync(path.join(a, `${OP3}.partial-copy.json`), '{"kind":"partial-copy"}')
      },
      true,
    ],
    ['a leftover .tmp- copy temp', (a) => fs.mkdirSync(path.join(a, `.tmp-${OP3}`)), true],
    [
      'a copy-failed partial (not space)',
      (a) => {
        fs.mkdirSync(path.join(a, `${OP3}.partial-copy`))
        fs.writeFileSync(
          path.join(a, `${OP3}.partial-copy.json`),
          '{"kind":"partial-copy","partialCause":"copy-failed"}'
        )
      },
      false,
    ],
  ]
  for (const [label, plant, blocks] of PLANTED) {
    it(`${label}: ${blocks ? 'refuses state-root-full' : 'does not block'}`, async () => {
      const fx = xdevFixture(FILES)
      fs.mkdirSync(areaOf(fx), { recursive: true })
      plant(areaOf(fx))
      const run = await attempt(fx, '# v2\n', OP_ID)
      const r = committedOf(run.result)
      if (blocks) {
        expect(r.incomplete?.reason).toBe('state-root-full')
        expect(areaNames(areaOf(fx)).filter((n) => n === `.tmp-${OP_ID}`)).toEqual([])
      } else expect(r.incomplete).toBeUndefined()
    })
  }
})

/**
 * A device of `size` bytes under the area, with `statfs` deliberately
 * reporting plenty (the estimate always passes): a file create inside a copy
 * temp that would not fit (each file and directory a block) fails `ENOSPC`.
 * Metadata (sidecars) always fits, so each attempt's own stop is the copy's
 * or the hard rule's, never a sidecar's.
 */
function wrongEstimateDevice(fx: Fixture, size: bigint): void {
  const area = areaOf(fx)
  const used = (): bigint => {
    let n = 0n
    const walk = (p: string): void => {
      for (const name of fs.readdirSync(p)) {
        const c = path.join(p, name)
        const s = fs.lstatSync(c)
        const b = (BigInt(s.size) + BLOCK - 1n) / BLOCK
        n += s.isDirectory() ? BLOCK : (b > 0n ? b : 1n) * BLOCK
        if (s.isDirectory()) walk(c)
      }
    }
    if (fs.existsSync(area)) walk(area)
    return n
  }
  stub(fs.promises, 'statfs', (orig) => async (...a: unknown[]) => {
    const s = (await orig(...a)) as fs.BigIntStatsFs
    if (a[0] !== area) return s
    return { ...s, bsize: BLOCK, bavail: 1_000_000n, files: 1_000_000n, ffree: 1_000_000n }
  })
  stub(fs.promises, 'open', (orig) => async (...a: unknown[]) => {
    const creates = (Number(a[1]) & fs.constants.O_CREAT) !== 0
    if (creates && String(a[0]).startsWith(`${area}/.tmp-`) && used() + BLOCK > size) {
      throw errnoError('ENOSPC')
    }
    return orig(...a)
  })
}

describe('no ratchet with a wrong estimate', () => {
  it('the estimate passes every time; one full-device copy is left, then each attempt refuses', async () => {
    const files: Record<string, string> = { 'SKILL.md': '# v1\n' }
    for (let i = 0; i < 24; i++) files[`d${i % 3}/f${i}.txt`] = `file ${i}\n`
    const fx = xdevFixture(files)
    wrongEstimateDevice(fx, 12n * BLOCK)
    const counts: number[] = []
    const reasons: Array<string | undefined> = []
    for (const [i, version] of ['# v2\n', '# v3\n', '# v4\n'].entries()) {
      const run = await attempt(fx, version, String(i + 1).repeat(32))
      reasons.push(committedOf(run.result).incomplete?.reason)
      counts.push(unfinished(fx).length)
    }
    expect(reasons).toEqual(['write-failed', 'state-root-full', 'state-root-full'])
    expect(counts).toEqual([1, 1, 1])
  })
})
