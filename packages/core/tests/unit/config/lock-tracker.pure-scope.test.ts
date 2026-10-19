/**
 * SMI-6531 (A1 step 1): the manifest-update callback scope (`runPureCallback`).
 *
 *  - each scheduling type the async watch lists is refused on its own;
 *  - a refusal the callback itself caught still refuses the callback;
 *  - the held set passes through, so the planning guard works inside;
 *  - the scope closes when the callback returns (documents INTENDED behaviour);
 *  - a nested runPureCallback leaves the outer callback watched.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withFileLock } from '../../../src/config/file-lock.js'
import {
  assertSkillWriteLockNotHeld,
  checkLockRequest,
  LockOrderError,
  runPureCallback,
  setLockTrackerEnabledForTests,
} from '../../../src/config/lock-tracker.js'

let dir: string
const target = (name: string): string => path.join(dir, name)
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  setLockTrackerEnabledForTests(true)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-pure-scope-'))
  fs.writeFileSync(target('data'), 'x')
})

afterEach(() => {
  setLockTrackerEnabledForTests(true)
  fs.rmSync(dir, { recursive: true, force: true })
})

function thrown(f: () => void): unknown {
  try {
    f()
    return undefined
  } catch (error) {
    return error
  }
}

function expectKind(error: unknown, kind: LockOrderError['kind']): void {
  expect(error).toBeInstanceOf(LockOrderError)
  expect((error as LockOrderError).kind).toBe(kind)
}

describe('each scheduling type the watch lists is refused on its own', () => {
  const schedulers: Array<[string, () => void]> = [
    ['setImmediate (Immediate)', () => void setImmediate(() => {})],
    ['process.nextTick (TickObject)', () => process.nextTick(() => {})],
    [
      'callback-style fs.readFile (FSREQCALLBACK)',
      () => fs.readFile(path.join(dir, 'data'), () => {}),
    ],
  ]

  it.each(schedulers)('%s started inside the callback is refused as in-pure-callback', (_n, go) => {
    const error = thrown(() =>
      runPureCallback(() => {
        go()
        return 1
      })
    )
    expectKind(error, 'in-pure-callback')
  })

  it('control: a callback that schedules nothing returns its value', () => {
    expect(runPureCallback(() => 7)).toBe(7)
  })
})

describe('a refusal the callback caught still refuses the callback', () => {
  it('a synchronous lock request caught inside try/catch makes runPureCallback throw in-pure-callback', () => {
    let caught: unknown
    const error = thrown(() =>
      runPureCallback(() => {
        try {
          checkLockRequest(target('swallowed'), 'sync check', 'unordered')
        } catch (e) {
          caught = e
        }
        return 1
      })
    )
    expectKind(caught, 'in-pure-callback') // the request really was refused, and swallowed
    expectKind(error, 'in-pure-callback') // and the callback is refused anyway
  })
})

describe('the held set passes through into the callback', () => {
  it('inside a rank 1 lock, the planning guard throws held-while-planning from within the callback', async () => {
    let inside: unknown = 'unset'
    await withFileLock(
      target('root'),
      'root',
      async () => {
        inside = thrown(() =>
          runPureCallback(() => {
            assertSkillWriteLockNotHeld('in callback')
            return 1
          })
        )
      },
      { rank: '1' }
    )
    expectKind(inside, 'held-while-planning')
  })

  it('control: the same callback outside any lock passes', () => {
    expect(
      runPureCallback(() => {
        assertSkillWriteLockNotHeld('free')
        return 1
      })
    ).toBe(1)
  })
})

describe('the scope closes when the callback returns', () => {
  // INTENDED BEHAVIOUR, pinned on purpose (owner decision): work that inherited
  // the pure store but runs after the callback returned, through a path the
  // watch cannot see (callback-style crypto.randomBytes is outside
  // SCHEDULING_TYPES), is a known gap in what the watch can detect. Once the
  // callback has returned, such work is admitted like any other work; it is not
  // refused retroactively as "in a pure callback".
  it('a lock requested by unwatched work after the callback returned is admitted normally', async () => {
    let late: { error: unknown; ran: boolean } | undefined
    let finish: () => void = () => {}
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    const refused = thrown(() =>
      runPureCallback(() => {
        crypto.randomBytes(4, () => {
          let ran = false
          withFileLock(
            target('late'),
            'late',
            async () => {
              ran = true
            },
            { rank: 'unordered' }
          ).then(
            () => {
              late = { error: undefined, ran }
              finish()
            },
            (error: unknown) => {
              late = { error, ran }
              finish()
            }
          )
        })
        return 1
      })
    )
    expect(refused).toBeUndefined() // not refused: the watch does not see this type
    await done
    expect(late?.error).toBeUndefined()
    expect(late?.ran).toBe(true)
  })
})

describe('a nested runPureCallback leaves the outer callback watched', () => {
  it('async work started in the outer callback AFTER a nested runPureCallback returned is still refused', () => {
    const error = thrown(() =>
      runPureCallback(() => {
        runPureCallback(() => 1)
        setImmediate(() => {})
        return 1
      })
    )
    expectKind(error, 'in-pure-callback')
  })

  it('the watch is off again once the outermost callback returns', async () => {
    runPureCallback(() => {
      runPureCallback(() => 1)
      return 1
    })
    // Scheduling outside any callback is not refused and not recorded.
    let ran = false
    setImmediate(() => {
      ran = true
    })
    await sleep(20)
    expect(ran).toBe(true)
    expect(runPureCallback(() => 2)).toBe(2) // and a later callback starts clean
  })
})
