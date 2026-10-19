/**
 * SMI-6531 (A1 step 1): regression tests for three lock-tracker defects found
 * in cross-family review: stale held state, path identity, escaping async work.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withFileLock } from '../../../src/config/file-lock.js'
import {
  assertSkillWriteLockNotHeld,
  LockOrderError,
  lockKey,
  runHoldingLock,
  runPureCallback,
  setLockTrackerEnabledForTests,
} from '../../../src/config/lock-tracker.js'
import { runManifestUpdate } from '../../../src/services/skill-manifest.lock.js'

let dir: string
const target = (name: string): string => path.join(dir, name)
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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

function planningError(): unknown {
  try {
    assertSkillWriteLockNotHeld('late')
    return undefined
  } catch (error) {
    return error
  }
}

beforeEach(() => {
  setLockTrackerEnabledForTests(true)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-tracker-fixes-'))
})

afterEach(() => {
  setLockTrackerEnabledForTests(true)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('stale held state after release', () => {
  it('a timer started inside a rank 1 lock does not see it held once released; a sync call inside does', async () => {
    let inside: unknown = 'unset'
    let late: unknown = 'unset'
    await withFileLock(
      target('a'),
      'x',
      async () => {
        setTimeout(() => {
          late = planningError()
        }, 30)
        inside = planningError()
      },
      { rank: '1' }
    )
    expectOrderError(inside, 'held-while-planning')
    await sleep(80)
    expect(late).toBeUndefined()
  })

  it('leftover work started inside a rank 3 lock may request rank 1 after the release', async () => {
    let outcome: { error: unknown } | undefined
    await withFileLock(
      target('three'),
      'outer',
      async () => {
        setTimeout(() => {
          void settle(
            withFileLock(target('one'), 'late one', async () => 'ran', { rank: '1' })
          ).then((r) => {
            outcome = r
          })
        }, 30)
      },
      { rank: '3' }
    )
    await sleep(120)
    expect(outcome).toBeDefined()
    expect(outcome?.error).toBeUndefined()
  })

  it('control: the same request made while the rank 3 lock is held is an inversion', async () => {
    await withFileLock(
      target('three'),
      'outer',
      async () => {
        const { error } = await settle(
          withFileLock(target('one'), 'inside one', async () => 'unreachable', { rank: '1' })
        )
        expectOrderError(error, 'inversion')
      },
      { rank: '3' }
    )
  })

  it('leftover work may re-take the same target after release (not re-entry)', async () => {
    const t = target('same')
    let outcome: { error: unknown } | undefined
    await withFileLock(
      t,
      'outer',
      async () => {
        setTimeout(() => {
          void settle(withFileLock(t, 'again', async () => 'ran', { rank: '1' })).then((r) => {
            outcome = r
          })
        }, 30)
      },
      { rank: '1' }
    )
    await sleep(120)
    expect(outcome).toBeDefined()
    expect(outcome?.error).toBeUndefined()
  })
})

describe('path identity', () => {
  let realSub: string
  let link: string

  beforeEach(() => {
    realSub = path.join(dir, 'real', 'sub')
    fs.mkdirSync(realSub, { recursive: true })
    link = path.join(dir, 'link')
    fs.symlinkSync(realSub, link)
  })

  // path.join would collapse '..' lexically, so build the raw spelling by hand.
  const rawDotDot = (): string => `${link}${path.sep}..${path.sep}x`

  it('link/../x keys the same as real/x (the OS opens link/../x as real/x)', () => {
    expect(lockKey(rawDotDot())).toBe(lockKey(path.join(dir, 'real', 'x')))
  })

  it('control: link/../x does not key like the lexical collapse <tmp>/x', () => {
    expect(lockKey(rawDotDot())).not.toBe(lockKey(path.join(dir, 'x')))
  })

  it('holding real/x then requesting link/../x is refused as re-entry at once', async () => {
    await withFileLock(
      path.join(dir, 'real', 'x'),
      'outer',
      async () => {
        const { error, ms } = await settle(
          withFileLock(rawDotDot(), 'inner', async () => 'unreachable', { rank: 'unordered' })
        )
        expectOrderError(error, 're-entry')
        expect(ms).toBeLessThan(200)
      },
      { rank: 'unordered' }
    )
  })

  it('a missing folder keys the same before and after it is created', () => {
    const f = path.join(dir, 'later', 'f')
    const before = lockKey(f)
    fs.mkdirSync(path.join(dir, 'later'))
    expect(lockKey(f)).toBe(before)
  })

  it('the key is recomputed once the lock is held: a folder that became a symlink meanwhile is still re-entry', async () => {
    const later = path.join(dir, 'later')
    await runHoldingLock(path.join(later, 'x'), 'outer', 'unordered', async (acquired) => {
      fs.symlinkSync(realSub, later) // the folder appears, as a symlink, before the lock is held
      acquired()
      const { error } = await settle(
        withFileLock(path.join(realSub, 'x'), 'inner', async () => 'unreachable', {
          rank: 'unordered',
          timeoutMs: 300,
        })
      )
      expectOrderError(error, 're-entry')
    })
  })

  it('a missing folder under a symlinked root keys to the real root', () => {
    const realRoot = path.join(dir, 'realroot')
    fs.mkdirSync(realRoot)
    const alias = path.join(dir, 'alias')
    fs.symlinkSync(realRoot, alias)
    const viaAlias = lockKey(path.join(alias, 'missing', 'f'))
    expect(viaAlias).toBe(path.join(fs.realpathSync(realRoot), 'missing', 'f'))
    expect(viaAlias).toBe(lockKey(path.join(realRoot, 'missing', 'f')))
  })
})

describe('a synchronous callback that calls a synchronous API with internal async work', () => {
  it('is not refused: crypto.randomUUID refills its entropy pool asynchronously', async () => {
    const manifestPath = target('random-manifest.json')
    fs.writeFileSync(manifestPath, JSON.stringify({ version: '1.0.0', installedSkills: {} }))
    await runManifestUpdate<{
      version: string
      installedSkills: Record<string, unknown>
      ids?: string[]
    }>({
      manifestPath,
      load: async () => JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
      // Enough UUIDs to exhaust Node's cached entropy and force a refill.
      update: (m) => ({ ...m, ids: Array.from({ length: 200 }, () => crypto.randomUUID()) }),
    })
    const saved = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { ids: string[] }
    expect(saved.ids).toHaveLength(200)
  })
})

describe('async work escaping a manifest update callback', () => {
  const initial = JSON.stringify({ skills: { a: 1 } }, null, 2)
  type M = { skills: Record<string, number> }
  let manifestPath: string
  const unhandled: unknown[] = []
  const listener = (reason: unknown): void => {
    unhandled.push(reason)
  }

  beforeEach(() => {
    manifestPath = target('manifest.json')
    fs.writeFileSync(manifestPath, initial)
    unhandled.length = 0
    process.on('unhandledRejection', listener)
  })

  afterEach(() => {
    process.off('unhandledRejection', listener)
  })

  const load = async (): Promise<M> => JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

  async function runRefused(schedule: (late: () => void) => void): Promise<void> {
    const late = (): void => {
      void withFileLock(target('q'), 'late', async () => {}, { rank: '4' })
    }
    const { error } = await settle(
      runManifestUpdate({
        manifestPath,
        load,
        update: (m: M) => {
          schedule(late)
          m.skills.b = 2
          return m
        },
      })
    )
    expectOrderError(error, 'in-pure-callback')
    await sleep(50)
    expect(unhandled).toEqual([])
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(initial)
  }

  it('refuses a callback that schedules a lock request with queueMicrotask', async () => {
    await runRefused((late) => queueMicrotask(late))
  })

  it('refuses a callback that schedules a lock request with Promise.then', async () => {
    await runRefused((late) => {
      void Promise.resolve().then(late)
    })
  })

  it('refuses a callback that schedules a lock request with setTimeout', async () => {
    await runRefused((late) => {
      setTimeout(late, 0)
    })
  })

  it('control: a callback that only computes still saves', async () => {
    await runManifestUpdate({
      manifestPath,
      load,
      update: (m: M) => {
        m.skills.b = 2
        return m
      },
    })
    await sleep(50)
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))).toEqual({ skills: { a: 1, b: 2 } })
    expect(unhandled).toEqual([])
  })
})

describe('release and tracker clearing happen in one synchronous step', () => {
  const LINKS = 200
  interface Sample {
    fileExists: boolean
    held: boolean
  }

  /** Start a self-rescheduling microtask chain; each link samples file-vs-tracker. */
  function startChain(
    lockFile: string,
    samples: Sample[],
    onLink?: (s: Sample) => void
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const link = (n: number): void => {
        const sample: Sample = {
          fileExists: fs.existsSync(lockFile),
          held: planningError() instanceof LockOrderError,
        }
        samples.push(sample)
        onLink?.(sample)
        if (n + 1 < LINKS) queueMicrotask(() => link(n + 1))
        else resolve()
      }
      queueMicrotask(() => link(0))
    })
  }

  it('no microtask sees the lock file gone while the tracker still reports it held', async () => {
    const samples: Sample[] = []
    let chain: Promise<void> = Promise.resolve()
    await withFileLock(
      target('window'),
      'window',
      async () => {
        chain = startChain(`${target('window')}.lock`, samples) // not awaited: runs across the release
      },
      { rank: '1' }
    )
    await chain
    expect(samples).toHaveLength(LINKS)
    // The property: the file is gone only when the tracker agrees.
    expect(samples.filter((s) => !s.fileExists && s.held)).toEqual([])
    // Positive controls from the same run: the chain spanned the release.
    expect(samples.some((s) => s.fileExists && s.held)).toBe(true)
    expect(samples.some((s) => !s.fileExists && !s.held)).toBe(true)
  })

  it('work started inside the lock can take the same target the moment its file is gone', async () => {
    const samples: Sample[] = []
    let chain: Promise<void> = Promise.resolve()
    let again: Promise<string> | undefined
    await withFileLock(
      target('again'),
      'first',
      async () => {
        chain = startChain(`${target('again')}.lock`, samples, (s) => {
          if (again === undefined && !s.fileExists) {
            again = withFileLock(target('again'), 'second', async () => 'ok', {
              rank: 'unordered',
              timeoutMs: 2_000,
            })
          }
        })
      },
      { rank: 'unordered' }
    )
    await chain
    expect(again).toBeDefined() // the file did disappear during the chain
    await expect(again).resolves.toBe('ok') // not refused as re-entry
  })
})

