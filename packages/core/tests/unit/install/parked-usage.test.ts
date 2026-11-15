/**
 * SMI-6531 (A1 step 6c-ii-a): the space warning (UD66) and the size walk it
 * counts with. Rows: W1 (the four threshold cases, and allocated bytes rather
 * than apparent), T-PW1's SMI-7127 half (an unmeasured entry below the
 * threshold still prints), "set-aside folders" and never "trash", one total per
 * volume with hard links counted once, and the old MCP store counting like any
 * other entry (D7).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { evaluateParkedUsage } from '../../../src/install/parked-usage.js'
import type { ParkedUsageEntry } from '../../../src/install/parked-usage.js'
import { measure } from '../../../src/install/prune.measure.js'
import { tmpRoot } from './prune.list.helpers.js'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})
const root = (): string => {
  const r = tmpRoot('parked-usage-')
  roots.push(r)
  return r
}

const MB = 1e6
/** An entry of `bytes` allocated bytes, as one inode, sitting in `storeDir`. */
const entry = (
  storeDir: string,
  bytes: number,
  over: Partial<ParkedUsageEntry> = {}
): ParkedUsageEntry => ({
  path: path.join(storeDir, `e-${bytes}`),
  storeDir,
  units: new Map([[`1:${bytes}`, bytes]]),
  unmeasured: 0,
  originPath: null,
  opId: `op-${bytes}`,
  ...over,
})
const free = (bytes: number) => () => ({ bavail: bytes, bsize: 1 })

describe('W1: the threshold is min(1 GB, 5% of free space)', () => {
  const cases: [string, number, number, boolean][] = [
    // [label, free bytes, held bytes, warns]
    ['plenty of space, held under the 1 GB cap', 100e9, 0.9e9, false],
    ['plenty of space, held over the 1 GB cap', 100e9, 1.1e9, true],
    ['little space, held over 5% of it but far under the cap', 100 * MB, 6 * MB, true],
    ['little space, held under 5% of it', 100 * MB, 4 * MB, false],
  ]
  for (const [label, freeBytes, held, warns] of cases) {
    it(`${label}: ${warns ? 'warns' : 'is silent'}`, () => {
      const dir = root()
      const w = evaluateParkedUsage([entry(dir, held)], { statfs: free(freeBytes) })
      expect(w.warn).toBe(warns)
      expect(w.message === null).toBe(!warns)
      expect(w.perVolume[0]?.thresholdBytes).toBe(Math.min(1e9, 0.05 * freeBytes))
    })
  }
})

describe('W1: the size is allocated bytes, not apparent', () => {
  /** A sparse file: 20 MB apparent, almost nothing allocated. */
  function sparse(dir: string): string {
    const p = path.join(dir, 'sparse.bin')
    const fd = fs.openSync(p, 'w')
    fs.ftruncateSync(fd, 20 * MB)
    fs.closeSync(fd)
    const st = fs.lstatSync(p)
    // The fixture must be sparse here, or the test discriminates nothing.
    expect(st.blocks * 512).toBeLessThan(st.size / 10)
    return p
  }

  it('measure() sums st_blocks * 512, and keeps the apparent size beside it', () => {
    const dir = root()
    sparse(dir)
    const tree = path.join(dir, 'tree')
    fs.mkdirSync(tree)
    fs.writeFileSync(path.join(tree, 'tiny'), 'x')
    const st = fs.lstatSync(path.join(tree, 'tiny'))
    const dst = fs.lstatSync(tree)
    const m = measure(tree)
    expect(m.allocatedBytes).toBe(st.blocks * 512 + dst.blocks * 512)
    expect(m.apparentBytes).toBe(st.size + dst.size)
    const s = measure(dir)
    expect(s.apparentBytes).toBeGreaterThanOrEqual(20 * MB)
    expect(s.allocatedBytes).toBeLessThan(2 * MB)
  })

  it('a 20 MB-apparent, near-zero-allocated tree does not trip a 5 MB threshold', () => {
    const dir = root()
    sparse(dir)
    const m = measure(dir)
    const w = evaluateParkedUsage(
      [entry(dir, 0, { units: m.units, unmeasured: m.unmeasured })],
      // free = 100 MB: the threshold is 5 MB. Apparent bytes would warn; allocated do not.
      { statfs: free(100 * MB) }
    )
    expect(w.perVolume[0]?.heldBytes).toBe(m.allocatedBytes)
    expect(w.warn).toBe(false)
  })
})

