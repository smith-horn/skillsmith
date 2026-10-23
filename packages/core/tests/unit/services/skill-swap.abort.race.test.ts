/**
 * SMI-6531 (A1 step 4b, review round 1): what abort cleanup does when OP or N
 * is not what it left, and the branches round 1 found untested.
 *
 *  - A foreign entry in OP: before cleanup, during the intent write, on the
 *    keep path after the owner unlink, between the gate's hash and the park,
 *    and after the last entry check (the park's own guard catches that one).
 *  - The clock gate stopping, OP's identity changing during the gate, a park
 *    reporting a sidecar or index error, N not a directory or unreadable, a
 *    failure after a keep's rename, and a `new/` that is not a directory when
 *    the build's mkdir is bound.
 */
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parkTreeIndexed } from '../../../src/install/park-call.js'
import type { ParkOptions } from '../../../src/install/park-result.js'
import { S_IFMT, S_IFREG } from '../../../src/install/park-tree.perms.js'
import type { SwapOptions } from '../../../src/services/skill-swap.js'
import {
  ALL_DELETES,
  parkedCopy,
  parkedOpArea,
  refusedOf,
  runSpied,
  stderrSink,
  treeDeletes,
} from './skill-swap.abort.helpers.js'
import { abortAt } from './skill-swap.abort.triggers.js'
import type { AbortKind } from './skill-swap.abort.triggers.js'
import { areaOf, makeFixture, modify, OP_ID, plan, useTmpCleanup } from './skill-swap.helpers.js'
import type { Fixture } from './skill-swap.helpers.js'

useTmpCleanup()

const FILES = { 'SKILL.md': '# v1\n', 'a.txt': 'a\n', 'sub/b.txt': 'b\n' }
type AnyFn = (...a: unknown[]) => unknown
type Hooks = NonNullable<SwapOptions['hooks']>
const table = fs as unknown as Record<string, AnyFn>
const N = (fx: Fixture) => path.join(fx.opDir, 'new')
const FOREIGN = 'foreign.txt'
const plant = (fx: Fixture) => fs.writeFileSync(path.join(fx.opDir, FOREIGN), 'user bytes\n')

/** Replaces `fs[name]` with `impl(orig)`; returns the restore. */
function stub(name: string, impl: (orig: AnyFn) => AnyFn): () => void {
  const orig = table[name]!
  table[name] = impl(orig.bind(fs) as AnyFn)
  return () => {
    table[name] = orig
  }
}

const cloneStat = (s: fs.BigIntStats, patch: Partial<Record<string, bigint>>) =>
  Object.assign(Object.create(Object.getPrototypeOf(s) as object), s, patch) as fs.BigIntStats

/**
 * Runs an abort of `kind` ('build' is a step-1 failure). `setup(fx)` returns
 * extra hooks, extra options and a restore for any stub it installed.
 */
async function abortRun(
  kind: AbortKind | 'build',
  setup: (fx: Fixture) => { hooks?: Hooks; extra?: SwapOptions; restore?: () => void } = () => ({})
) {
  const fx = makeFixture(FILES)
  const p = plan(fx, [modify('SKILL.md', '# v2\n')])
  const sink = stderrSink()
  const s = setup(fx)
  const hooks: Hooks = { ...s.hooks }
  if (kind === 'build') {
    hooks.afterCopy = () => {
      throw new Error('forced build failure')
    }
  }
  const t = kind === 'build' ? null : abortAt(fx, kind, hooks)
  try {
    const r = await runSpied(p, [...ALL_DELETES, 'renameSync', 'mkdirSync'], {
      ...(t === null ? { hooks } : t.options),
      stderr: sink.stderr,
      ...s.extra,
    })
    return { fx, p, lines: sink.lines, built: t?.built ?? null, ...r }
  } finally {
    s.restore?.()
    t?.restore()
  }
}

const notDone = (fx: Fixture, status: string, reason: string) =>
  expect.objectContaining({ code: 'removal-not-done', path: fx.opDir, status, reason })

