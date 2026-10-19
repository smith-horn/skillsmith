/**
 * SMI-6531 (A1 step 1): properties of a nest of locks that the per-pair rule
 * tests do not reach. Found by an independent mutation hunt over the tracker.
 *
 *  - every ANCESTOR counts, not just the innermost lock (three-deep nests);
 *  - 1' sits at the same level as 1 for every rank above it;
 *  - an `unordered` lock held outside constrains nothing ranked inside it;
 *  - withDestinationLock holds rank 2a for the work it runs;
 *  - re-entering lock 4 is a re-entry, not an under-leaf.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withFileLock } from '../../../src/config/file-lock.js'
import {
  assertSkillWriteLockNotHeld,
  LockOrderError,
  setLockTrackerEnabledForTests,
} from '../../../src/config/lock-tracker.js'
import type { LockOrder } from '../../../src/config/lock-tracker.js'
import { withDestinationLock } from '../../../src/install/fan-out.locks.js'

let dir: string
const target = (name: string): string => path.join(dir, name)

/** Well under any lock timeout used here: a refusal is immediate, a wait is not. */
const PROMPT_MS = 200
const WAIT_MS = 400

beforeEach(() => {
  setLockTrackerEnabledForTests(true)
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lock-nesting-')))
})

afterEach(() => {
  setLockTrackerEnabledForTests(true)
  fs.rmSync(dir, { recursive: true, force: true })
})

async function settle(p: Promise<unknown>): Promise<{ error: unknown; ms: number }> {
  const start = performance.now()
  try {
    await p
    return { error: undefined, ms: performance.now() - start }
  } catch (error) {
    return { error, ms: performance.now() - start }
  }
}

function expectKind(error: unknown, kind: LockOrderError['kind']): void {
  expect(error).toBeInstanceOf(LockOrderError)
  expect((error as LockOrderError).kind).toBe(kind)
}

function thrown(f: () => void): unknown {
  try {
    f()
    return undefined
  } catch (error) {
    return error
  }
}

const hold = (
  name: string,
  rank: LockOrder,
  fn: () => Promise<unknown>,
  timeoutMs?: number
): Promise<unknown> =>
  withFileLock(target(name), `lock ${name}`, fn, { rank, ...(timeoutMs ? { timeoutMs } : {}) })

describe('every ancestor counts in a three-deep nest', () => {
  // 1 -> 2a -> X: the innermost entry must be recorded WITH its two ancestors.
  it.each(['unordered', '2b'] as const)(
    'depth 0 lock re-requested from depth 2 (1 -> 2a -> %s) is refused as re-entry, promptly',
    async (innermost) => {
      let outcome: { error: unknown; ms: number } | undefined
      await hold('root', '1', () =>
        hold('mid', '2a', () =>
          hold('inner', innermost, async () => {
            outcome = await settle(
              withFileLock(target('root'), 'root again', async () => 'unreachable', {
                rank: 'unordered',
                timeoutMs: WAIT_MS,
              })
            )
          })
        )
      )
      expect(outcome).toBeDefined()
      expectKind(outcome?.error, 're-entry')
      expect(outcome?.ms).toBeLessThan(PROMPT_MS)
    }
  )

  it.each(['unordered', '2b'] as const)(
    'the skills-root lock still counts as held while planning from depth 2 (1 -> 2a -> %s)',
    async (innermost) => {
      let error: unknown = 'unset'
      await hold('root', '1', () =>
        hold('mid', '2a', () =>
          hold('inner', innermost, async () => {
            error = thrown(() => assertSkillWriteLockNotHeld('planning at depth 2'))
          })
        )
      )
      expectKind(error, 'held-while-planning')
    }
  )

  it('control: outside any lock the same planning check passes', () => {
    expect(thrown(() => assertSkillWriteLockNotHeld('free'))).toBeUndefined()
  })
})

describe("ranked locks nest inside 1' as they do inside 1", () => {
  it.each(['2a', '2b', '3', '4'] as const)("lock %s is admitted inside lock 1'", async (rank) => {
    const taken: string[] = []
    await hold('prime', "1'", () =>
      hold(`in-${rank}`, rank, async () => {
        taken.push(rank)
      })
    )
    expect(taken).toEqual([rank])
  })

  it("the full chain 1' -> 2a -> 2b -> 3 -> 4 nests", async () => {
    const taken: string[] = []
    await hold('p', "1'", async () => {
      taken.push("1'")
      await hold('a', '2a', async () => {
        taken.push('2a')
        await hold('b', '2b', async () => {
          taken.push('2b')
          await hold('c', '3', async () => {
            taken.push('3')
            await hold('d', '4', async () => {
              taken.push('4')
            })
          })
        })
      })
    })
    expect(taken).toEqual(["1'", '2a', '2b', '3', '4'])
  })
})

describe('an unordered lock held outside constrains nothing ranked inside it', () => {
  // `unordered` is checked for re-entry and the leaf rule only: a ranked request
  // inside it is neither an inversion nor a same-rank clash.
  it.each(['1', '2a', '4'] as const)(
    'lock %s is admitted inside an unordered lock',
    async (rank) => {
      const taken: string[] = []
      await hold('free', 'unordered', () =>
        hold(`ranked-${rank}`, rank, async () => {
          taken.push(rank)
        })
      )
      expect(taken).toEqual([rank])
    }
  )
})

describe('withDestinationLock holds rank 2a for the work it runs', () => {
  it("a rank '1' lock requested inside is an inversion", async () => {
    let ran = false
    let outcome: { error: unknown } | undefined
    await withDestinationLock(target('dest/skill'), async () => {
      outcome = await settle(
        hold('one', '1', async () => {
          ran = true
        })
      )
    })
    expectKind(outcome?.error, 'inversion')
    expect(ran).toBe(false)
  })

  it('a second destination lock (another destination) requested inside is a same-rank refusal', async () => {
    let ran = false
    let outcome: { error: unknown; ms: number } | undefined
    await withDestinationLock(target('dest/skill'), async () => {
      outcome = await settle(
        withDestinationLock(target('dest/other'), async () => {
          ran = true
        })
      )
    })
    expectKind(outcome?.error, 'same-rank')
    expect(outcome?.ms).toBeLessThan(PROMPT_MS)
    expect(ran).toBe(false)
  })
})

describe('lock 4 is a leaf, but re-entering it is a re-entry', () => {
  it('requesting held lock 4 again is reported as re-entry, not under-leaf', async () => {
    let outcome: { error: unknown } | undefined
    await withFileLock(
      target('leaf'),
      'leaf',
      async () => {
        outcome = await settle(
          withFileLock(target('leaf'), 'leaf again', async () => 'unreachable', {
            rank: '4',
            timeoutMs: WAIT_MS,
          })
        )
      },
      { rank: '4' }
    )
    expectKind(outcome?.error, 're-entry')
  })

  it('control: another target requested inside lock 4 is under-leaf', async () => {
    let outcome: { error: unknown } | undefined
    await hold('leaf', '4', async () => {
      outcome = await settle(hold('elsewhere', 'unordered', async () => 'unreachable'))
    })
    expectKind(outcome?.error, 'under-leaf')
  })
})
