/**
 * SMI-6531 (A1 step 4b): a park of OP that does not finish leaves abort
 * cleanup's tree untouched (A1 plan §3.3 abort step 7, UD32; ADR-166 D-4).
 * T-X16's swap half (spike Q7's five cases with ST as the parent), T-X13's
 * mount row and its "not done" rows.
 *
 * The dev container is root without CAP_SYS_ADMIN, so it can neither make a
 * permission error nor a mount: EROFS and EACCES are forced at the parked
 * area's `mkdir` and at the rename through the `node:fs` default object, and
 * a mount is simulated where the park looks for one (an entry's `st_dev`
 * inside OP, and OP's line in `/proc/self/mountinfo`). Case (a) is real: a
 * symlink to another filesystem (`/dev/shm`, tmpfs) at `ST/.skillsmith-parked`.
 *
 * `--clean-staging` finishing the park once the cause is gone is step 6's
 * (doctor); these tests assert the state it reads: OP with N and a verifying
 * `park-intent.json`, no record, no owner.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parkTreeIndexed } from '../../../src/install/park-call.js'
import type { ParkOptions } from '../../../src/install/park-result.js'
import type { SwapOptions } from '../../../src/services/skill-swap.js'
import {
  ALL_DELETES,
  contentOf,
  isFs,
  refusedOf,
  runSpied,
  stderrSink,
  treeDeletes,
} from './skill-swap.abort.helpers.js'
import { abortAt } from './skill-swap.abort.triggers.js'
import type { AbortKind } from './skill-swap.abort.triggers.js'
import { makeFixture, modify, OP_ID, plan, tmp, useTmpCleanup } from './skill-swap.helpers.js'
import type { Fixture } from './skill-swap.helpers.js'

useTmpCleanup()

const FILES = { 'SKILL.md': '# v1\n', 'a.txt': 'a\n', 'sub/b.txt': 'b\n' }
type AnyFn = (...a: unknown[]) => unknown
const table = fs as unknown as Record<string, AnyFn>
const PARKED = '.skillsmith-parked'

const errnoError = (code: string): NodeJS.ErrnoException => {
  const e = new Error(`${code}: forced`) as NodeJS.ErrnoException
  e.code = code
  return e
}

/** Replaces `fs[name]` with `impl(orig)` while `active()`; restore with the return. */
function stub(name: string, impl: (orig: AnyFn) => AnyFn): () => void {
  const orig = table[name]!
  table[name] = impl(orig.bind(fs) as AnyFn)
  return () => {
    table[name] = orig
  }
}

interface Case {
  label: string
  /** Set up before the run; returns the restore. `fx` is the fixture, `on()` is true from beforePark. */
  arrange: (fx: Fixture, on: () => boolean) => () => void
  status: 'stopped' | 'kept'
  reason: string
  errno?: string
  detail?: string
}

const isParkedArea = (fx: Fixture, p: unknown) => p === path.join(fx.staging, PARKED)

