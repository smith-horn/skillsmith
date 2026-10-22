/**
 * SMI-6531 (A1 step 1): the tracker's same-rank, under-leaf, second-root and
 * explicit-'unordered' rules, and `withDestinationLock`'s refusal ordering.
 *
 * Order: 1 = 1' < 2a < 2b < 3 < 4 < 5; locks 4 and 5 are leaves. Every refusal must arrive promptly: a
 * refusal that waits (on the in-process queue or the file lock) is a hang.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withFileLock } from '../../../src/config/file-lock.js'
import { LockOrderError, setLockTrackerEnabledForTests } from '../../../src/config/lock-tracker.js'
import type { LockOrder } from '../../../src/config/lock-tracker.js'
import { withDestinationLock } from '../../../src/install/fan-out.locks.js'

let dir: string

beforeEach(() => {
  setLockTrackerEnabledForTests(true)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-rules-'))
})

afterEach(() => {
  setLockTrackerEnabledForTests(true)
  fs.rmSync(dir, { recursive: true, force: true })
})

const PROMPT_MS = 50

/** The rejection of `p`, or a marker if it neither settled nor rejected in time. */
async function settleWithin(p: Promise<unknown>, ms: number): Promise<unknown> {
  const timedOut = Symbol('timed out')
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<symbol>((resolve) => {
    timer = setTimeout(() => resolve(timedOut), ms)
  })
  try {
    const outcome = await Promise.race([
      p.then(
        () => 'resolved' as const,
        (error: unknown) => error
      ),
      timeout,
    ])
    return outcome === timedOut ? 'timed out' : outcome
  } finally {
    clearTimeout(timer)
  }
}

function expectKind(error: unknown, kind: LockOrderError['kind']): void {
  expect(error).toBeInstanceOf(LockOrderError)
  expect((error as LockOrderError).kind).toBe(kind)
}

function lockOn(name: string, rank: LockOrder, fn: () => Promise<unknown>): Promise<unknown> {
  return withFileLock(path.join(dir, name), `lock ${name}`, fn, { rank })
}

describe('nesting two locks of one rank is refused', () => {
  for (const rank of ['2a', '3', '2b'] as const) {
    it(`lock ${rank} inside lock ${rank} (another target) is a same-rank refusal`, async () => {
      let innerRan = false
      const error = await lockOn(`outer-${rank}`, rank, () =>
        settleWithin(
          lockOn(`inner-${rank}`, rank, async () => {
            innerRan = true
          }),
          PROMPT_MS
        )
      )
      expectKind(error, 'same-rank')
      expect(innerRan).toBe(false)
    })
  }
})

describe('lock 4 is a leaf', () => {
  for (const request of ['4', 'unordered'] as const) {
    it(`rank ${request} requested inside lock 4 is an under-leaf refusal`, async () => {
      let innerRan = false
      const error = await lockOn('leaf', '4', () =>
        settleWithin(
          lockOn('other', request, async () => {
            innerRan = true
          }),
          PROMPT_MS
        )
      )
      expectKind(error, 'under-leaf')
      expect(innerRan).toBe(false)
    })
  }
})

describe('lock 5 (the journal) is a leaf too', () => {
  for (const request of ['5', '4', '3', 'unordered'] as const) {
    it(`rank ${request} requested inside lock 5 is an under-leaf refusal`, async () => {
      let innerRan = false
      const error = await lockOn('journal', '5', () =>
        settleWithin(
          lockOn('other', request, async () => {
            innerRan = true
          }),
          PROMPT_MS
        )
      )
      expectKind(error, 'under-leaf')
      expect(innerRan).toBe(false)
    })
  }

  it('rank 5 is admitted under lock 1 (a swap journals under its skills-root lock), and runs', async () => {
    let ran = false
    await lockOn('root', '1', () =>
      lockOn('journal', '5', async () => {
        ran = true
      })
    )
    expect(ran).toBe(true)
  })

  it('rank 5 is admitted under lock 3', async () => {
    let ran = false
    await lockOn('manifest', '3', () =>
      lockOn('journal', '5', async () => {
        ran = true
      })
    )
    expect(ran).toBe(true)
  })

  it('rank 5 requested inside lock 4 is an under-leaf refusal', async () => {
    const error = await lockOn('leaf', '4', () =>
      settleWithin(
        lockOn('journal', '5', async () => {}),
        PROMPT_MS
      )
    )
    expectKind(error, 'under-leaf')
  })
})

describe('skills-root locks', () => {
  it("lock 1' requested while holding lock 1 is a second-skills-root-lock refusal", async () => {
    const error = await lockOn('root-1', '1', () =>
      settleWithin(
        lockOn('root-1prime', "1'", async () => {}),
        PROMPT_MS
      )
    )
    expectKind(error, 'second-skills-root-lock')
  })
})

describe("the explicit 'unordered' rank", () => {
  it('is allowed inside a ranked lock that is not lock 4, and runs', async () => {
    let ran = false
    await lockOn('ranked', '2a', () =>
      lockOn('free', 'unordered', async () => {
        ran = true
      })
    )
    expect(ran).toBe(true)
  })

  it('is still refused as a re-entry of the same target', async () => {
    const target = path.join(dir, 'free-target')
    const error = await withFileLock(
      target,
      'free',
      () =>
        settleWithin(
          withFileLock(target, 'free again', async () => {}, { rank: 'unordered' }),
          PROMPT_MS
        ),
      { rank: 'unordered' }
    )
    expectKind(error, 're-entry')
  })
})

describe('withDestinationLock refuses before it waits or writes', () => {
  it('re-entry on the same destination rejects promptly instead of queueing behind itself', async () => {
    const dest = path.join(dir, 'dest-a', 'skill')
    let innerRan = false
    const error = await withDestinationLock(dest, () =>
      settleWithin(
        withDestinationLock(dest, async () => {
          innerRan = true
        }),
        PROMPT_MS
      )
    )
    expectKind(error, 're-entry')
    expect(innerRan).toBe(false)
  })

  it('an inversion rejects before the destination parent is created', async () => {
    const parent = path.join(dir, 'new-parent')
    const dest = path.join(parent, 'skill')
    let ran = false
    const error = await lockOn('manifest', '3', () =>
      settleWithin(
        withDestinationLock(dest, async () => {
          ran = true
        }),
        PROMPT_MS
      )
    )
    expectKind(error, 'inversion')
    expect(ran).toBe(false)
    expect(fs.existsSync(parent)).toBe(false)
  })

  it('control: outside any lock it creates the parent and runs the work', async () => {
    const parent = path.join(dir, 'made-parent')
    const dest = path.join(parent, 'skill')
    let ran = false
    await withDestinationLock(dest, async () => {
      ran = true
    })
    expect(ran).toBe(true)
    expect(fs.existsSync(parent)).toBe(true)
  })
})