describe('measure()', () => {
  it('counts a hard link once and never follows a symlink', () => {
    const dir = root()
    const outside = path.join(dir, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'big'), Buffer.alloc(1 * MB, 1))
    const tree = path.join(dir, 'tree')
    fs.mkdirSync(tree)
    fs.writeFileSync(path.join(tree, 'a'), Buffer.alloc(100_000, 1))
    fs.linkSync(path.join(tree, 'a'), path.join(tree, 'b'))
    fs.symlinkSync(outside, path.join(tree, 'out-link'))
    const m = measure(tree)
    const one = fs.lstatSync(path.join(tree, 'a')).blocks * 512
    const link = fs.lstatSync(path.join(tree, 'out-link')).blocks * 512
    const root0 = fs.lstatSync(tree).blocks * 512
    expect(m.allocatedBytes).toBe(root0 + one + link)
    expect(m.unmeasured).toBe(0)
  })

  it('an entry that cannot be read is counted unmeasured, never treated as empty, and never throws', () => {
    expect(measure(path.join(root(), 'gone'))).toMatchObject({
      allocatedBytes: 0,
      unmeasured: 1,
    })
  })
})

describe('SMI-7127: an entry that could not be measured always prints', () => {
  it('T-PW1: one unmeasured entry far below the threshold still prints, naming it', () => {
    const dir = root()
    const w = evaluateParkedUsage([entry(dir, 1000, { unmeasured: 1 })], { statfs: free(100e9) })
    expect(w.perVolume[0]?.overThreshold).toBe(false)
    expect(w.warn).toBe(true)
    expect(w.message).toContain('1 entry could not be measured')
    expect(w.message).toContain('at least')
  })

  it('says "N entries" for more than one, and sums them across entries on the volume', () => {
    const dir = root()
    const w = evaluateParkedUsage(
      [entry(dir, 10, { unmeasured: 2 }), entry(dir, 20, { unmeasured: 1 })],
      { statfs: free(100e9) }
    )
    expect(w.message).toContain('3 entries could not be measured')
  })

  it('nothing unmeasured and under the threshold prints nothing', () => {
    const dir = root()
    expect(evaluateParkedUsage([entry(dir, 10)], { statfs: free(100e9) }).message).toBeNull()
  })
})

describe('the message', () => {
  it('says set-aside folders, names the largest copies by origin, and never says trash', () => {
    const dir = root()
    const w = evaluateParkedUsage(
      [
        entry(dir, 5 * MB, { originPath: '/home/u/.claude/skills/big-skill' }),
        entry(dir, 2 * MB),
        entry(dir, 1 * MB),
        entry(dir, 0.5 * MB),
      ],
      { statfs: free(100 * MB), top: 3 }
    )
    const msg = w.message as string
    expect(msg).toContain("Skillsmith's set-aside folders on this disk hold")
    expect(msg).toContain('big-skill 5.0 MB')
    expect(msg).toContain('op-2000000 2.0 MB')
    expect(msg).not.toContain('op-500000')
    expect(msg.toLowerCase()).not.toContain('trash')
    expect(msg).toContain('Nothing is deleted automatically')
  })

  it('names only a command that exists in this release: `doctor backups`, not `--prune`', () => {
    // 6c-ii-a ships the listing; `--prune` arrives in 6c-ii-b and deletion in 6c-iii.
    // A release carrying only 6c-ii-a must not tell the user to run a flag it lacks.
    const dir = root()
    // 8 MB held against a 5 MB threshold (5% of 100 MB free): the warning must fire.
    const w = evaluateParkedUsage([entry(dir, 8 * MB)], { statfs: free(100 * MB) })
    expect(w.warn).toBe(true)
    const msg = w.message as string
    expect(msg).toContain('`skillsmith doctor backups`')
    expect(msg).not.toContain('--prune')
    expect(msg).not.toMatch(/delete with/i)
  })
})

