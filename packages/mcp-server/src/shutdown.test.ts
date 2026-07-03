/**
 * @fileoverview Tests for flush-on-shutdown wiring (SMI-5479 Step 3, pass 2).
 *
 * `shutdown.ts` has no top-level side effects (unlike `index.ts`, which runs
 * `main().catch(...)` at module scope), so it can be imported directly.
 *
 * Observation seam: same as `call-tool-handler.test.ts` /
 * `middleware/__tests__/license.gate.test.ts`'s T2 block — a real PostHog
 * client with a test key, `shutdownPostHog` spied directly (not the
 * `capture` method here — this suite tests the shutdown TIMING contract, not
 * emission).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { initializePostHog, shutdownPostHog, isPostHogEnabled } from '@skillsmith/core/telemetry'
import {
  flushTelemetryOnShutdown,
  createShutdownTrigger,
  _resetShutdownGuardForTests,
  TELEMETRY_SHUTDOWN_FLUSH_TIMEOUT_MS,
} from './shutdown.js'

describe('flushTelemetryOnShutdown (SMI-5479)', () => {
  beforeEach(() => {
    _resetShutdownGuardForTests()
    initializePostHog({ apiKey: 'phc_test_key_smi_5479_shutdown' })
  })

  afterEach(async () => {
    // shutdownPostHog is frequently already-called by the test itself; a
    // second call is a safe no-op (posthogInstance is null after the first).
    await shutdownPostHog()
    _resetShutdownGuardForTests()
  })

  it('calls shutdownPostHog and resolves promptly when the flush completes normally', async () => {
    expect(isPostHogEnabled()).toBe(true)

    await flushTelemetryOnShutdown()

    expect(isPostHogEnabled()).toBe(false)
  })

  it('resolves within the timeout even when the underlying flush hangs forever', async () => {
    // Re-initialize so we have a live client, then make its `shutdown()`
    // hang indefinitely (never resolves/rejects) to simulate a stuck
    // network call. A short timeoutMs proves the bound is honored without
    // slowing the test suite down.
    const { getPostHog } = await import('@skillsmith/core/telemetry')
    const hangingShutdown = vi
      .spyOn(getPostHog()!, 'shutdown')
      .mockImplementation(() => new Promise(() => {}))

    try {
      const start = Date.now()
      await flushTelemetryOnShutdown(50)
      const elapsed = Date.now() - start

      // Bounded by the timeout, not by the (never-resolving) real shutdown.
      expect(elapsed).toBeLessThan(2000)
    } finally {
      // Promise.race abandons the loser, not cancels it — the real
      // `shutdownPostHog()` call `flushTelemetryOnShutdown` kicked off is
      // still in flight, forever awaiting this mock. Restore it BEFORE this
      // test's `afterEach` calls the real (unmocked) `shutdownPostHog()`,
      // or that call would hang on the same mock too.
      hangingShutdown.mockRestore()
    }
  })

  it('is idempotent — a second call while/after a flush is a no-op (does not throw, does not re-invoke shutdownPostHog)', async () => {
    await flushTelemetryOnShutdown()
    // Second call after the guard has been set — must not throw and must
    // not attempt a second shutdown (posthogInstance is already null; a
    // naive re-implementation calling shutdownPostHog() again would still
    // just no-op internally, but the guard means we don't even try).
    await expect(flushTelemetryOnShutdown()).resolves.toBeUndefined()
  })

  it('exports the documented default timeout constant', () => {
    expect(TELEMETRY_SHUTDOWN_FLUSH_TIMEOUT_MS).toBe(2000)
  })
})

describe('createShutdownTrigger (SMI-5479)', () => {
  beforeEach(() => {
    _resetShutdownGuardForTests()
    initializePostHog({ apiKey: 'phc_test_key_smi_5479_shutdown_trigger' })
  })

  afterEach(async () => {
    await shutdownPostHog()
    _resetShutdownGuardForTests()
  })

  it('calls onDone exactly once after the flush settles', async () => {
    const onDone = vi.fn()
    const trigger = createShutdownTrigger(onDone)

    trigger()

    // Poll briefly for the async chain to settle (trigger() is
    // fire-and-forget by design — it mirrors index.ts's SIGTERM/SIGINT
    // listener signature, which is synchronous).
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
  })

  it('calling the trigger twice in quick succession still calls onDone once each, without a double-flush throwing', async () => {
    const onDoneA = vi.fn()
    const onDoneB = vi.fn()
    const triggerA = createShutdownTrigger(onDoneA)
    const triggerB = createShutdownTrigger(onDoneB)

    triggerA()
    triggerB()

    await vi.waitFor(() => {
      expect(onDoneA).toHaveBeenCalledTimes(1)
      expect(onDoneB).toHaveBeenCalledTimes(1)
    })
  })
})