describe('item 1: a foreign entry in OP is never parked or published with it', () => {
  for (const kind of ['step4', 'step6'] as const) {
    it(`there before cleanup (abort at ${kind}): nothing unlinked, kept or parked; left`, async () => {
      const run = await abortRun(kind, (fx) => ({ hooks: { afterBuild: () => plant(fx) } }))
      const { fx } = run
      const r = refusedOf(run.result)
      expect(r).toMatchObject({ staged: 'left', opDir: fx.opDir })
      expect(r.keptAs).toBeUndefined()
      expect(r.warnings).toContainEqual(notDone(fx, 'kept', 'op-not-empty'))
      const want = [
        'foreign.txt',
        'new',
        'owner.json',
        ...(kind === 'step6' ? ['record.json'] : []),
      ]
      expect(fs.readdirSync(fx.opDir).sort()).toEqual(want)
      // No unlink at all once cleanup holds lock 1 (the temps before it are steps 1 and 5's own).
      const start = run.events.findIndex((e) => 'op' in e && e.op === 'abort-lock')
      expect(start).toBeGreaterThan(-1)
      expect(
        run.events.slice(start).filter((e) => ('op' in e ? e.op === 'unlink' : /unlink/.test(e.fs)))
      ).toEqual([])
      expect(fs.existsSync(parkedOpArea(fx))).toBe(false)
      expect(fs.existsSync(areaOf(fx))).toBe(false)
      expect(run.lines).toHaveLength(1)
    })
  }

  it('there before cleanup, with N edited (keep path): N is not published first', async () => {
    const run = await abortRun('step4', (fx) => ({
      hooks: {
        afterBuild: () => {
          fs.appendFileSync(path.join(N(fx), 'a.txt'), 'edit\n')
          plant(fx)
        },
      },
    }))
    const r = refusedOf(run.result)
    expect(r.staged).toBe('left')
    expect(r.keptAs).toBeUndefined()
    expect(fs.existsSync(areaOf(run.fx))).toBe(false)
    expect(fs.readFileSync(path.join(N(run.fx), 'a.txt'), 'utf8')).toBe('a\nedit\n')
  })

  it('arriving during the intent write: it stays at its origin, nothing parked, left', async () => {
    const run = await abortRun('step4', (fx) => ({ hooks: { afterIntentTemp: () => plant(fx) } }))
    const { fx } = run
    const r = refusedOf(run.result)
    expect(r).toMatchObject({ staged: 'left', opDir: fx.opDir })
    expect(r.warnings).toContainEqual(notDone(fx, 'kept', 'op-not-empty'))
    expect(fs.readFileSync(path.join(fx.opDir, FOREIGN), 'utf8')).toBe('user bytes\n')
    expect(fs.readdirSync(fx.opDir).sort()).toEqual([FOREIGN, 'new', 'park-intent.json'])
    expect(fs.existsSync(parkedOpArea(fx))).toBe(false)
    expect(treeDeletes(fx, run.events)).toEqual([])
    // Caught before the gate: no probe was made, so nothing was hashed with it inside.
    const probes = run.events.filter(
      (e) => 'fs' in e && e.fs === 'mkdirSync' && e.path.includes('.skillsmith-probe-')
    )
    expect(probes).toEqual([])
  })

  it('arriving after the owner unlink on the keep path (failed build): left kept/op-not-empty, never parked', async () => {
    const run = await abortRun('build', (fx) => ({ hooks: { afterOwnerUnlink: () => plant(fx) } }))
    const { fx } = run
    const r = refusedOf(run.result)
    expect(r).toMatchObject({
      staged: 'left',
      keptAs: { kind: 'failed-build', path: path.join(areaOf(fx), `${OP_ID}.failed-build`) },
    })
    expect(r.warnings).toContainEqual(notDone(fx, 'kept', 'op-not-empty'))
    expect(fs.readdirSync(fx.opDir)).toEqual([FOREIGN])
    expect(fs.existsSync(parkedOpArea(fx))).toBe(false)
  })

  it("arriving after the gate's hash, before the park: caught by the entry check, op-not-empty", async () => {
    let armed = true
    const run = await abortRun('step4', (fx) => ({
      restore: stub('readdirSync', (orig) => (...a) => {
        const out = orig(...a)
        // The gate's hash walk reads OP once, after the probes: plant right after it.
        if (armed && a[0] === fx.opDir) {
          armed = false
          plant(fx)
        }
        return out
      }),
    }))
    const { fx } = run
    expect(armed).toBe(false)
    const r = refusedOf(run.result)
    expect(r.staged).toBe('left')
    expect(r.warnings).toContainEqual(notDone(fx, 'kept', 'op-not-empty'))
    expect(fs.readFileSync(path.join(fx.opDir, FOREIGN), 'utf8')).toBe('user bytes\n')
    expect(run.trace.some((t) => t.op === 'park')).toBe(false)
  })

  it("arriving after the last entry check: the park's own guard refuses it (kept/identity-changed)", async () => {
    const run = await abortRun('step4', (fx) => ({ hooks: { beforePark: () => plant(fx) } }))
    const { fx } = run
    const r = refusedOf(run.result)
    expect(r.staged).toBe('left')
    expect(r.warnings).toContainEqual(notDone(fx, 'kept', 'identity-changed'))
    expect(fs.readFileSync(path.join(fx.opDir, FOREIGN), 'utf8')).toBe('user bytes\n')
  })
})