describe('known gap: the purity watch sees only async resources created during the callback', () => {
  it('KNOWN GAP (not desired behaviour): a listener added to an existing emitter is not refused', () => {
    const emitter = new EventEmitter()
    expect(() =>
      runPureCallback(() => {
        emitter.on('later', () => {}) // could run later and request a lock; the watch cannot see it
        return 1
      })
    ).not.toThrow()
    expect(emitter.listenerCount('later')).toBe(1) // the callback really ran and registered it
    // Paired control: the same watch does refuse a resource it can see.
    expect(() =>
      runPureCallback(() => {
        queueMicrotask(() => {})
        return 1
      })
    ).toThrow(LockOrderError)
  })
})

describe('known gap: native request types outside SCHEDULING_TYPES', () => {
  it('KNOWN GAP (not desired behaviour): a callback-style crypto.randomBytes started inside is not refused', async () => {
    let ran = false
    expect(() =>
      runPureCallback(() => {
        // No promise here: creating one would be refused. The callback could run
        // later and request a lock; the watch cannot see it.
        crypto.randomBytes(16, () => {
          ran = true
        })
        return 1
      })
    ).not.toThrow()
    for (let i = 0; i < 100 && !ran; i++) await sleep(5)
    expect(ran).toBe(true) // the callback really was scheduled and ran
    // Paired control: the same watch does refuse a type it can see.
    expect(() =>
      runPureCallback(() => {
        setTimeout(() => {}, 0)
        return 1
      })
    ).toThrow(LockOrderError)
  })
})

describe('lockKey: what "same key" guarantees', () => {
  it('two hard links to one file key differently (hard links are never merged)', () => {
    const a = target('hard-a')
    const b = target('hard-b')
    fs.writeFileSync(a, 'x')
    fs.linkSync(a, b)
    expect(fs.statSync(a).ino).toBe(fs.statSync(b).ino)
    expect(lockKey(a)).not.toBe(lockKey(b))
  })

  it('a case variant of a folder that does not exist yet is never merged', () => {
    expect(lockKey(path.join(dir, 'Absent', 'f'))).not.toBe(lockKey(path.join(dir, 'ABSENT', 'f')))
  })

  it.skipIf(process.platform !== 'darwin')(
    'macOS: a case variant of an existing folder keys the same, but the final name is kept as spelled',
    () => {
      fs.mkdirSync(path.join(dir, 'Case'))
      expect(lockKey(path.join(dir, 'case', 'f'))).toBe(lockKey(path.join(dir, 'CASE', 'f')))
      expect(lockKey(path.join(dir, 'Case', 'f'))).not.toBe(lockKey(path.join(dir, 'Case', 'F')))
    }
  )
})
