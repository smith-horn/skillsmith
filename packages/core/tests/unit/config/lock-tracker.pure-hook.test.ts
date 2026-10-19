/**
 * SMI-6531 (A1 step 1): `runPureCallback` drives its `async_hooks` watch
 * directly. The hook is observed through a pass-through wrapper (it stays
 * functional), because leaving it enabled is invisible to behaviour: with no
 * callback running, the hook records nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => [] as string[])

vi.mock('node:async_hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:async_hooks')>()
  return {
    ...actual,
    createHook: (callbacks: Parameters<typeof actual.createHook>[0]) => {
      const real = actual.createHook(callbacks)
      const wrapper = {
        enable() {
          calls.push('enable')
          real.enable()
          return wrapper
        },
        disable() {
          calls.push('disable')
          real.disable()
          return wrapper
        },
      }
      return wrapper
    },
  }
})

import { runPureCallback } from '../../../src/config/lock-tracker.js'

beforeEach(() => {
  calls.length = 0
})

describe('runPureCallback enables and disables the async watch', () => {
  it('a single callback enables the watch and leaves it disabled', () => {
    let during: string[] = []
    runPureCallback(() => {
      during = [...calls]
      return 1
    })
    expect(during).toEqual(['enable'])
    expect(calls.at(-1)).toBe('disable')
  })

  it('a nested callback returning does not disable the watch under the outer one; the outermost return does', () => {
    let afterNested: string[] = []
    runPureCallback(() => {
      runPureCallback(() => 1)
      afterNested = [...calls] // the outer callback is still running here
      return 1
    })
    expect(afterNested.length).toBeGreaterThan(0)
    expect(afterNested).not.toContain('disable')
    expect(afterNested.at(-1)).toBe('enable')
    expect(calls.at(-1)).toBe('disable')
  })

  it('the watch is disabled after a callback that throws', () => {
    expect(() =>
      runPureCallback(() => {
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(calls.at(-1)).toBe('disable')
  })
})
