/**
 * SMI-6531 (A1 step 1): lock-order tracker tests (A1 plan §3.2; T-L2, T-L4, T-L5).
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
import { StuckLockError } from '../../../src/config/owned-lock.js'
import { runManifestUpdate } from '../../../src/services/skill-manifest.lock.js'

const REFUSAL_BUDGET_MS = 50

let dir: string
const target = (name: string): string => path.join(dir, name)

/** The rejection a promise settles with, and how long it took to settle. */
async function settle(p: Promise<unknown>): Promise<{ error: unknown; ms: number }> {
  const start = performance.now()
  try {
    await p
    return { error: undefined, ms: performance.now() - start }
  } catch (error) {
    return { error, ms: performance.now() - start }
  }
}

function expectOrderError(error: unknown, kind: LockOrderError['kind']): void {
  expect(error).toBeInstanceOf(LockOrderError)
  expect((error as LockOrderError).kind).toBe(kind)
}

beforeEach(() => {
  setLockTrackerEnabledForTests(true)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-tracker-'))
})

afterEach(() => {
  setLockTrackerEnabledForTests(true)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('lock order (T-L2)', () => {
  it('refuses lock 1 while holding lock 3, as an inversion, within 50 ms', async () => {
    await withFileLock(
      target('manifest.json'),
      'lock three',
      async () => {
        const { error, ms } = await settle(
          withFileLock(target('skills-writes'), 'lock one', async () => 'unreachable', {
            rank: '1',
          })
        )
        expectOrderError(error, 'inversion')
        expect(ms).toBeLessThan(REFUSAL_BUDGET_MS)
      },
      { rank: '3' }
    )
  })

  it("treats 1 and 1' as one rank: holding 1' then requesting 1 elsewhere is refused", async () => {
    await withFileLock(
      target('parked'),
      'parked area',
      async () => {
        const { error, ms } = await settle(
          withFileLock(target('skills-writes'), 'lock one', async () => 'unreachable', {
            rank: '1',
          })
        )
        expectOrderError(error, 'second-skills-root-lock')
        expect(ms).toBeLessThan(REFUSAL_BUDGET_MS)
      },
      { rank: "1'" }
    )
  })
})

describe('re-entry and a second root (T-L5)', () => {
  it('refuses re-entry on root A, then a lock 1 on root B, each within 50 ms', async () => {
    const rootA = target('rootA-writes')
    const rootB = target('rootB-writes')
    await withFileLock(
      rootA,
      'root A',
      async () => {
        const again = await settle(
          withFileLock(rootA, 'root A again', async () => 'unreachable', { rank: '1' })
        )
        expectOrderError(again.error, 're-entry')
        expect(again.ms).toBeLessThan(REFUSAL_BUDGET_MS)

        const other = await settle(
          withFileLock(rootB, 'root B', async () => 'unreachable', { rank: '1' })
        )
        expectOrderError(other.error, 'second-skills-root-lock')
        expect(other.ms).toBeLessThan(REFUSAL_BUDGET_MS)
      },
      { rank: '1' }
    )
  })

  it('control: with the tracker off the re-entry request waits until it is busy', async () => {
    setLockTrackerEnabledForTests(false)
    const rootA = target('rootA-writes')
    const timeoutMs = 300
    await withFileLock(
      rootA,
      'root A',
      async () => {
        const { error, ms } = await settle(
          withFileLock(rootA, 'root A again', async () => 'unreachable', {
            rank: '1',
            timeoutMs,
          })
        )
        expect(error).toBeInstanceOf(StuckLockError)
        expect(error).not.toBeInstanceOf(LockOrderError)
        // Date.now() deadline vs performance.now() elapsed: allow a little clock slack.
        expect(ms).toBeGreaterThanOrEqual(timeoutMs - 10)
      },
      { rank: '1' }
    )
  })
})

describe('allowed orders', () => {
  it('lets 1 -> 2a -> 2b -> 3 -> 4 nest', async () => {
    const taken: string[] = []
    await withFileLock(
      target('t1'),
      'one',
      async () => {
        taken.push('1')
        await withFileLock(
          target('t2a'),
          'two a',
          async () => {
            taken.push('2a')
            await withFileLock(
              target('t2b'),
              'two b',
              async () => {
                taken.push('2b')
                await withFileLock(
                  target('t3'),
                  'three',
                  async () => {
                    taken.push('3')
                    await withFileLock(
                      target('t4'),
                      'four',
                      async () => {
                        taken.push('4')
                      },
                      { rank: '4' }
                    )
                  },
                  { rank: '3' }
                )
              },
              { rank: '2b' }
            )
          },
          { rank: '2a' }
        )
      },
      { rank: '1' }
    )
    expect(taken).toEqual(['1', '2a', '2b', '3', '4'])
  })

  it('lets two sibling (not nested) lock 1s run in sequence', async () => {
    await withFileLock(target('rootA'), 'root A', async () => undefined, { rank: '1' })
    await withFileLock(target('rootB'), 'root B', async () => undefined, { rank: '1' })
  })

  it('lets an unordered lock nest in a ranked one', async () => {
    let ran = false
    await withFileLock(
      target('t3'),
      'three',
      async () => {
        await withFileLock(
          target('plain'),
          'unranked',
          async () => {
            ran = true
          },
          { rank: 'unordered' }
        )
      },
      { rank: '3' }
    )
    expect(ran).toBe(true)
  })

  it('refuses an unordered re-entry', async () => {
    await withFileLock(
      target('plain'),
      'unranked',
      async () => {
        const { error, ms } = await settle(
          withFileLock(target('plain'), 'unranked again', async () => 'unreachable', {
            rank: 'unordered',
          })
        )
        expectOrderError(error, 're-entry')
        expect(ms).toBeLessThan(REFUSAL_BUDGET_MS)
      },
      { rank: 'unordered' }
    )
  })

  it('unwinds: after the outer lock resolves, the same target can be taken again', async () => {
    const t = target('t1')
    await withFileLock(t, 'first', async () => undefined, { rank: '1' })
    let ran = false
    await withFileLock(
      t,
      'second',
      async () => {
        ran = true
      },
      { rank: '1' }
    )
    expect(ran).toBe(true)
  })
})

describe('pure manifest callbacks (T-L4)', () => {
  const initial = JSON.stringify({ skills: { a: 1 } }, null, 2)
  let manifestPath: string

  beforeEach(() => {
    manifestPath = target('manifest.json')
    fs.writeFileSync(manifestPath, initial)
  })

  const load = async (): Promise<{ skills: Record<string, number> }> =>
    JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

  it('rejects a callback that requests a lock, even if it swallows the promise, and saves nothing', async () => {
    const unhandled: unknown[] = []
    const listener = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', listener)
    try {
      const { error } = await settle(
        runManifestUpdate({
          manifestPath,
          load,
          update: (m) => {
            // Deliberately ignores the returned promise.
            void withFileLock(target('other'), 'inside callback', async () => undefined, {
              rank: '4',
            })
            m.skills.b = 2
            return m
          },
        })
      )
      expectOrderError(error, 'in-pure-callback')
      // Let any unhandled rejection surface before checking.
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', listener)
    }
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(initial)
  })

  it('rejects a callback that returns a promise', async () => {
    const { error } = await settle(
      runManifestUpdate({
        manifestPath,
        load,
        update: (() => Promise.resolve({ skills: {} })) as unknown as (m: {
          skills: Record<string, number>
        }) => { skills: Record<string, number> },
      })
    )
    expect(error).toBeInstanceOf(TypeError)
    expect((error as Error).message).toMatch(/synchronous/)
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(initial)
  })

  it('saves the result of a normal callback', async () => {
    await runManifestUpdate({
      manifestPath,
      load,
      update: (m) => {
        m.skills.b = 2
        return m
      },
    })
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))).toEqual({ skills: { a: 1, b: 2 } })
  })
})

describe('assertSkillWriteLockNotHeld', () => {
  function heldWhilePlanning(): unknown {
    try {
      assertSkillWriteLockNotHeld('plan')
      return undefined
    } catch (error) {
      return error
    }
  }

  it.each(['1', "1'"] as const)(
    'throws held-while-planning inside a rank %s lock',
    async (rank) => {
      await withFileLock(
        target('root'),
        'root lock',
        async () => {
          expectOrderError(heldWhilePlanning(), 'held-while-planning')
        },
        { rank }
      )
    }
  )

  it('does not throw inside a rank 3 lock', async () => {
    await withFileLock(
      target('manifest.json'),
      'manifest',
      async () => {
        expect(heldWhilePlanning()).toBeUndefined()
      },
      { rank: '3' }
    )
  })

  it('does not throw outside any lock', () => {
    expect(heldWhilePlanning()).toBeUndefined()
  })

  it('does not throw with the tracker disabled', async () => {
    setLockTrackerEnabledForTests(false)
    await withFileLock(
      target('root'),
      'root lock',
      async () => {
        expect(heldWhilePlanning()).toBeUndefined()
      },
      { rank: '1' }
    )
  })
})
