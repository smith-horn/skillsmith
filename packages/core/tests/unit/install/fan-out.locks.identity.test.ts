/**
 * SMI-6531 (A1 step 1): `withDestinationLock` names one destination identity
 * for its admission check and its in-process queue, so two spellings of one
 * destination (a real parent and a symlink to it) are one lock, including
 * while the destination's parent does not exist yet.
 */
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LockOrderError, setLockTrackerEnabledForTests } from '../../../src/config/lock-tracker.js'
import { withDestinationLock } from '../../../src/install/fan-out.locks.js'

let root: string
let real: string
let link: string

beforeEach(() => {
  setLockTrackerEnabledForTests(true)
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-identity-')))
  real = path.join(root, 'real')
  link = path.join(root, 'link')
  fs.mkdirSync(real)
  fs.symlinkSync(real, link)
})

afterEach(() => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  setLockTrackerEnabledForTests(true)
  fs.rmSync(root, { recursive: true, force: true })
})

/** Far below the 30 s file-lock timeout: a refusal must not wait on anything. */
const PROMPT_MS = 1000

const TIMED_OUT = Symbol('timed out')

async function settleWithin(p: Promise<unknown>, ms: number): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<symbol>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms)
  })
  try {
    return await Promise.race([
      p.then(
        () => 'resolved',
        (err: unknown) => err
      ),
      timeout,
    ])
  } finally {
    clearTimeout(timer)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('withDestinationLock: one identity per destination', () => {
  it('re-entry through a symlinked parent spelling is refused promptly, parent absent at the outer start', async () => {
    const outerDest = path.join(real, 'new-parent', 'skill')
    const innerDest = path.join(link, 'new-parent', 'skill')
    expect(fs.existsSync(path.dirname(outerDest))).toBe(false)
    let innerRan = false
    const outcome = await withDestinationLock(outerDest, () =>
      settleWithin(
        withDestinationLock(innerDest, async () => {
          innerRan = true
        }),
        PROMPT_MS
      )
    )
    expect(outcome).toBeInstanceOf(LockOrderError)
    expect((outcome as LockOrderError).kind).toBe('re-entry')
    expect(innerRan).toBe(false)
  })

  it('two concurrent calls via two spellings of an absent parent share one queue and never overlap', async () => {
    const dests = [path.join(real, 'new-parent', 'skill'), path.join(link, 'new-parent', 'skill')]
    const realMkdir = fsPromises.mkdir.bind(fsPromises)
    const mkdirs: string[] = []
    vi.spyOn(fsPromises, 'mkdir').mockImplementation(((p: fs.PathLike, o?: unknown) => {
      mkdirs.push(String(p))
      return realMkdir(p, o as fs.MakeDirectoryOptions)
    }) as typeof fsPromises.mkdir)
    syncBuiltinESMExports()

    const events: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = withDestinationLock(dests[0], async () => {
      events.push('enter-first')
      await gate
      events.push('exit-first')
    })
    // Started in the same tick, while the parent does not exist yet.
    const second = withDestinationLock(dests[1], async () => {
      events.push('enter-second')
      events.push('exit-second')
    })
    // While the first holds the destination, the second must still be queued:
    // it has not reached the mkdir that follows the queue (the property of one
    // queue; the file lock alone would also keep their bodies apart).
    await sleep(200)
    expect(mkdirs).toHaveLength(1)
    expect(events).toEqual(['enter-first'])
    release()
    await Promise.all([first, second])
    expect(events).toEqual(['enter-first', 'exit-first', 'enter-second', 'exit-second'])
  })

  it('control: two different destinations are not serialized by each other', async () => {
    const a = path.join(real, 'parent', 'skill-a')
    const b = path.join(link, 'parent', 'skill-b')
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let bRanWhileAHeld = false
    let aHeld = false
    const first = withDestinationLock(a, async () => {
      aHeld = true
      await gate
      aHeld = false
    })
    await sleep(50)
    const second = withDestinationLock(b, async () => {
      bRanWhileAHeld = aHeld
    })
    const outcome = await settleWithin(second, PROMPT_MS)
    release()
    await first
    expect(outcome).toBe('resolved')
    expect(bRanWhileAHeld).toBe(true)
  })
})
