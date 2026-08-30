/**
 * SMI-6246: unit coverage for the lock-yield budget accounting and the
 * cron-side bounded retry loop (ADR-140's timing invariant), plus the
 * lock-skip handler that ties them together.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  computeRemainingElapsedMs,
  retryAcquireLock,
  isBackfillAcquisition,
  handleLockSkip,
  LOCK_RETRY_WINDOW_MS,
  releaseLockWithTimeout,
} from '../../indexer/run-lock-retry.ts'
import { normalizeYieldMinutes } from '../../indexer/parse-env.ts'
import type { IndexerEnv } from '../../indexer/parse-env.ts'

function baseEnv(overrides: Partial<IndexerEnv> = {}): IndexerEnv {
  return {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'key',
    CRON_SLOT: null,
    MAX_PAGES: 5,
    MAX_REPOS: 100,
    CODE_SEARCH_MAX_PAGES: 1,
    DRY_RUN: false,
    RUN_TYPE: 'discovery',
    STALE_DAYS: 30,
    RECHECK_THRESHOLD_DAYS: 5,
    RECHECK_MAX_CANDIDATES: 2000,
    RECHECK_BATCH: 5,
    RECHECK_DRY_RUN: true,
    DEQUARANTINE_DRY_RUN: true,
    PURGE_DRY_RUN: true,
    PURGE_LIMIT: undefined,
    concurrency: 2,
    kill_switch_engaged: false,
    DISCOVERY_PHASE: undefined,
    BACKFILL_MODE: false,
    BACKFILL_PATH_PREFIX: undefined,
    BACKFILL_MAX_RANGES: 150,
    BACKFILL_MIN_SIZE_BYTES: 0,
    BACKFILL_MAX_SKILLS_PER_DISPATCH: 0,
    BACKFILL_MAX_ELAPSED_MINUTES: 280,
    BACKFILL_ACCEPT_TRUNCATION: false,
    BACKFILL_LOCK_YIELD_MINUTES: 10,
    ...overrides,
  }
}

describe('SMI-6246: normalizeYieldMinutes (NaN-safe clamp)', () => {
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['zero', 0],
    ['negative', -5],
    ['below range', 0.5],
    ['above range', 46],
  ])('falls back to the default for %s', (_label, raw) => {
    expect(normalizeYieldMinutes(raw)).toBe(10)
  })

  it('accepts every value inside [1, 45]', () => {
    expect(normalizeYieldMinutes(1)).toBe(1)
    expect(normalizeYieldMinutes(45)).toBe(45)
    expect(normalizeYieldMinutes(22.5)).toBe(22.5)
  })

  it('honors a custom default', () => {
    expect(normalizeYieldMinutes(Number.NaN, 7)).toBe(7)
  })
})

describe('SMI-6246: computeRemainingElapsedMs — never resolves to the "unbounded" sentinel', () => {
  const lockAcquireAttemptedAt = 1_000_000

  it('BACKFILL_MAX_ELAPSED_MINUTES=0 no longer means unbounded — the yield ceiling still applies', () => {
    const ms = computeRemainingElapsedMs({
      backfillMaxElapsedMinutes: 0,
      yieldCeilingMinutes: 10,
      lockAcquireAttemptedAt,
      now: () => lockAcquireAttemptedAt,
    })
    expect(ms).toBe(10 * 60_000)
  })

  it('a negative BACKFILL_MAX_ELAPSED_MINUTES also cannot mean unbounded', () => {
    const ms = computeRemainingElapsedMs({
      backfillMaxElapsedMinutes: -1,
      yieldCeilingMinutes: 10,
      lockAcquireAttemptedAt,
      now: () => lockAcquireAttemptedAt,
    })
    expect(ms).toBe(10 * 60_000)
  })

  it('a positive BACKFILL_MAX_ELAPSED_MINUTES can still shrink the ceiling further (short test dispatch)', () => {
    const ms = computeRemainingElapsedMs({
      backfillMaxElapsedMinutes: 5,
      yieldCeilingMinutes: 10,
      lockAcquireAttemptedAt,
      now: () => lockAcquireAttemptedAt,
    })
    expect(ms).toBe(5 * 60_000)
  })

  it('a positive BACKFILL_MAX_ELAPSED_MINUTES larger than the ceiling is still capped at the ceiling', () => {
    const ms = computeRemainingElapsedMs({
      backfillMaxElapsedMinutes: 280,
      yieldCeilingMinutes: 10,
      lockAcquireAttemptedAt,
      now: () => lockAcquireAttemptedAt,
    })
    expect(ms).toBe(10 * 60_000)
  })

  it('deducts elapsed time since lock acquisition (prefetch/setup counts against the budget)', () => {
    const elapsedMs = 2 * 60_000
    const ms = computeRemainingElapsedMs({
      backfillMaxElapsedMinutes: 0,
      yieldCeilingMinutes: 10,
      lockAcquireAttemptedAt,
      now: () => lockAcquireAttemptedAt + elapsedMs,
    })
    expect(ms).toBe(10 * 60_000 - elapsedMs)
  })

  it('floors at 1000ms rather than returning the literal 0 "disabled" sentinel when prefetch alone exceeds the budget', () => {
    const ms = computeRemainingElapsedMs({
      backfillMaxElapsedMinutes: 0,
      yieldCeilingMinutes: 10,
      lockAcquireAttemptedAt,
      now: () => lockAcquireAttemptedAt + 20 * 60_000, // way past the 10-min ceiling
    })
    expect(ms).toBe(1000)
    expect(ms).not.toBe(0)
  })

  it('a NaN/out-of-range yield ceiling still resolves through normalizeYieldMinutes, never NaN', () => {
    const ms = computeRemainingElapsedMs({
      backfillMaxElapsedMinutes: 0,
      yieldCeilingMinutes: Number.NaN,
      lockAcquireAttemptedAt,
      now: () => lockAcquireAttemptedAt,
    })
    expect(ms).toBe(10 * 60_000)
    expect(Number.isNaN(ms)).toBe(false)
  })
})

describe('SMI-6246/ADR-140: retryAcquireLock', () => {
  function makeSupabase(sequence: Array<{ data?: boolean; error?: { message: string } | null }>) {
    let call = 0
    return {
      rpc: vi.fn().mockImplementation(() => {
        const result = sequence[Math.min(call, sequence.length - 1)]
        call += 1
        return Promise.resolve(result)
      }),
    }
  }

  it('acquires immediately when the first retry attempt succeeds', async () => {
    const supabase = makeSupabase([{ data: true, error: null }])
    const sleep = vi.fn().mockResolvedValue(undefined)
    const result = await retryAcquireLock(supabase as never, 'run-1', { sleep })
    expect(result).toEqual({ acquired: true, error: null })
    expect(sleep).not.toHaveBeenCalled()
  })

  it('retries across multiple misses before succeeding', async () => {
    const supabase = makeSupabase([
      { data: false, error: null },
      { data: false, error: null },
      { data: true, error: null },
    ])
    const sleep = vi.fn().mockResolvedValue(undefined)
    const result = await retryAcquireLock(supabase as never, 'run-1', { sleep, pollMs: 20_000 })
    expect(result).toEqual({ acquired: true, error: null })
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('exhausts the window and returns not-acquired without an error, per the existing skip contract', async () => {
    const supabase = makeSupabase([{ data: false, error: null }])
    let elapsed = 0
    const now = () => elapsed
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      elapsed += ms
    })
    const result = await retryAcquireLock(supabase as never, 'run-1', {
      windowMs: 60_000,
      pollMs: 20_000,
      sleep,
      now,
    })
    expect(result).toEqual({ acquired: false, error: null })
  })

  it('propagates an RPC error immediately rather than continuing to retry', async () => {
    const supabase = makeSupabase([{ data: false, error: { message: 'boom' } }])
    const sleep = vi.fn().mockResolvedValue(undefined)
    const result = await retryAcquireLock(supabase as never, 'run-1', { sleep })
    expect(result).toEqual({ acquired: false, error: 'boom' })
    expect(sleep).not.toHaveBeenCalled()
  })

  it('always makes a final attempt at (not after) the deadline — the invariant proof requires this', async () => {
    // 3 misses spaced further apart than the window, forcing the "final
    // attempt at the boundary" branch (remaining <= 0 only checked AFTER an
    // attempt, so the deadline-boundary attempt itself still happens).
    const supabase = makeSupabase([
      { data: false, error: null },
      { data: false, error: null },
      { data: true, error: null },
    ])
    let elapsed = 0
    const now = () => elapsed
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      elapsed += ms
    })
    const result = await retryAcquireLock(supabase as never, 'run-1', {
      windowMs: 25_000, // one full 20s poll cycle, then only 5s remains before the deadline
      pollMs: 20_000,
      sleep,
      now,
    })
    expect(result.acquired).toBe(true)
    // Confirms the loop slept the REMAINING time (5s), not a full 20s poll,
    // on its last cycle before the successful final attempt.
    expect(sleep).toHaveBeenLastCalledWith(5_000)
  })

  it('defaults to the documented window/poll constants', async () => {
    const supabase = makeSupabase([{ data: false, error: null }])
    let elapsed = 0
    const now = () => elapsed
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      elapsed += ms
      // Bail after one iteration by racing past the default window.
      elapsed += LOCK_RETRY_WINDOW_MS
    })
    const result = await retryAcquireLock(supabase as never, 'run-1', { sleep, now })
    expect(result).toEqual({ acquired: false, error: null })
  })

  // pr-reviewer round-2 finding: round-1's raceWithTimeout fix bounded each
  // attempt by a fixed attemptTimeoutMs, but always granted a FULL fresh
  // attemptTimeoutMs regardless of how little of the retry window remained
  // -- so a stalled attempt starting just before the deadline could still
  // run up to attemptTimeoutMs PAST it, contradicting this function's own
  // "never after the deadline" guarantee (the docstring above, and the
  // preceding test). Capping each attempt to the remaining budget (checked
  // BEFORE the attempt starts, not just before the sleep after it) closes
  // that gap. This needs real fake timers, since raceWithTimeout's internal
  // timeout always uses the real global setTimeout (it is not one of the
  // injectable sleep/now hooks the rest of this describe block uses).
  describe('bounds a stalled attempt to the remaining deadline, not a fresh full attemptTimeoutMs', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('settles within the remaining window even when the RPC call never resolves', async () => {
      const rpc = vi.fn().mockImplementation(() => new Promise(() => {})) // stalls forever
      const supabase = { rpc }

      let settled = false
      const resultPromise = retryAcquireLock(supabase as never, 'run-1', {
        windowMs: 50,
        pollMs: 20,
        attemptTimeoutMs: 10_000,
        now: () => Date.now(),
      }).then((r) => {
        settled = true
        return r
      })

      // Only the REMAINING window (50ms) should be needed to settle -- if
      // the attempt still used the full 10s attemptTimeoutMs regardless of
      // the deadline (the round-2 bug), the promise would still be pending
      // after only 50ms and this assertion would fail.
      await vi.advanceTimersByTimeAsync(50)
      expect(settled).toBe(true)

      const result = await resultPromise
      expect(result).toEqual({ acquired: false, error: null })
      expect(rpc).toHaveBeenCalledTimes(1) // never got to a second attempt
    })
  })

  // pr-reviewer round-3 finding: a real setTimeout can wake LATE (ordinary
  // event-loop scheduling slack) but never early, so the sleep between
  // attempts can resolve after `deadline` has already passed -- meaning the
  // loop's next attempt technically *starts* slightly after the boundary,
  // not exactly at it. This uses the injectable sleep/now hooks (not fake
  // timers) to simulate that overshoot directly and prove the actual
  // guarantee: once that late-starting attempt begins, it is capped to an
  // effectively-zero timeout rather than the full attemptTimeoutMs, so it
  // can never itself compound the overshoot into something meaningful.
  it('a late-firing sleep that lands past the deadline still resolves promptly, never blocking on the full attemptTimeoutMs', async () => {
    const rpc = vi.fn().mockImplementation(() => new Promise(() => {})) // stalls forever
    let elapsed = 0
    const now = () => elapsed
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      // A real setTimeout only ever wakes AT OR AFTER its requested delay --
      // simulate ordinary event-loop scheduling slack by overshooting past
      // what was requested, landing after the deadline before the next
      // attempt even starts.
      elapsed += ms + 25
    })
    const result = await retryAcquireLock({ rpc } as never, 'run-1', {
      windowMs: 50,
      pollMs: 50,
      attemptTimeoutMs: 10_000,
      sleep,
      now,
    })
    // The loop must still return promptly rather than waiting out the full
    // (uncapped) attemptTimeoutMs on the deadline-overshooting attempt.
    expect(result).toEqual({ acquired: false, error: null })
  })
})

describe('SMI-6246: isBackfillAcquisition', () => {
  it('is true only for a discovery run in backfill mode', () => {
    expect(isBackfillAcquisition({ RUN_TYPE: 'discovery', BACKFILL_MODE: true })).toBe(true)
  })

  it.each([
    ['discovery, not backfill mode', { RUN_TYPE: 'discovery' as const, BACKFILL_MODE: false }],
    ['maintenance', { RUN_TYPE: 'maintenance' as const, BACKFILL_MODE: false }],
    ['recheck', { RUN_TYPE: 'recheck' as const, BACKFILL_MODE: false }],
  ])('is false for %s', (_label, env) => {
    expect(isBackfillAcquisition(env)).toBe(false)
  })
})

describe('SMI-6246: releaseLockWithTimeout', () => {
  it('returns no error on a clean release', async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ error: null }) }
    const result = await releaseLockWithTimeout(supabase as never, 'run-1')
    expect(result).toEqual({ error: null })
  })

  it('retries once after a timeout, succeeding on the second attempt', async () => {
    const supabase = {
      rpc: vi
        .fn()
        .mockImplementationOnce(() => new Promise(() => {})) // never resolves -> times out
        .mockImplementationOnce(() => Promise.resolve({ error: null })),
    }
    const result = await releaseLockWithTimeout(supabase as never, 'run-1', 10)
    expect(result).toEqual({ error: null })
    expect(supabase.rpc).toHaveBeenCalledTimes(2)
  })

  it('reports an error if both attempts fail', async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ error: { message: 'release failed' } }),
    }
    const result = await releaseLockWithTimeout(supabase as never, 'run-1', 10)
    expect(result.error).toBeTruthy()
  })
})

describe('SMI-6246: handleLockSkip', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined as never) as typeof process.exit)
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.INDEXER_LOCK_RETRY_DISABLE
    delete process.env.GITHUB_RUN_ID
    delete process.env.RESUME_FROM
  })

  it('a non-backfill run retries and, on success, returns without exiting', async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
      from: vi.fn(),
    }
    const result = await handleLockSkip(
      supabase as never,
      baseEnv({ RUN_TYPE: 'maintenance' }),
      'req-1'
    )
    expect(result).toEqual({ acquired: true })
    expect(exitSpy).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalled()
  })

  it('INDEXER_LOCK_RETRY_DISABLE=1 skips the retry entirely and falls straight to the existing exit(0) path', async () => {
    process.env.INDEXER_LOCK_RETRY_DISABLE = '1'
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null })
    const insert = vi.fn().mockResolvedValue({ error: null })
    const supabase = { rpc, from: vi.fn().mockReturnValue({ insert }) }
    await handleLockSkip(supabase as never, baseEnv({ RUN_TYPE: 'maintenance' }), 'req-1')
    expect(rpc).not.toHaveBeenCalled() // never even attempted a retry
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it("backfill's own acquisition never retries, even when a retry would have succeeded", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null })
    const insert = vi.fn().mockResolvedValue({ error: null })
    const supabase = { rpc, from: vi.fn().mockReturnValue({ insert }) }
    await handleLockSkip(
      supabase as never,
      baseEnv({ RUN_TYPE: 'discovery', BACKFILL_MODE: true }),
      'req-1'
    )
    expect(rpc).not.toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('a backfill skip echoes github_run_id/resumed_from/dispatch_inputs into the audit row', async () => {
    process.env.GITHUB_RUN_ID = '123456'
    process.env.RESUME_FROM = 'latest'
    const insert = vi.fn().mockResolvedValue({ error: null })
    const supabase = { rpc: vi.fn(), from: vi.fn().mockReturnValue({ insert }) }
    await handleLockSkip(
      supabase as never,
      baseEnv({ RUN_TYPE: 'discovery', BACKFILL_MODE: true }),
      'req-1'
    )
    expect(insert).toHaveBeenCalledTimes(1)
    // writeIndexerAuditLog nests the skip-branch's meta object under
    // metadata.meta, not metadata directly (metadata's other keys are the
    // AuditLogParams envelope, e.g. found/indexed/updated).
    const insertedMeta = insert.mock.calls[0][0].metadata.meta
    expect(insertedMeta.github_run_id).toBe('123456')
    expect(insertedMeta.resumed_from).toBe('latest')
    expect(insertedMeta.dispatch_inputs).toBeDefined()
    expect(insertedMeta.dispatch_inputs.maxRanges).toBe(150)
  })

  it('a non-backfill skip does NOT carry github_run_id/resumed_from/dispatch_inputs', async () => {
    process.env.INDEXER_LOCK_RETRY_DISABLE = '1' // skip the retry loop entirely for this test
    const insert = vi.fn().mockResolvedValue({ error: null })
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: false, error: null }),
      from: vi.fn().mockReturnValue({ insert }),
    }
    await handleLockSkip(supabase as never, baseEnv({ RUN_TYPE: 'maintenance' }), 'req-1')
    const insertedMeta = insert.mock.calls[0][0].metadata.meta
    expect(insertedMeta.github_run_id).toBeUndefined()
    expect(insertedMeta.resumed_from).toBeUndefined()
    expect(insertedMeta.dispatch_inputs).toBeUndefined()
    expect(insertedMeta.status).toBe('skipped_lock')
  })

  it('an RPC error during retry hard-fails with exit(1)', async () => {
    // Note: process.exit is mocked as a no-op for testability (matching this
    // repo's established pattern), so unlike a real process it does not halt
    // execution here — this test only asserts the hard-fail signal fires with
    // the right code, matching main()'s pre-existing top-level error path,
    // which is not itself tested for post-exit fall-through either.
    const rpc = vi.fn().mockResolvedValue({ data: false, error: { message: 'db down' } })
    const supabase = {
      rpc,
      from: vi.fn().mockReturnValue({ insert: vi.fn().mockResolvedValue({ error: null }) }),
    }
    await handleLockSkip(supabase as never, baseEnv({ RUN_TYPE: 'maintenance' }), 'req-1')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