describe('item 2: the untested branches', () => {
  it('the clock gate stops (probe 2 has a 0n birthtime): left, stopped/identity-unverifiable', async () => {
    const run = await abortRun('step4', (fx) => ({
      restore: stub('lstatSync', (orig) => (...a) => {
        const s = orig(...a) as fs.BigIntStats
        const probe2 = path.join(fx.staging, `.skillsmith-probe-${OP_ID}-2`)
        return a[0] === probe2 && typeof s.birthtimeNs === 'bigint'
          ? cloneStat(s, { birthtimeNs: 0n })
          : s
      }),
    }))
    const r = refusedOf(run.result)
    expect(r.staged).toBe('left')
    expect(r.warnings).toContainEqual(notDone(run.fx, 'stopped', 'identity-unverifiable'))
    expect(fs.readdirSync(run.fx.opDir).sort()).toEqual(['new', 'park-intent.json'])
  })

  it('OP replaced by a copy during the gate: left, kept/identity-changed, nothing parked', async () => {
    let swapped = false
    const run = await abortRun('step4', (fx) => ({
      restore: stub('mkdirSync', (orig) => (...a) => {
        if (!swapped && a[0] === path.join(fx.staging, `.skillsmith-probe-${OP_ID}-1`)) {
          swapped = true
          const copy = path.join(fx.base, 'op-copy')
          fs.cpSync(fx.opDir, copy, { recursive: true, verbatimSymlinks: true })
          fs.renameSync(fx.opDir, path.join(fx.base, 'op-orig'))
          fs.renameSync(copy, fx.opDir)
        }
        return orig(...a)
      }),
    }))
    expect(swapped).toBe(true)
    const r = refusedOf(run.result)
    expect(r.staged).toBe('left')
    expect(r.warnings).toContainEqual(notDone(run.fx, 'kept', 'identity-changed'))
    expect(fs.existsSync(parkedOpArea(run.fx))).toBe(false)
  })

  for (const field of ['sidecarError', 'indexError'] as const) {
    it(`a parked result with ${field}: park-metadata-failed, the status stays parked`, async () => {
      const run = await abortRun('step4', () => ({
        extra: {
          park: async (parent: string, name: string, o: ParkOptions) => ({
            ...(await parkTreeIndexed(parent, name, o)),
            [field]: 'ENOSPC',
          }),
        },
      }))
      const r = refusedOf(run.result)
      const copy = parkedCopy(run.fx)
      expect(r).toMatchObject({ staged: 'parked', parkedPath: copy })
      expect(r.warnings).toContainEqual({
        code: 'park-metadata-failed',
        path: copy,
        [field]: 'ENOSPC',
      })
      expect(r.warnings.filter((w) => w.code === 'removal-not-done')).toEqual([])
    })
  }

  it('N not a directory: left, kept/identity-changed naming it', async () => {
    const run = await abortRun('step4', (fx) => ({
      hooks: {
        afterBuild: () => {
          fs.renameSync(N(fx), path.join(fx.base, 'new-aside'))
          fs.writeFileSync(N(fx), 'a file now\n')
        },
      },
    }))
    const r = refusedOf(run.result)
    expect(r.staged).toBe('left')
    const w = r.warnings.find((x) => x.code === 'removal-not-done')
    expect(w).toMatchObject({ status: 'kept', reason: 'identity-changed' })
    expect(w && 'detail' in w ? w.detail : '').toContain('is not a directory')
    expect(fs.readFileSync(N(run.fx), 'utf8')).toBe('a file now\n')
  })

  it("N's lstat failing: left, stopped/unreadable with the errno", async () => {
    let on = false
    const run = await abortRun('step4', (fx) => ({
      hooks: { abortAfterCheck: () => void (on = true) },
      restore: stub('lstatSync', (orig) => (...a) => {
        if (on && a[0] === N(fx)) {
          const e = new Error('EACCES: forced') as NodeJS.ErrnoException
          e.code = 'EACCES'
          throw e
        }
        return orig(...a)
      }),
    }))
    const r = refusedOf(run.result)
    expect(r.staged).toBe('left')
    expect(r.warnings).toContainEqual(
      expect.objectContaining({ status: 'stopped', reason: 'unreadable', errno: 'EACCES' })
    )
    expect(fs.readdirSync(run.fx.opDir).sort()).toEqual(['new', 'owner.json'])
  })
})