const CASES: Case[] = [
  {
    label: '(a) the parked area a symlink to another filesystem',
    arrange: (fx) => {
      const other = fs.existsSync('/dev/shm') ? fs.mkdtempSync('/dev/shm/step4b-') : tmp('other-')
      // ST exists before the run here (with R's bits, which the bind accepts).
      fs.mkdirSync(fx.staging)
      fs.chmodSync(fx.staging, fs.statSync(fx.skillsDir).mode & 0o7777)
      fs.symlinkSync(other, path.join(fx.staging, PARKED))
      return () => fs.rmSync(other, { recursive: true, force: true })
    },
    status: 'stopped',
    reason: 'park-failed',
    detail: 'trash-unusable',
  },
  {
    label: '(b) ST read-only, no parked area yet (EROFS, forced)',
    arrange: (fx) =>
      stub('mkdirSync', (orig) => (...a) => {
        if (isParkedArea(fx, a[0])) throw errnoError('EROFS')
        return orig(...a)
      }),
    status: 'stopped',
    reason: 'park-failed',
    errno: 'EROFS',
  },
  {
    label: '(c) ST without write permission, no parked area yet (EACCES, forced)',
    arrange: (fx) =>
      stub('mkdirSync', (orig) => (...a) => {
        if (isParkedArea(fx, a[0])) throw errnoError('EACCES')
        return orig(...a)
      }),
    status: 'stopped',
    reason: 'park-failed',
    errno: 'EACCES',
  },
  {
    label: '(d) the rename of OP out of ST fails (EACCES, forced at rename(2))',
    arrange: (fx) =>
      stub('renameSync', (orig) => (...a) => {
        if (a[0] === fx.opDir) throw errnoError('EACCES')
        return orig(...a)
      }),
    status: 'stopped',
    reason: 'park-failed',
    errno: 'EACCES',
  },
  ...(process.platform === 'linux'
    ? [
        {
          label: '(e) OP itself a mount point (its line in /proc/self/mountinfo, simulated)',
          arrange: (fx: Fixture, on: () => boolean) =>
            stub('readFileSync', (orig) => (...a) => {
              const out = orig(...a)
              if (a[0] !== '/proc/self/mountinfo' || !on()) return out
              return `${String(out)}999 1 0:999 / ${fx.opDir} rw - tmpfs tmpfs rw\n`
            }),
          status: 'kept' as const,
          reason: 'mount-inside-tree',
        },
      ]
    : []),
]

async function runCase(c: Case, kind: AbortKind) {
  const fx = makeFixture(FILES)
  const p = plan(fx, [modify('SKILL.md', '# v2\n')])
  let active = false
  const t = abortAt(fx, kind, { beforePark: () => void (active = true) })
  const sink = stderrSink()
  const restore = c.arrange(fx, () => active)
  try {
    const r = await runSpied(p, [...ALL_DELETES, 'renameSync'], {
      ...t.options,
      stderr: sink.stderr,
    })
    return { fx, built: t.built, lines: sink.lines, ...r }
  } finally {
    restore()
    t.restore()
  }
}

describe('T-X16 (swap half): a park that fails leaves the tree untouched', () => {
  for (const c of CASES) {
    for (const kind of ['step4', 'step6'] as const) {
      const rec = kind === 'step6' ? 'with a record' : 'without a record'
      it(`${c.label}, ${rec}: ${c.status}/${c.reason}, OP and N untouched, removal-not-done, one stderr line`, async () => {
        const run = await runCase(c, kind)
        const { fx } = run
        const r = refusedOf(run.result)
        expect(r).toMatchObject({
          staged: 'left',
          opDir: fx.opDir,
          cleanStagingHint: `skillsmith doctor recovery --clean-staging ${OP_ID}`,
        })
        const notDone = r.warnings.filter((w) => w.code === 'removal-not-done')
        expect(notDone).toHaveLength(1)
        expect(notDone[0]).toMatchObject({
          path: fx.opDir,
          status: c.status,
          reason: c.reason,
          ...(c.errno === undefined ? {} : { errno: c.errno }),
          ...(c.detail === undefined ? {} : { detail: c.detail }),
        })
        // OP at its origin with N byte-identical and a verifying intent; no record, no owner.
        expect(fs.readdirSync(fx.opDir).sort()).toEqual(['new', 'park-intent.json'])
        expect(contentOf(path.join(fx.opDir, 'new'))).toEqual(run.built.content)
        expect(treeDeletes(fx, run.events)).toEqual([])
        // Lock 1 released.
        expect(fs.existsSync(path.join(fx.skillsDir, '.skillsmith-writes.lock'))).toBe(false)
        // One stderr line naming OP, the status, the reason and the errno.
        expect(run.lines).toHaveLength(1)
        expect(run.lines[0]).toContain(fx.opDir)
        expect(run.lines[0]).toContain(`${c.status}/${c.reason}`)
        if (c.errno !== undefined) expect(run.lines[0]).toContain(c.errno)
        if (c.label.startsWith('(d)')) {
          // The spy confirms the rename itself ran.
          expect(
            run.events.filter((e) => isFs(e) && e.fs === 'renameSync' && e.path === fx.opDir)
          ).toHaveLength(1)
        }
      })
    }
  }

  it('control: a park that falls back to deleting on a failed rename removes N (the spy sees it)', async () => {
    const fx = makeFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const t = abortAt(fx, 'step4')
    const restore = stub('renameSync', (orig) => (...a) => {
      if (a[0] === fx.opDir) throw errnoError('EACCES')
      return orig(...a)
    })
    const deleting: SwapOptions['park'] = async (parent, name, o: ParkOptions) => {
      const r = await parkTreeIndexed(parent, name, o)
      if (r.status !== 'parked') fs.rmSync(path.join(parent, name), { recursive: true })
      return r
    }
    try {
      const run = await runSpied(p, ALL_DELETES, { ...t.options, park: deleting })
      expect(treeDeletes(fx, run.events).length).toBeGreaterThan(0)
      expect(fs.existsSync(path.join(fx.opDir, 'new'))).toBe(false)
    } finally {
      restore()
      t.restore()
    }
  })
})

