/**
 * SMI-6531 (A1 step 3a): T-X18 (d) for the clock-gate helper. A tree built
 * immediately before its park must park, 300 runs each on overlayfs and
 * tmpfs, the two filesystems whose 1 ms birthtime steps make a same-tick
 * pair likely (UD25, E47). The plan's control (a threshold from probe 1 stops
 * spuriously, E51) is a red-test mutation of the gate, recorded in the commit
 * that added this file.
 *
 * Each directory's filesystem type is asserted with statfs, so the test
 * cannot pass on a different filesystem than it names. It runs where both
 * exist (Linux: the dev container and CI's Docker test job). On Linux a
 * missing filesystem fails and names what it found, so a run that cannot test
 * this (CI's bare-host fallback, another storage driver, a TMPDIR override) is
 * red, not green. The trigger is the platform, not the CI variable: CI's
 * docker run does not pass CI into the container. Only a non-Linux host (a
 * macOS checkout outside Docker) skips.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runClockGate } from '../../../src/install/park-clock-gate.js'
import { PARKED, cleanup, park } from './park-tree.helpers.js'

const OVERLAYFS_MAGIC = 0x794c7630
const TMPFS_MAGIC = 0x01021994
const RUNS = 300

const fsType = (dir: string): number | null => {
  try {
    return fs.statfsSync(dir).type
  } catch {
    return null
  }
}
const TARGETS: [string, string, number][] = [
  ['overlayfs', os.tmpdir(), OVERLAYFS_MAGIC],
  ['tmpfs', '/dev/shm', TMPFS_MAGIC],
]
const available = TARGETS.every(([, dir, magic]) => fsType(dir) === magic)

const roots: string[] = []
afterAll(() => {
  for (const r of roots.splice(0)) cleanup(r)
})

describe.runIf(!available && process.platform === 'linux')('T-X18 (d) on Linux', () => {
  it('needs overlayfs at the temp dir and tmpfs at /dev/shm', () => {
    const seen = TARGETS.map(
      ([label, dir]) => `${label} wanted at ${dir}, statfs type ${fsType(dir)}`
    )
    throw new Error(`T-X18 (d) cannot run here: ${seen.join('; ')}`)
  })
})

describe.skipIf(!available)('T-X18 (d): no spurious stop right after a build', () => {
  for (const [label, dir, magic] of TARGETS) {
    it(`${label}: ${RUNS} trees built just before the gate all park`, async () => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(dir, 'park-gate-race-')))
      roots.push(root)
      expect(fsType(root)).toBe(magic)
      const outcomes: Record<string, number> = {}
      for (let i = 0; i < RUNS; i++) {
        const parent = path.join(root, `p${i}`)
        fs.mkdirSync(path.join(parent, PARKED), { recursive: true })
        // The build: the tree is made immediately before the gate runs.
        fs.mkdirSync(path.join(parent, 'tree'))
        fs.writeFileSync(path.join(parent, 'tree', 'f.txt'), String(i))
        const g = await runClockGate({
          probeDir: path.join(parent, PARKED),
          parentAbs: parent,
          opId: `r${i}`,
        })
        let key: string
        if (g.ok) {
          const r = park(parent, 'tree', { maxBirthtimeNs: g.maxBirthtimeNs })
          key = r.status === 'parked' ? 'parked' : `${r.status}/${String(r.reason)}`
        } else {
          key = `gate:${g.detail.replace(/\/\S+/g, '<p>')}`
        }
        outcomes[key] = (outcomes[key] ?? 0) + 1
      }
      expect(outcomes).toEqual({ parked: RUNS })
    }, 60_000)
  }
})
