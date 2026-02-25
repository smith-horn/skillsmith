/**
 * SMI-2754: TaskRunner Process Management Tests
 *
 * Tests for gracefulShutdown and killProcess covering all uncovered branches:
 * 1. gracefulShutdown: SIGTERM succeeds, process exits before grace (SIGKILL check throws ESRCH)
 * 2. gracefulShutdown: SIGTERM throws ESRCH → early return
 * 3. gracefulShutdown: SIGTERM succeeds, process still alive after grace → SIGKILL sent
 * 4. killProcess: SIGKILL succeeds (no throw)
 * 5. killProcess: throws ESRCH → silently swallowed
 * 6. killProcess: throws non-ESRCH error → re-throws
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { gracefulShutdown, killProcess } from '../TaskRunner.process.js'
import { SIGKILL_GRACE_PERIOD_MS } from '../TaskRunner.types.js'

describe('gracefulShutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('sends SIGTERM and does NOT send SIGKILL when process exits before grace period', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (signal === 'SIGTERM') return true
      // signal === 0 check: process already dead
      const err = Object.assign(new Error('ESRCH'), { code: 'ESRCH' }) as NodeJS.ErrnoException
      throw err
    })

    const promise = gracefulShutdown(12345)
    vi.advanceTimersByTime(SIGKILL_GRACE_PERIOD_MS + 100)
    await promise

    expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM')
    // SIGKILL should NOT have been called because signal-0 threw ESRCH
    const sigkillCalls = killSpy.mock.calls.filter(([, sig]) => sig === 'SIGKILL')
    expect(sigkillCalls).toHaveLength(0)
  })

  it('returns early without sleeping when SIGTERM itself throws ESRCH', async () => {
    const err = Object.assign(new Error('ESRCH'), { code: 'ESRCH' }) as NodeJS.ErrnoException
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw err
    })

    await gracefulShutdown(99999)

    // Only one call (SIGTERM), no grace period wait, no SIGKILL
    expect(killSpy).toHaveBeenCalledTimes(1)
    expect(killSpy).toHaveBeenCalledWith(99999, 'SIGTERM')
  })

  it('sends SIGKILL when process is still alive after grace period', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (signal === 'SIGTERM') return true
      if (signal === 0) return true // process still alive
      if (signal === 'SIGKILL') return true
      return true
    })

    const promise = gracefulShutdown(55555)
    vi.advanceTimersByTime(SIGKILL_GRACE_PERIOD_MS + 100)
    await promise

    expect(killSpy).toHaveBeenCalledWith(55555, 'SIGTERM')
    expect(killSpy).toHaveBeenCalledWith(55555, 0)
    expect(killSpy).toHaveBeenCalledWith(55555, 'SIGKILL')
  })
})

describe('killProcess', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('calls process.kill with SIGKILL and resolves without error', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)

    await expect(killProcess(11111)).resolves.toBeUndefined()

    expect(killSpy).toHaveBeenCalledWith(11111, 'SIGKILL')
  })

  it('silently swallows ESRCH error (process already dead)', async () => {
    const err = Object.assign(new Error('ESRCH'), { code: 'ESRCH' }) as NodeJS.ErrnoException
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw err
    })

    await expect(killProcess(22222)).resolves.toBeUndefined()
  })

  it('re-throws non-ESRCH errors', async () => {
    const err = Object.assign(new Error('EPERM'), { code: 'EPERM' }) as NodeJS.ErrnoException
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw err
    })

    await expect(killProcess(33333)).rejects.toThrow('EPERM')
  })
})