describe('T-X13: a mount inside N (simulated) is refused before anything moves', () => {
  it('kept/mount-inside-tree, nothing moved, the "mounted" directory intact, staged left with --clean-staging', async () => {
    const fx = makeFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    let active = false
    const t = abortAt(fx, 'step4', { beforePark: () => void (active = true) })
    const sub = path.join(fx.opDir, 'new', 'sub')
    const restore = stub('lstatSync', (orig) => (...a) => {
      const s = orig(...a) as fs.BigIntStats
      if (!active || a[0] !== sub || typeof s.dev !== 'bigint') return s
      return Object.assign(Object.create(Object.getPrototypeOf(s) as object), s, {
        dev: s.dev + 1n,
      }) as fs.BigIntStats
    })
    try {
      const run = await runSpied(p, ALL_DELETES, t.options)
      const r = refusedOf(run.result)
      expect(r).toMatchObject({
        staged: 'left',
        cleanStagingHint: `skillsmith doctor recovery --clean-staging ${OP_ID}`,
      })
      expect(r.warnings).toContainEqual(
        expect.objectContaining({
          code: 'removal-not-done',
          status: 'kept',
          reason: 'mount-inside-tree',
        })
      )
      expect(fs.readFileSync(path.join(sub, 'b.txt'), 'utf8')).toBe('b\n')
      expect(fs.existsSync(path.join(fx.staging, PARKED, OP_ID))).toBe(false)
      expect(treeDeletes(fx, run.events)).toEqual([])
    } finally {
      restore()
      t.restore()
    }
  })
})

describe('T-X13: not done (kept, held, stopped) always carries removal-not-done', () => {
  it('kept (the guard refused): staged left, removal-not-done kept/identity-changed', async () => {
    const fx = makeFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const t = abortAt(fx, 'step4')
    const run = await runSpied(p, ALL_DELETES, {
      ...t.options,
      park: (parent, name, o) => parkTreeIndexed(parent, name, { ...o, guardHash: 'f'.repeat(64) }),
    })
    const r = refusedOf(run.result)
    expect(r.staged).toBe('left')
    expect(r.warnings).toContainEqual({
      code: 'removal-not-done',
      path: fx.opDir,
      status: 'kept',
      reason: 'identity-changed',
    })
  })

  it('stopped (the rename failed): staged left, removal-not-done stopped/park-failed with its errno', async () => {
    const c = CASES.find((x) => x.label.startsWith('(d)'))!
    const run = await runCase(c, 'step4')
    const r = refusedOf(run.result)
    expect(r.staged).toBe('left')
    expect(r.warnings).toContainEqual(
      expect.objectContaining({ code: 'removal-not-done', status: 'stopped', errno: 'EACCES' })
    )
  })
  // `held` (moved, then changed at its parked path) is in skill-swap.abort.keep.test.ts:
  // it names the parked path and no `skillsmith restore` line.
})
