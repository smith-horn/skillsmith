/**
 * SMI-6531 (A1 step 4c): T-X17's move-source row (UD27, UD32). A park of the op
 * dir holding a cross-device move's verified source that does not finish
 * leaves the update installed and the backup complete, and is reported as not
 * done: `removal-not-done { path, status, reason, parkedPath? }` with no
 * restore line, one stderr line, and no delete of a tree entry.
 *
 * The outcomes are forced with stubs: `kept` (the guard refuses: the park is
 * handed a hash the tree does not have, and separately an entry is added to
 * OP after the gate's hash), `held` (a file in the old folder changed right
 * after the park's rename, before its post-move check) and `stopped` (the
 * rename of OP fails `EACCES`, and separately the clock gate's probe cannot be
 * made). The exit code (4) is the CLI's mapping, later.
 *
 * In every not-done case OP stays (or, `held`, sits whole in the parked area)
 * with the source and a verifying `move-source` intent, no record and no
 * owner: the state `doctor recovery --clean-staging <opId>` finishes (step 6).
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parkTreeIndexed } from '../../../src/install/park-call.js'
import { bindIdentity } from '../../../src/install/park-tree.identity.js'
import { isParkIntentFor } from '../../../src/services/skill-swap.intent.js'
import { recordIdentity } from '../../../src/services/skill-swap.staging.js'
import type { SwapOptions, SwapResult } from '../../../src/services/skill-swap.js'
import { ALL_DELETES, runSpied } from './skill-swap.abort.helpers.js'
import { areaOf, hashOf, modify, OP_ID, plan, useTmpCleanup } from './skill-swap.helpers.js'
import type { Fixture } from './skill-swap.helpers.js'
import {
  errnoError,
  parkedCopies,
  sidecarOf,
  treeDeletesX,
  useOtherDeviceCleanup,
  xdevFixture,
} from './skill-swap.xdev.helpers.js'

useTmpCleanup()
useOtherDeviceCleanup()

const FILES = { 'SKILL.md': '# v1\n', 'a.txt': 'a\n', 'sub/b.txt': 'b\n' }
type AnyFn = (...a: unknown[]) => unknown
const table = fs as unknown as Record<string, AnyFn>
const restores: Array<() => void> = []
afterEach(() => {
  for (const r of restores.splice(0).reverse()) r()
})

function stub(name: string, impl: (orig: AnyFn) => AnyFn): void {
  const orig = table[name]!
  table[name] = impl(orig.bind(fs) as AnyFn)
  restores.push(() => {
    table[name] = orig
  })
}

interface Case {
  label: string
  status: 'kept' | 'held' | 'stopped'
  reason: string
  errno?: string
  /** Arranges the outcome; returns options for the run. */
  arrange: (fx: Fixture) => SwapOptions
}

const CASES: Case[] = [
  {
    label: 'kept: the guard refuses (a hash the tree does not have)',
    status: 'kept',
    reason: 'identity-changed',
    arrange: () => ({
      park: (parent, name, o) => parkTreeIndexed(parent, name, { ...o, guardHash: 'f'.repeat(64) }),
    }),
  },
  {
    label: "kept: an entry added to OP inside the gate, before its hash (UD40's recheck)",
    status: 'kept',
    reason: 'op-not-empty',
    arrange: (fx) => {
      const probe2 = path.join(fx.staging, `.skillsmith-probe-${OP_ID}-2`)
      stub('rmdirSync', (orig) => (...a: unknown[]) => {
        const out = orig(...a)
        if (a[0] === probe2 && !fs.existsSync(path.join(fx.opDir, 'late.txt'))) {
          fs.writeFileSync(path.join(fx.opDir, 'late.txt'), 'late\n')
        }
        return out
      })
      return {}
    },
  },
  {
    label: 'held: a file in the old folder changed right after the rename',
    status: 'held',
    reason: 'changed-during-move',
    arrange: (fx) => {
      let fd: number | null = null
      stub('renameSync', (orig) => (...a: unknown[]) => {
        const out = orig(...a)
        if (a[0] === fx.opDir && fd !== null) fs.writeSync(fd, 'through the fd\n')
        return out
      })
      restores.push(() => {
        if (fd !== null) fs.closeSync(fd)
      })
      return {
        hooks: {
          afterOwnerUnlink: () => {
            fd = fs.openSync(path.join(fx.opDir, 'old', 'a.txt'), 'a')
          },
        },
      }
    },
  },
  {
    label: 'stopped: the rename of OP fails (EACCES)',
    status: 'stopped',
    reason: 'park-failed',
    errno: 'EACCES',
    arrange: (fx) => {
      stub('renameSync', (orig) => (...a: unknown[]) => {
        if (a[0] === fx.opDir) throw errnoError('EACCES')
        return orig(...a)
      })
      return {}
    },
  },
  {
    label: "stopped: the clock gate's probe cannot be made (EACCES)",
    status: 'stopped',
    reason: 'identity-unverifiable',
    arrange: (fx) => {
      const probe = path.join(fx.staging, `.skillsmith-probe-${OP_ID}-1`)
      stub('mkdirSync', (orig) => (...a: unknown[]) => {
        if (a[0] === probe) throw errnoError('EACCES')
        return orig(...a)
      })
      return {}
    },
  },
]

