/**
 * SMI-6531 (A1 step 1): `withFileLock` validates `options.rank` at runtime. The
 * type requires it, but an untyped caller (JS, a cast) must be refused too,
 * with a rejection (not a synchronous throw) and before any lock file is made.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withFileLock, type FileLockOptions } from '../../../src/config/file-lock.js'
import { LOCK_ORDERS } from '../../../src/config/lock-tracker.js'

let dir: string
let target: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-rank-validation-'))
  target = path.join(dir, 'data')
  fs.writeFileSync(target, 'x')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const bad: Array<[string, unknown]> = [
  ['missing options', undefined],
  ['null options', null],
  ['empty options', {}],
  ['an unknown rank string', { rank: '6' }],
  ['a rank of the wrong type', { rank: 2 }],
]

describe('withFileLock rejects a missing or unknown rank', () => {
  it.each(bad)(
    '%s rejects with a TypeError naming withFileLock, the label and the allowed ranks',
    async (_n, options) => {
      let ran = false
      let result: Promise<void> | undefined
      expect(() => {
        result = withFileLock(
          target,
          'my-label',
          async () => {
            ran = true
          },
          options as unknown as FileLockOptions
        )
      }).not.toThrow() // a rejection, not a synchronous throw
      const error = await result!.then(
        () => undefined,
        (e: unknown) => e
      )
      expect(error).toBeInstanceOf(TypeError)
      const message = (error as TypeError).message
      expect(message).toContain('withFileLock')
      expect(message).toContain('my-label')
      for (const rank of LOCK_ORDERS) expect(message).toContain(`'${rank}'`)
      expect(ran).toBe(false)
      expect(fs.existsSync(`${target}.lock`)).toBe(false)
    }
  )

  it('LOCK_ORDERS lists every rank the type allows', () => {
    expect([...LOCK_ORDERS].sort()).toEqual(
      ['1', "1'", '2a', '2b', '3', '4', '5', 'unordered'].sort()
    )
  })

  it.each(LOCK_ORDERS.map((r) => [r] as const))(
    'control: rank %s is accepted and runs the callback',
    async (rank) => {
      const value = await withFileLock(target, 'ok', async () => 42, { rank })
      expect(value).toBe(42)
    }
  )
})