describe('volumes', () => {
  it('a hard link shared by two entries on one volume is counted once', () => {
    const dir = root()
    const shared = new Map([['9:7', 4096]])
    const w = evaluateParkedUsage(
      [
        entry(dir, 0, { units: new Map([...shared, ['9:8', 4096]]) }),
        entry(dir, 0, { units: shared }),
      ],
      { statfs: free(100e9) }
    )
    expect(w.perVolume[0]?.heldBytes).toBe(8192)
  })

  it('entries on another device are their own volume, each with its own free space', () => {
    const shm = '/dev/shm'
    const here = root()
    expect(fs.existsSync(shm)).toBe(true)
    // The fixture must really span two devices, or this tests nothing.
    expect(fs.lstatSync(shm).dev).not.toBe(fs.lstatSync(os.tmpdir()).dev)
    const seen: string[] = []
    const w = evaluateParkedUsage([entry(here, 3 * MB), entry(shm, 3 * MB)], {
      statfs: (d) => {
        seen.push(d)
        return { bavail: d === shm ? 20 * MB : 100e9, bsize: 1 }
      },
    })
    expect(w.perVolume).toHaveLength(2)
    expect(seen.sort()).toEqual([here, shm].sort())
    // 5% of 20 MB is 1 MB, so only the small volume warns.
    expect(w.perVolume.find((v) => v.storeDir === shm)?.warn).toBe(true)
    expect(w.perVolume.find((v) => v.storeDir === here)?.warn).toBe(false)
  })

  it('D7: the old MCP store counts like any other entry', () => {
    const dir = root()
    const old = path.join(dir, '.backups')
    fs.mkdirSync(old)
    const w = evaluateParkedUsage(
      [entry(dir, 3 * MB, { path: old, originPath: null, opId: '.backups' })],
      { statfs: free(100 * MB) }
    )
    expect(w.warn).toBe(false)
    const over = evaluateParkedUsage(
      [
        entry(dir, 3 * MB),
        entry(dir, 3 * MB, {
          path: old,
          opId: '.backups',
          units: new Map([['1:old-store', 3 * MB]]),
        }),
      ],
      { statfs: free(100 * MB) }
    )
    expect(over.warn).toBe(true)
    expect(over.message).toContain(old)
  })

  it('a statfs that fails keeps the cap as the threshold, and the volume warns whatever it holds', () => {
    const dir = root()
    const w = evaluateParkedUsage([entry(dir, 2e9)], {
      statfs: () => {
        throw new Error('EIO')
      },
    })
    expect(w.perVolume[0]).toMatchObject({ freeBytes: null, thresholdBytes: 1e9, warn: true })
  })

  for (const [label, result] of [
    ['NaN fields', { bavail: NaN, bsize: 4096 }],
    ['undefined fields', { bavail: undefined, bsize: undefined }],
    ['a negative field', { bavail: -5, bsize: 4096 }],
  ] as const) {
    it(`a statfs returning ${label} is unreadable free space, not a silent volume`, () => {
      const dir = root()
      // One byte held: only an unreadable free-space value makes this volume warn.
      const w = evaluateParkedUsage([entry(dir, 1)], {
        statfs: () => result as unknown as { bavail: number; bsize: number },
      })
      expect(w.perVolume[0]).toMatchObject({ freeBytes: null, thresholdBytes: 1e9, warn: true })
      expect(w.message).toContain('could not be read')
    })
  }
})
