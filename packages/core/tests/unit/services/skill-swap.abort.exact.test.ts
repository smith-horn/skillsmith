/**
 * SMI-6531 (A1 step 4b, review round 3): OP's entries are checked by ONE rule
 * (UD40): OP holds exactly an expected set of names, each with the identity
 * this run bound for it. An entry that is missing, or is another inode under
 * the same name, ends `left` with `kept/identity-changed`; nothing is parked.
 *
 * Also pinned here: the residual UD18 accepts (a byte-identical swap after the
 * last check is parked in N's place) and a keep whose rename throws while a
 * different directory sits at its destination (`keptAs` must not name it).
 */
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SwapOptions } from '../../../src/services/skill-swap.js'
import {
  ALL_DELETES,
  contentOf,
  parkedCopy,
  parkedOpArea,
  refusedOf,
  runSpied,
  stderrSink,
} from './skill-swap.abort.helpers.js'
import { abortAt } from './skill-swap.abort.triggers.js'
import { areaOf, makeFixture, modify, OP_ID, plan, useTmpCleanup } from './skill-swap.helpers.js'
import type { Fixture } from './skill-swap.helpers.js'

useTmpCleanup()

const FILES = { 'SKILL.md': '# v1\n', 'a.txt': 'a\n', 'sub/b.txt': 'b\n' }
type AnyFn = (...a: unknown[]) => unknown
type Hooks = NonNullable<SwapOptions['hooks']>
const table = fs as unknown as Record<string, AnyFn>
const N = (fx: Fixture) => path.join(fx.opDir, 'new')
const INTENT = (fx: Fixture) => path.join(fx.opDir, 'park-intent.json')

/** Runs a step-4 abort (live folder edited after the build) with `hooksOf(fx)` added. */
async function abortRun(
  hooksOf: (fx: Fixture) => Hooks,
  setup: (fx: Fixture) => { restore?: () => void } = () => ({})
) {
  const fx = makeFixture(FILES)
  const p = plan(fx, [modify('SKILL.md', '# v2\n')])
  const sink = stderrSink()
  const s = setup(fx)
  const t = abortAt(fx, 'step4', hooksOf(fx))
  try {
    const r = await runSpied(p, ALL_DELETES, { ...t.options, stderr: sink.stderr })
    return { fx, built: t.built, lines: sink.lines, ...r }
  } finally {
    s.restore?.()
    t.restore()
  }
}

/** N renamed aside and a byte-identical copy put at N. Returns where the original went and the copy's inode. */
function swapNewForCopy(fx: Fixture): { aside: string; ino: bigint } {
  const aside = path.join(fx.base, 'new-aside')
  const copy = path.join(fx.base, 'new-copy')
  fs.cpSync(N(fx), copy, { recursive: true, verbatimSymlinks: true })
  fs.renameSync(N(fx), aside)
  fs.renameSync(copy, N(fx))
  return { aside, ino: fs.lstatSync(N(fx), { bigint: true }).ino }
}

const identityChanged = (fx: Fixture) =>
  expect.objectContaining({
    code: 'removal-not-done',
    path: fx.opDir,
    status: 'kept',
    reason: 'identity-changed',
  })

