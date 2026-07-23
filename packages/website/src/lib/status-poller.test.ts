import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  computeRovingTabindexMove,
  createStatusPoller,
  INITIAL_POLL_OUTCOME_STATE,
  nextPollOutcomeState,
  STALE_AFTER_CONSECUTIVE_FAILURES,
} from './status-poller'

// ---------------------------------------------------------------------------
// Roving-tabindex arithmetic (Codex #14)
// ---------------------------------------------------------------------------

describe('computeRovingTabindexMove', () => {
  it('ArrowRight advances, clamped at the last tile', () => {
    expect(computeRovingTabindexMove(0, 90, 'ArrowRight')).toBe(1)
    expect(computeRovingTabindexMove(89, 90, 'ArrowRight')).toBe(89)
  })

  it('ArrowLeft retreats, clamped at the first tile', () => {
    expect(computeRovingTabindexMove(5, 90, 'ArrowLeft')).toBe(4)
    expect(computeRovingTabindexMove(0, 90, 'ArrowLeft')).toBe(0)
  })

  it('Home jumps to 0, End jumps to the last tile', () => {
    expect(computeRovingTabindexMove(42, 90, 'Home')).toBe(0)
    expect(computeRovingTabindexMove(0, 90, 'End')).toBe(89)
  })

  it('an unrelated key returns null', () => {
    expect(computeRovingTabindexMove(5, 90, 'Tab')).toBeNull()
    expect(computeRovingTabindexMove(5, 90, 'a')).toBeNull()
  })

  it('an empty tile set returns null for any key', () => {
    expect(computeRovingTabindexMove(0, 0, 'ArrowRight')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Staleness tracking (Codex #10)
// ---------------------------------------------------------------------------

describe('nextPollOutcomeState', () => {
  it('a single transient failure does not flag stale', () => {
    let state = INITIAL_POLL_OUTCOME_STATE
    state = nextPollOutcomeState(state, false)
    expect(state.isStale).toBe(false)
    expect(state.consecutiveFailures).toBe(1)
  })

  it(`flags stale only after ${STALE_AFTER_CONSECUTIVE_FAILURES} consecutive failures`, () => {
    let state = INITIAL_POLL_OUTCOME_STATE
    for (let i = 0; i < STALE_AFTER_CONSECUTIVE_FAILURES - 1; i++) {
      state = nextPollOutcomeState(state, false)
      expect(state.isStale).toBe(false)
    }
    state = nextPollOutcomeState(state, false)
    expect(state.isStale).toBe(true)
    expect(state.consecutiveFailures).toBe(STALE_AFTER_CONSECUTIVE_FAILURES)
  })

  it('a success resets the counter and clears stale', () => {
    let state = { consecutiveFailures: STALE_AFTER_CONSECUTIVE_FAILURES, isStale: true }
    state = nextPollOutcomeState(state, true)
    expect(state).toEqual({ consecutiveFailures: 0, isStale: false })
  })

  it('a failure sandwiched between successes never accumulates toward stale', () => {
    let state = INITIAL_POLL_OUTCOME_STATE
    state = nextPollOutcomeState(state, false)
    state = nextPollOutcomeState(state, true)
    state = nextPollOutcomeState(state, false)
    expect(state.isStale).toBe(false)
    expect(state.consecutiveFailures).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Poll lifecycle controller (Codex #4)
// ---------------------------------------------------------------------------

describe('createStatusPoller', () => {
  const validPayload = {
    cached: false,
    data: { generated_at: 'x', overall_status: 'operational', components: [], incidents: [] },
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('start() fires an immediate fetch and reports success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => validPayload })
    const onResult = vi.fn()
    const onStaleChange = vi.fn()
    const poller = createStatusPoller(
      { apiUrl: 'https://example/status', fetchImpl },
      { onResult, onStaleChange }
    )

    poller.start()
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1))
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(onStaleChange).toHaveBeenLastCalledWith(false)
  })

  it('a single fetch failure does not flag stale; three in a row does', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'))
    const onResult = vi.fn()
    const onStaleChange = vi.fn()
    const poller = createStatusPoller(
      { apiUrl: 'https://example/status', fetchImpl, intervalMs: 1000 },
      { onResult, onStaleChange }
    )

    poller.start()
    await vi.waitFor(() => expect(onStaleChange).toHaveBeenCalledTimes(1))
    expect(onStaleChange).toHaveBeenLastCalledWith(false)

    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(onStaleChange).toHaveBeenCalledTimes(2))
    expect(onStaleChange).toHaveBeenLastCalledWith(false)

    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(onStaleChange).toHaveBeenCalledTimes(3))
    expect(onStaleChange).toHaveBeenLastCalledWith(true)

    expect(onResult).not.toHaveBeenCalled()
  })

  it('handleBeforeSwap aborts the in-flight fetch and discards a late response', async () => {
    let rejectFn: (reason: unknown) => void = () => {}
    const fetchImpl = vi.fn().mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectFn = reject
        })
    )
    const onResult = vi.fn()
    const onStaleChange = vi.fn()
    const poller = createStatusPoller(
      { apiUrl: 'https://example/status', fetchImpl },
      { onResult, onStaleChange }
    )

    poller.start()
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))

    poller.handleBeforeSwap()

    // Simulate the aborted fetch's promise rejecting (as a real AbortController would).
    rejectFn(new DOMException('aborted', 'AbortError'))
    await Promise.resolve()
    await Promise.resolve()

    expect(onResult).not.toHaveBeenCalled()
  })

  it('handleVisibilityHidden pauses the recursive-timeout loop', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => validPayload })
    const onResult = vi.fn()
    const onStaleChange = vi.fn()
    const poller = createStatusPoller(
      { apiUrl: 'https://example/status', fetchImpl, intervalMs: 1000 },
      { onResult, onStaleChange }
    )

    poller.start()
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1))

    poller.handleVisibilityHidden()
    await vi.advanceTimersByTimeAsync(5000)
    // No further polls fire while hidden/paused.
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    poller.handleVisibilityVisible()
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2))
  })
})
