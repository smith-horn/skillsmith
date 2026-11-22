/**
 * SMI-6531 (A1 step 8-i-a-1): T-X18 for uninstall, the early-bound row 3 (A1
 * plan §3.8): the clock gate runs when uninstall reads the folder, with its
 * probes in `.skillsmith-staging/`.
 *
 * (a) A substitute made after the bind, reusing the original's inode where
 * overlayfs allows, 300 runs: nothing moves and every run ends
 * `kept/identity-changed`. For an early-bound caller `expectIdentity` carries
 * the bound birthtime, which a substitute made after probe 2 cannot have, so
 * the identity comparison refuses it before the probe threshold is consulted
 * (the threshold is subsumed). The run records how many substitutes reused the
 * inode, and skips when none did (the fixture did not reproduce the reuse).
 * Control (a red-test mutation): birthtime dropped from `sameIdentity` parks
 * the inode-reusing substitute, whose content serializes identically.
 * (b) A `0n` probe birthtime stops `identity-unverifiable` before the first
 * sleep, nothing moved, no probe left, and the uninstall is not done.
 * (c) A stuck clock stops `identity-unverifiable` at the cap.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BigIntStats } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { CLOCK_GATE_CAP_MS, PROBE_PREFIX } from '../../../src/install/park-clock-gate.js'
import {
  cleanupFixture,
  entryOf,
  makeFixture,
  parkedEntries,
  stubFs,
  uninstall,
} from './uninstall-park.helpers.js'
import type { UFixture } from './uninstall-park.helpers.js'

type AnyFn = (...args: unknown[]) => unknown
const OVERLAYFS_MAGIC = 0x794c7630
const onOverlay = ((): boolean => {
  try {
    return fs.statfsSync(os.tmpdir()).type === OVERLAYFS_MAGIC
  } catch {
    return false
  }
})()

const fixtures: UFixture[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) cleanupFixture(f)
})
const fixture = (prefix: string): UFixture => {
  const f = makeFixture(prefix)
  fixtures.push(f)
  return f
}
const isProbe = (p: unknown): boolean => path.basename(String(p)).startsWith(PROBE_PREFIX)
const probesLeft = (f: UFixture): string[] =>
  fs.readdirSync(path.join(f.skillsDir, '.skillsmith-staging')).filter((n) => isProbe(n))
/** An lstat stub that gives every probe read the birthtime `at(i)` returns (i is 1-based). */
const probeBirthtimes =
  (at: (i: number) => bigint) =>
  (orig: AnyFn): AnyFn => {
    let i = 0
    return (...a: unknown[]) => {
      const st = orig(...a) as BigIntStats
      if (!isProbe(a[0]) || typeof st.birthtimeNs !== 'bigint') return st
      i += 1
      const out = Object.create(st) as BigIntStats
      Object.defineProperty(out, 'birthtimeNs', { value: at(i) })
      return out
    }
  }

describe.skipIf(!onOverlay)('T-X18 (a) row 3: a substitute made after the bind (overlayfs)', () => {
  it('300 runs: nothing moves, every run ends kept/identity-changed', async (ctx) => {
    let reused = 0
    for (let i = 0; i < 300; i++) {
      const f = makeFixture('uninstall-x18a-')
      const original = fs.lstatSync(f.installPath, { bigint: true }).ino
      const r = await uninstall(f, {
        seams: {
          afterBind: () => {
            // The same bytes, a new directory: the hash alone cannot tell them apart.
            const md = fs.readFileSync(path.join(f.installPath, 'SKILL.md'))
            const a = fs.readFileSync(path.join(f.installPath, 'sub', 'a.txt'))
            fs.rmSync(f.installPath, { recursive: true })
            fs.mkdirSync(path.join(f.installPath, 'sub'), { recursive: true })
            fs.writeFileSync(path.join(f.installPath, 'SKILL.md'), md)
            fs.writeFileSync(path.join(f.installPath, 'sub', 'a.txt'), a)
            if (fs.lstatSync(f.installPath, { bigint: true }).ino === original) reused += 1
          },
        },
      })
      expect(r.notDone, r.message).toMatchObject({ status: 'kept', reason: 'identity-changed' })
      expect(parkedEntries(f)).toEqual([])
      expect(entryOf(f)).toBeDefined()
      cleanupFixture(f)
    }
    console.log(`T-X18 (a) row 3: inode reused ${reused}/300`)
    if (reused === 0) ctx.skip()
    expect(reused).toBeGreaterThanOrEqual(1)
  })
})

describe('T-X18 (b), (c) row 3: the gate stops, and the uninstall is not done', () => {
  it('(b) a 0n probe birthtime stops identity-unverifiable before the first sleep', async () => {
    const f = fixture('uninstall-x18b-')
    const restore = stubFs(
      'lstatSync',
      probeBirthtimes(() => 0n)
    )
    let elapsed = 0
    let r: Awaited<ReturnType<typeof uninstall>>
    try {
      const t0 = performance.now()
      r = await uninstall(f)
      elapsed = performance.now() - t0
    } finally {
      restore()
    }
    expect(r.notDone).toMatchObject({ status: 'stopped', reason: 'identity-unverifiable' })
    expect(r.notDone?.detail).toContain('has no birthtime (0n)')
    // The first sleep is 1 ms after probe 2; a stop at probe 1 never reaches it.
    expect(elapsed).toBeLessThan(CLOCK_GATE_CAP_MS)
    expect(probesLeft(f)).toEqual([])
    expect(fs.existsSync(path.join(f.installPath, 'SKILL.md'))).toBe(true)
    expect(entryOf(f)).toBeDefined()
  })

  it('(c) a stuck clock stops identity-unverifiable at the cap, both probes removed', async () => {
    const f = fixture('uninstall-x18c-')
    const restore = stubFs(
      'lstatSync',
      probeBirthtimes(() => 123_456_789n)
    )
    let elapsed = 0
    let r: Awaited<ReturnType<typeof uninstall>>
    try {
      const t0 = performance.now()
      r = await uninstall(f)
      elapsed = performance.now() - t0
    } finally {
      restore()
    }
    expect(r.notDone).toMatchObject({ status: 'stopped', reason: 'identity-unverifiable' })
    expect(r.notDone?.detail).toContain(`within ${CLOCK_GATE_CAP_MS} ms`)
    expect(elapsed).toBeGreaterThanOrEqual(CLOCK_GATE_CAP_MS)
    expect(elapsed).toBeLessThan(2000)
    expect(probesLeft(f)).toEqual([])
    expect(fs.existsSync(path.join(f.installPath, 'SKILL.md'))).toBe(true)
  })
})