describe('OP holds exactly what this run bound: a missing or swapped entry is identity-changed', () => {
  it('park-intent.json unlinked before the gate: left, nothing parked', async () => {
    const run = await abortRun((fx) => ({ afterOwnerUnlink: () => fs.unlinkSync(INTENT(fx)) }))
    const r = refusedOf(run.result)
    expect(r).toMatchObject({ staged: 'left', opDir: run.fx.opDir })
    expect(r.warnings).toContainEqual(identityChanged(run.fx))
    const w = r.warnings.find((x) => x.code === 'removal-not-done')
    expect(w && 'detail' in w ? w.detail : '').toContain('park-intent.json is missing')
    expect(fs.existsSync(parkedOpArea(run.fx))).toBe(false)
    expect(fs.readdirSync(run.fx.opDir)).toEqual(['new'])
  })

  it('N renamed aside and a byte-identical copy put at N, before the gate: left, both trees stay, nothing parked', async () => {
    let swap: ReturnType<typeof swapNewForCopy> | null = null
    const run = await abortRun((fx) => ({
      afterOwnerUnlink: () => void (swap = swapNewForCopy(fx)),
    }))
    const { fx } = run
    expect(swap).not.toBeNull()
    const r = refusedOf(run.result)
    expect(r.staged).toBe('left')
    expect(r.warnings).toContainEqual(identityChanged(fx))
    expect(fs.existsSync(parkedOpArea(fx))).toBe(false)
    expect(contentOf(N(fx))).toEqual(run.built.content)
    expect(contentOf(swap!.aside)).toEqual(run.built.content)
    expect(fs.lstatSync(swap!.aside, { bigint: true }).ino).toBe(run.built.ino)
  })

  it("the same swap between the gate's hash and the post-hash check: left, nothing parked", async () => {
    let armed = true
    let swap: ReturnType<typeof swapNewForCopy> | null = null
    const run = await abortRun(
      () => ({}),
      (fx) => {
        const orig = table.readdirSync!.bind(fs) as AnyFn
        table.readdirSync = (...a: unknown[]) => {
          const out = orig(...a)
          // The gate's hash walk reads OP once, after the probes: swap right after it.
          if (armed && a[0] === fx.opDir) {
            armed = false
            swap = swapNewForCopy(fx)
          }
          return out
        }
        return {
          restore: () => {
            table.readdirSync = orig
          },
        }
      }
    )
    expect(armed).toBe(false)
    expect(swap).not.toBeNull()
    const r = refusedOf(run.result)
    expect(r.staged).toBe('left')
    expect(r.warnings).toContainEqual(identityChanged(run.fx))
    expect(run.trace.some((t) => t.op === 'park')).toBe(false)
    expect(fs.existsSync(parkedOpArea(run.fx))).toBe(false)
  })

  it('N removed entirely before the gate: left, nothing parked', async () => {
    const run = await abortRun((fx) => ({
      afterOwnerUnlink: () => fs.rmSync(N(fx), { recursive: true }),
    }))
    const r = refusedOf(run.result)
    expect(r.staged).toBe('left')
    expect(r.warnings).toContainEqual(identityChanged(run.fx))
    expect(fs.existsSync(parkedOpArea(run.fx))).toBe(false)
    expect(fs.existsSync(N(run.fx))).toBe(false)
  })
})

describe('the residual UD18 accepts (identical-serialization class)', () => {
  it('a byte-identical swap of N at beforePark, after the last check, is parked in its place', async () => {
    let swap: ReturnType<typeof swapNewForCopy> | null = null
    const run = await abortRun((fx) => ({ beforePark: () => void (swap = swapNewForCopy(fx)) }))
    const { fx } = run
    expect(swap).not.toBeNull()
    const r = refusedOf(run.result)
    const copy = parkedCopy(fx)
    // Pins UD18's accepted outcome: no entry check follows `beforePark`, and the
    // park's guard hash is content-only, so the substitute is parked whole.
    expect(r).toMatchObject({ staged: 'parked', parkedPath: copy })
    const parkedNew = path.join(copy, 'new')
    // Not vacuous: the parked `new` is the substitute's inode, not the build's.
    expect(fs.lstatSync(parkedNew, { bigint: true }).ino).toBe(swap!.ino)
    expect(swap!.ino).not.toBe(run.built.ino)
    expect(contentOf(parkedNew)).toEqual(run.built.content)
    // The original is untouched wherever the swapper put it.
    expect(fs.lstatSync(swap!.aside, { bigint: true }).ino).toBe(run.built.ino)
    expect(contentOf(swap!.aside)).toEqual(run.built.content)
  })
})

describe('a keep whose rename throws', () => {
  it('a different directory at dest: keptAs does not name it, nothing is reported published', async () => {
    const fx = makeFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const dest = path.join(areaOf(fx), `${OP_ID}.failed-build`)
    const promises = fs.promises as unknown as Record<string, AnyFn>
    const origRename = promises.rename!
    let threw = false
    promises.rename = async (...a: unknown[]) => {
      if (a[0] === N(fx) && a[1] === dest) {
        threw = true
        fs.mkdirSync(dest)
        fs.writeFileSync(path.join(dest, 'other.txt'), 'someone else\n')
        const e = new Error('EIO: forced') as NodeJS.ErrnoException
        e.code = 'EIO'
        throw e
      }
      return origRename(...a)
    }
    syncBuiltinESMExports()
    let result
    try {
      const hooks: Hooks = {
        afterCopy: () => {
          throw new Error('forced build failure')
        },
      }
      result = await runSpied(p, [], { hooks, stderr: stderrSink().stderr })
    } finally {
      promises.rename = origRename
      syncBuiltinESMExports()
    }
    expect(threw).toBe(true)
    const r = refusedOf(result.result)
    expect(r.staged).toBe('left')
    expect(r.keptAs).toBeUndefined()
    expect(r.warnings).toContainEqual(
      expect.objectContaining({
        code: 'removal-not-done',
        status: 'stopped',
        reason: 'write-failed',
      })
    )
    expect(fs.readFileSync(path.join(dest, 'other.txt'), 'utf8')).toBe('someone else\n')
    expect(fs.existsSync(path.join(N(fx), 'SKILL.md'))).toBe(true)
  })
})
