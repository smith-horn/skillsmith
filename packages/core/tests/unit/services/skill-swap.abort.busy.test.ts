/**
 * SMI-6531 (A1 step 4b): T-X15, a `busy` update waits once more for lock 1,
 * then parks, keeps or leaves its staged tree (UD16, UD28).
 *
 * Timeouts are scaled down (lock 1's wait 200 ms, the second wait 300 ms or
 * 3 s, polls 50 ms) so the suite is fast; the plan's bounds are 30 s each, so
 * a `busy` update ends within about 60 s of first asking for lock 1.
 * `--clean-staging` keeping a left tree as `unrecorded-new` is step 6's.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { SwapOptions, TraceOp } from '../../../src/services/skill-swap.js'
import { parkedCopy, refusedOf, stderrSink } from './skill-swap.abort.helpers.js'
import {
  areaOf,
  hashOf,
  listTree,
  makeFixture,
  modify,
  OP_ID,
  plan,
  run,
  tmp,
  useTmpCleanup,
} from './skill-swap.helpers.js'
import type { Fixture } from './skill-swap.helpers.js'

useTmpCleanup()

const childPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'skill-swap.child.mjs')
const FILES = { 'SKILL.md': '# v1\n', 'a.txt': 'a\n' }
const LOCK = '.skillsmith-writes.lock'

interface Holder {
  release: () => void
  exited: Promise<void>
  held: () => boolean
}

const holders: Holder[] = []
afterEach(async () => {
  for (const h of holders.splice(0)) {
    h.release()
    await h.exited
  }
})

/** A child process holding lock 1 on `skillsDir` until `release()`. */
async function holdLock(skillsDir: string, wait = true): Promise<Holder> {
  const markers = tmp('skill-swap-markers-')
  const child = spawn(process.execPath, ['--import', 'tsx', childPath, 'hold', skillsDir, markers])
  const exited = new Promise<void>((res) => child.on('exit', () => res()))
  const held = () => fs.existsSync(path.join(markers, 'held'))
  const h: Holder = {
    release: () => fs.writeFileSync(path.join(markers, 'release'), '1'),
    exited,
    held,
  }
  holders.push(h)
  const deadline = Date.now() + 20_000
  while (wait && !held()) {
    if (Date.now() > deadline) throw new Error('child never took the lock')
    await new Promise((r) => setTimeout(r, 10))
  }
  return h
}

/** Samples R and OP every 5 ms until `stop()`; records anything a waiter must not cause. */
function watchWhileWaiting(fx: Fixture, stop: () => boolean) {
  const rootBefore = new Set(fs.readdirSync(fx.skillsDir))
  const opBefore = { entries: listTree(fx.opDir), hash: hashOf(path.join(fx.opDir, 'new')) }
  const seen = { newRootNames: new Set<string>(), reclaim: false, opChanged: false, samples: 0 }
  const timer = setInterval(() => {
    if (stop()) return
    seen.samples++
    for (const n of fs.readdirSync(fx.skillsDir)) if (!rootBefore.has(n)) seen.newRootNames.add(n)
    if (fs.existsSync(path.join(fx.skillsDir, `${LOCK}.reclaim`))) seen.reclaim = true
    const now = { entries: listTree(fx.opDir), hash: hashOf(path.join(fx.opDir, 'new')) }
    if (JSON.stringify(now) !== JSON.stringify(opBefore)) seen.opChanged = true
  }, 5)
  return { seen, done: () => clearInterval(timer) }
}

const announce = (fx: Fixture, s: number) =>
  `Another Skillsmith operation is changing ${fs.realpathSync(fx.skillsDir)}; waiting up to ` +
  `${s} s to set aside this update's unused staged copy.`

/** Runs a busy update; `atWaitStart` runs when the second wait starts. */
async function busyRun(
  fx: Fixture,
  opts: SwapOptions & {
    atWaitStart?: () => void
    watch?: boolean
    /**
     * True once the test released the holder: sampling stops there, because
     * the holder's own release takes `<lock>.reclaim` (SMI-7148) and that is
     * not the waiter's doing.
     */
    released?: () => boolean
  } = {}
) {
  const p = plan(fx, [modify('SKILL.md', '# v2\n')])
  const sink = stderrSink()
  let underLock = false
  const w: { watcher: ReturnType<typeof watchWhileWaiting> | null } = { watcher: null }
  const { atWaitStart, watch = true, released = () => false, ...swapOpts } = opts
  const started = Date.now()
  const r = await run(p, {
    lockTimeoutMs: 200,
    secondWaitMs: 3000,
    secondWaitPollMs: 50,
    stderr: sink.stderr,
    trace: (t: TraceOp) => {
      if (t.op === 'abort-lock') underLock = true
    },
    hooks: {
      secondWaitStart: () => {
        if (watch) w.watcher = watchWhileWaiting(fx, () => underLock || released())
        atWaitStart?.()
      },
    },
    ...swapOpts,
  })
  const elapsed = Date.now() - started
  w.watcher?.done()
  return { p, r, lines: sink.lines, seen: w.watcher?.seen ?? null, elapsed }
}