describe('item 3: a stop after a keep rename still reports the tree as kept', () => {
  it("the area sync after a failed-build keep's rename fails: left, keptAs names the kept tree", async () => {
    const promises = fs.promises as unknown as Record<string, AnyFn>
    const origRename = promises.rename!
    const origOpen = promises.open!
    let renamed = false
    const run = await abortRun('build', (fx) => {
      const kept = path.join(areaOf(fx), `${OP_ID}.failed-build`)
      promises.rename = async (...a: unknown[]) => {
        const out = await origRename(...a)
        if (a[1] === kept) renamed = true
        return out
      }
      promises.open = async (...a: unknown[]) => {
        if (renamed && a[0] === areaOf(fx)) {
          const e = new Error('EIO: forced') as NodeJS.ErrnoException
          e.code = 'EIO'
          throw e
        }
        return origOpen(...a)
      }
      syncBuiltinESMExports()
      return {
        restore: () => {
          promises.rename = origRename
          promises.open = origOpen
          syncBuiltinESMExports()
        },
      }
    })
    const { fx } = run
    expect(renamed).toBe(true)
    const kept = path.join(areaOf(fx), `${OP_ID}.failed-build`)
    const r = refusedOf(run.result)
    expect(r).toMatchObject({
      staged: 'left',
      opDir: fx.opDir,
      keptAs: { kind: 'failed-build', path: kept },
    })
    expect(r.warnings).toContainEqual(notDone(fx, 'stopped', 'write-failed'))
    expect(fs.readFileSync(path.join(kept, 'SKILL.md'), 'utf8')).toBe('# v1\n')
  })
})

describe('item 7: the build binds new/ only as a directory', () => {
  it("the mkdir's lstat reporting a non-directory: refused write-failed, nothing copied into it", async () => {
    let first = true
    const run = await abortRun('step4', (fx) => ({
      restore: stub('lstatSync', (orig) => (...a) => {
        const s = orig(...a) as fs.BigIntStats
        if (first && a[0] === N(fx) && typeof s.mode === 'bigint') {
          first = false
          return cloneStat(s, { mode: (s.mode & ~S_IFMT) | S_IFREG })
        }
        return s
      }),
    }))
    const r = refusedOf(run.result)
    expect(r.reason).toBe('write-failed')
    expect(r.detail).toContain('is not the directory the build made')
    expect(fs.readdirSync(N(run.fx))).toEqual([])
  })
})
