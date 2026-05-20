import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { AuthTimeoutError, withAuthTimeout } from './auth-timeout'

describe('withAuthTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves with the inner value when the promise settles before the deadline', async () => {
    const inner = Promise.resolve({ session: { user: { id: 'u1' } } })
    await expect(withAuthTimeout(inner, 3000)).resolves.toEqual({ session: { user: { id: 'u1' } } })
  })

  it('throws AuthTimeoutError when the inner promise exceeds the deadline', async () => {
    const inner = new Promise<never>(() => {
      /* never resolves */
    })
    const racing = withAuthTimeout(inner, 3000, 'Sign-in service timed out')

    vi.advanceTimersByTime(3000)
    await expect(racing).rejects.toBeInstanceOf(AuthTimeoutError)
    await expect(racing).rejects.toMatchObject({
      isTimeout: true,
      message: 'Sign-in service timed out',
    })
  })

  it('propagates inner rejection without wrapping it', async () => {
    const innerErr = new Error('network down')
    const inner = Promise.reject(innerErr)
    await expect(withAuthTimeout(inner, 3000)).rejects.toBe(innerErr)
  })

  it('clears the timeout once the inner promise settles (no leaked timer)', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    const inner = Promise.resolve('ok')
    await withAuthTimeout(inner, 3000)
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })

  it('uses the default timeout message when none is provided', async () => {
    const racing = withAuthTimeout(new Promise<never>(() => {}), 100)
    vi.advanceTimersByTime(100)
    await expect(racing).rejects.toMatchObject({ message: 'Authentication service timed out' })
  })
})