describe('T-X15: a busy update waits once more for lock 1', () => {
  it('busy, then acquired: the unchanged tree is parked with its op dir; reason busy; a third writer still gets the lock', async () => {
    const fx = makeFixture(FILES)
    const holder = await holdLock(fx.skillsDir)
    let third: Holder | null = null
    let released = false
    const out = await busyRun(fx, {
      released: () => released,
      atWaitStart: () => {
        void holdLock(fx.skillsDir, false).then((h) => (third = h))
        setTimeout(() => {
          released = true
          holder.release()
        }, 300)
      },
    })
    const r = refusedOf(out.r.result)
    expect(r).toMatchObject({ reason: 'busy', staged: 'parked', parkedPath: parkedCopy(fx) })
    expect(fs.existsSync(fx.opDir)).toBe(false)
    expect(out.lines).toEqual([announce(fx, 3)])
    expect(out.seen!.samples).toBeGreaterThan(5)
    expect([...out.seen!.newRootNames]).toEqual([])
    expect(out.seen!.reclaim).toBe(false)
    expect(out.seen!.opChanged).toBe(false)
    // The third writer, polling concurrently, takes lock 1 too.
    const deadline = Date.now() + 15_000
    while (third === null || !(third as Holder).held()) {
      if (Date.now() > deadline) throw new Error('the third writer never got lock 1')
      await new Promise((res) => setTimeout(res, 20))
    }
  }, 30_000)

  it('busy, then acquired, a file in N edited when the second wait starts: kept as edited-new with the edit', async () => {
    const fx = makeFixture(FILES)
    const holder = await holdLock(fx.skillsDir)
    const out = await busyRun(fx, {
      watch: false,
      atWaitStart: () => {
        fs.appendFileSync(path.join(fx.opDir, 'new', 'a.txt'), 'edited while waiting\n')
        setTimeout(() => holder.release(), 300)
      },
    })
    const kept = path.join(areaOf(fx), `${OP_ID}.edited-new`)
    expect(refusedOf(out.r.result)).toMatchObject({
      reason: 'busy',
      staged: 'kept',
      keptAs: { kind: 'edited-new', path: kept },
    })
    expect(fs.readFileSync(path.join(kept, 'a.txt'), 'utf8')).toBe('a\nedited while waiting\n')
    expect(fs.existsSync(fx.opDir)).toBe(false)
  }, 30_000)

  it('busy twice: nothing removed, OP left naming --clean-staging, within both waits plus one poll', async () => {
    const fx = makeFixture(FILES)
    await holdLock(fx.skillsDir)
    const out = await busyRun(fx, { secondWaitMs: 300 })
    const r = refusedOf(out.r.result)
    expect(r).toMatchObject({
      reason: 'busy',
      staged: 'left',
      opDir: fx.opDir,
      cleanStagingHint: `skillsmith doctor recovery --clean-staging ${OP_ID}`,
    })
    expect(r.warnings).toContainEqual(
      expect.objectContaining({ code: 'removal-not-done', status: 'stopped', reason: 'busy' })
    )
    expect(fs.readdirSync(fx.opDir).sort()).toEqual(['new', 'owner.json'])
    // 200 ms + 300 ms + one 50 ms poll, plus process slack.
    expect(out.elapsed).toBeLessThan(200 + 300 + 50 + 1500)
    expect(out.lines).toEqual([announce(fx, 1)])
    expect([...out.seen!.newRootNames]).toEqual([])
    expect(out.seen!.reclaim).toBe(false)
    expect(out.seen!.opChanged).toBe(false)
  }, 30_000)

  it('a step-1 failure takes lock 1 with one normal wait: while another holds it, nothing is kept and OP is left', async () => {
    const fx = makeFixture(FILES)
    const holder = await holdLock(fx.skillsDir)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const sink = stderrSink()
    const r = await run(p, {
      lockTimeoutMs: 200,
      stderr: sink.stderr,
      hooks: {
        afterCopy: () => {
          throw new Error('forced build failure')
        },
      },
    })
    holder.release()
    expect(refusedOf(r.result)).toMatchObject({
      reason: 'write-failed',
      staged: 'left',
      opDir: fx.opDir,
      warnings: [expect.objectContaining({ code: 'removal-not-done', reason: 'busy' })],
    })
    expect(fs.readdirSync(fx.opDir).sort()).toEqual(['new', 'owner.json'])
    expect(fs.existsSync(areaOf(fx))).toBe(false)
    // No second wait for a step-1 failure: no announcement.
    expect(sink.lines).toEqual([])
  }, 30_000)

  it('control: skipping the second wait (0 ms) leaves the tree although the holder releases at once', async () => {
    const fx = makeFixture(FILES)
    const holder = await holdLock(fx.skillsDir)
    const out = await busyRun(fx, {
      secondWaitMs: 0,
      watch: false,
      atWaitStart: () => holder.release(),
    })
    expect(refusedOf(out.r.result)).toMatchObject({ reason: 'busy', staged: 'left' })
    expect(fs.readdirSync(fx.opDir).sort()).toEqual(['new', 'owner.json'])
  }, 30_000)
})