type Committed = Extract<SwapResult, { status: 'committed' }>

describe("T-X17 (move-source row): a park of OP that doesn't finish", () => {
  for (const c of CASES) {
    it(`${c.label}: installed, backup complete, removal-not-done, one stderr line, no restore line`, async () => {
      const fx = xdevFixture(FILES)
      const p = plan(fx, [modify('SKILL.md', '# v2\n')])
      const lines: string[] = []
      const opts = c.arrange(fx)
      const run = await runSpied(p, ALL_DELETES, { ...opts, stderr: (l) => lines.push(l) })
      expect(run.result.status).toBe('committed')
      const r = run.result as Committed
      // The new version is installed and the backup made, complete with its sidecar.
      expect(r.incomplete).toBeUndefined()
      expect(r).not.toHaveProperty('recordPath')
      expect(r.extraCopy).toBeUndefined()
      expect(fs.readFileSync(path.join(fx.realDir, 'SKILL.md'), 'utf8')).toBe('# v2\n')
      const dest = path.join(areaOf(fx), OP_ID)
      expect(r.backupDest).toBe(dest)
      expect(hashOf(dest)).toBe(p.input.preTree)
      expect(sidecarOf(dest)).toMatchObject({ kind: 'backup', treeHash: p.input.preTree })
      // removal-not-done, naming OP, the status and reason; parkedPath only for held.
      const notDone = r.warnings.filter((w) => w.code === 'removal-not-done')
      expect(notDone).toHaveLength(1)
      const w = notDone[0]!
      expect(w).toMatchObject({ path: fx.opDir, status: c.status, reason: c.reason })
      if (c.errno !== undefined) expect(w).toMatchObject({ errno: c.errno })
      expect(JSON.stringify(r)).not.toContain('skillsmith restore')
      expect(w).not.toHaveProperty('restoreCommand')
      // Where the source is now: OP (kept, stopped) or the parked area (held).
      const copies = parkedCopies(fx)
      let where: string
      if (c.status === 'held') {
        expect(copies).toHaveLength(1)
        expect(w).toMatchObject({ parkedPath: copies[0] })
        where = copies[0]!
        expect(fs.readFileSync(path.join(where, 'old', 'a.txt'), 'utf8')).toBe(
          'a\nthrough the fd\n'
        )
      } else {
        expect(w).not.toHaveProperty('parkedPath')
        expect(copies).toEqual([])
        where = fx.opDir
        expect(hashOf(path.join(where, 'old'))).toBe(p.input.preTree)
      }
      const names = fs.readdirSync(where).sort()
      expect(names.filter((n) => n !== 'late.txt')).toEqual(['old', 'park-intent.json'])
      const intent = JSON.parse(fs.readFileSync(path.join(where, 'park-intent.json'), 'utf8'))
      const id = bindIdentity(where)
      expect(id.ok && isParkIntentFor(intent, OP_ID, recordIdentity(id))).toBe(true)
      expect(intent.kind).toBe('move-source')
      // One stderr line naming OP, the status and reason, and the next step.
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain(fx.opDir)
      expect(lines[0]).toContain(dest)
      expect(lines[0]).toContain(`${c.status}/${c.reason}`)
      expect(lines[0]).not.toContain('skillsmith restore')
      if (c.status === 'held') expect(lines[0]).toContain(String(copies[0]))
      else expect(lines[0]).toContain(`skillsmith doctor recovery --clean-staging ${OP_ID}`)
      // Nothing deleted: no unlink or rmdir of any tree entry.
      expect(treeDeletesX(fx, run.events)).toEqual([])
    })
  }
})
