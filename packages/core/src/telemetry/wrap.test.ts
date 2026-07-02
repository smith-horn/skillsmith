/**
 * SMI-5016: Unit tests for withTelemetry HOF + isTelemetered registry.
 *
 * Covers the shared-state matrix invariants from plan line 720:
 *   - function-decl wrap
 *   - arrow-const export wrap (H3 critical case)
 *   - double-register idempotency (Set dedupes by reference)
 *   - isTelemetered true/false
 *   - emit-on-throw (success:false, then re-throw)
 *   - telemetry emit failure does NOT affect wrapped fn
 *   - per-request framework (H4 — not memoised)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { withTelemetry, isTelemetered, setEmissionGate } from './wrap.js'

// ---------------------------------------------------------------------------
// Mock trackSkillInvoke so tests run without a live PostHog instance
// ---------------------------------------------------------------------------

vi.mock('./posthog.js', () => ({
  trackSkillInvoke: vi.fn(),
}))

import { trackSkillInvoke } from './posthog.js'
const mockTrack = vi.mocked(trackSkillInvoke)

beforeEach(() => {
  mockTrack.mockReset()
  // SMI-5019 wire-in: default is now suppress-when-no-gate. Install a permissive
  // gate so the legacy SMI-5016 tests below (which predate the consent gate)
  // continue to assert against emit behaviour. The new emission-gate describe
  // block at the bottom overrides this per-case.
  setEmissionGate(() => true)
})

afterEach(() => {
  // Reset to default-suppress so a leaked gate from one test does not flow
  // into the next file's tests or pollute the per-process module state.
  setEmissionGate(undefined)
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_OPTS = {
  source: 'mcp-tool' as const,
  extractSkillId: () => 'test/skill',
}

// ---------------------------------------------------------------------------
// 1. Function-declaration wrap
// ---------------------------------------------------------------------------

describe('function-declaration wrap', () => {
  it('wraps a named function declaration and registers it', async () => {
    function myHandler(x: number): number {
      return x * 2
    }

    const wrapped = withTelemetry(myHandler as unknown as (...a: unknown[]) => unknown, BASE_OPTS)

    expect(isTelemetered(wrapped)).toBe(true)
    expect(isTelemetered(myHandler)).toBe(false)

    const result = await (wrapped as unknown as (x: number) => Promise<number>)(3)
    expect(result).toBe(6)
    expect(mockTrack).toHaveBeenCalledOnce()
    expect(mockTrack).toHaveBeenCalledWith(
      expect.objectContaining({ skillId: 'test/skill', success: true })
    )
  })
})

// ---------------------------------------------------------------------------
// 2. Arrow-const export wrap (H3 critical case)
// ---------------------------------------------------------------------------

describe('arrow-const export wrap', () => {
  it('wraps an arrow-const and registers the returned function (not the original)', async () => {
    // This is the exact pattern that plan review change H3 was about:
    // arrow-const exports cannot be mutated, so the registry MUST track the
    // returned wrappedFn, not mutate the original.
    const originalFn = (v: string): string => v.toUpperCase()

    const wrappedExport = withTelemetry(
      originalFn as unknown as (...a: unknown[]) => unknown,
      BASE_OPTS
    )

    // The returned function is telemetered; the original is not.
    expect(isTelemetered(wrappedExport)).toBe(true)
    expect(isTelemetered(originalFn)).toBe(false)

    const result = await (wrappedExport as unknown as (v: string) => Promise<string>)('hello')
    expect(result).toBe('HELLO')
    expect(mockTrack).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// 3. Double-register idempotency
// ---------------------------------------------------------------------------

describe('double-register', () => {
  it('re-wrapping the same RETURNED function adds no new entries (Set dedupes by ref)', () => {
    const original = () => 'value'

    const w1 = withTelemetry(original as unknown as (...a: unknown[]) => unknown, BASE_OPTS)

    // Capture Set size after first wrap
    expect(isTelemetered(w1)).toBe(true)

    // Now attempt to re-wrap the *returned* function.
    // The Set already contains w1, so adding it again is a no-op by Set semantics.
    const w2 = withTelemetry(w1, BASE_OPTS)

    // w2 is a NEW wrapper around w1 — both are in the Set, but w1 wasn't
    // added a second time.  isTelemetered(w1) is still true, and w2 is also true.
    expect(isTelemetered(w1)).toBe(true)
    expect(isTelemetered(w2)).toBe(true)
  })

  it('wrapping the same original fn twice produces two distinct wrapped fns, both registered', () => {
    const original = () => 'x'

    const wa = withTelemetry(original as unknown as (...a: unknown[]) => unknown, BASE_OPTS)
    const wb = withTelemetry(original as unknown as (...a: unknown[]) => unknown, BASE_OPTS)

    // Different wrapper references
    expect(wa).not.toBe(wb)
    expect(isTelemetered(wa)).toBe(true)
    expect(isTelemetered(wb)).toBe(true)
    // Original still not in registry
    expect(isTelemetered(original)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 4. isTelemetered true/false
// ---------------------------------------------------------------------------

describe('isTelemetered', () => {
  it('returns false for an arbitrary unwrapped function', () => {
    const plain = () => {}
    expect(isTelemetered(plain)).toBe(false)
  })

  it('returns true only for the wrapped return value', () => {
    const original = () => 42
    const result = withTelemetry(original as unknown as (...a: unknown[]) => unknown, BASE_OPTS)
    expect(isTelemetered(result)).toBe(true)
    expect(isTelemetered(original)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. Emit happens even on thrown errors
// ---------------------------------------------------------------------------

describe('emit-on-throw', () => {
  it('emits with success:false and re-throws when handler throws', async () => {
    const boom = (): never => {
      throw new Error('handler exploded')
    }

    const wrappedBoom = withTelemetry(boom as unknown as (...a: unknown[]) => unknown, BASE_OPTS)

    await expect((wrappedBoom as unknown as () => Promise<never>)()).rejects.toThrow(
      'handler exploded'
    )

    expect(mockTrack).toHaveBeenCalledOnce()
    expect(mockTrack).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, skillId: 'test/skill' })
    )
  })
})

// ---------------------------------------------------------------------------
// 6. Telemetry emission failure does NOT affect wrapped fn
// ---------------------------------------------------------------------------

describe('emit-failure survival', () => {
  it('returns the handler result even when trackSkillInvoke throws', async () => {
    mockTrack.mockImplementation(() => {
      throw new Error('PostHog is down')
    })

    const stable = () => 'still works'
    const wrappedStable = withTelemetry(
      stable as unknown as (...a: unknown[]) => unknown,
      BASE_OPTS
    )

    const result = await (wrappedStable as unknown as () => Promise<string>)()
    expect(result).toBe('still works')
    // trackSkillInvoke was called (and threw), but the wrapper swallowed it.
    expect(mockTrack).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// 7. Per-request framework value (H4 — not memoised)
// ---------------------------------------------------------------------------

describe('per-request framework', () => {
  it('reflects opts.extractFramework return value at each call independently', async () => {
    let frameValue = 'cursor'

    const handler = () => 'ok'
    const wrappedWithFramework = withTelemetry(handler as unknown as (...a: unknown[]) => unknown, {
      ...BASE_OPTS,
      extractFramework: () => frameValue,
    })

    await (wrappedWithFramework as unknown as () => Promise<unknown>)()
    expect(mockTrack).toHaveBeenLastCalledWith(expect.objectContaining({ framework: 'cursor' }))

    // Mutate the frame value — simulates a different client on the same server
    frameValue = 'copilot'
    mockTrack.mockReset()

    await (wrappedWithFramework as unknown as () => Promise<unknown>)()
    expect(mockTrack).toHaveBeenLastCalledWith(expect.objectContaining({ framework: 'copilot' }))
  })

  it('defaults framework to "unknown" when extractFramework is not provided', async () => {
    const handler = () => 'ok'
    const wrappedNoFrame = withTelemetry(
      handler as unknown as (...a: unknown[]) => unknown,
      BASE_OPTS // no extractFramework
    )

    await (wrappedNoFrame as unknown as () => Promise<unknown>)()
    expect(mockTrack).toHaveBeenCalledWith(expect.objectContaining({ framework: 'unknown' }))
  })
})

// ---------------------------------------------------------------------------
// 8. Overhead gate (Risk #7 — p99 < 1ms per wrapped call)
// ---------------------------------------------------------------------------

describe('overhead gate (risk #7)', () => {
  it('p99 per-call overhead is < 1ms over 10 000 iterations', async () => {
    const ITERATIONS = 10_000
    const noopHandler = async (): Promise<number> => 42

    const wrappedNoop = withTelemetry(noopHandler, {
      source: 'mcp-tool',
      extractSkillId: () => 'bench/skill',
    })

    // JIT warm-up — stabilise before measuring
    for (let i = 0; i < 100; i++) {
      await (wrappedNoop as unknown as () => Promise<unknown>)()
    }
    mockTrack.mockReset()

    const elapsed: number[] = []
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now()
      await (wrappedNoop as unknown as () => Promise<unknown>)()
      elapsed.push(performance.now() - t0)
    }

    elapsed.sort((a, b) => a - b)
    const p99 = elapsed[Math.ceil(ITERATIONS * 0.99) - 1]
    const mean = elapsed.reduce((s, v) => s + v, 0) / ITERATIONS

    // Risk #7 gate: p99 must be below 1ms
    expect(p99).toBeLessThan(1)
    // Sanity gate: mean overhead should be well below 0.5ms
    expect(mean).toBeLessThan(0.5)

    expect(mockTrack).toHaveBeenCalledTimes(ITERATIONS)
  })
})

// ---------------------------------------------------------------------------
// 9. Emission gate (SMI-5019 wire-in)
// ---------------------------------------------------------------------------
//
// These tests verify the privacy-safe default-suppress contract:
//
//   - No gate installed → withTelemetry must NOT call trackSkillInvoke
//   - Gate returns true → emit
//   - Gate returns false → suppress
//   - Gate is evaluated per-call (not memoised), so a toggling predicate
//     produces different outcomes on consecutive calls
//
// The outer `beforeEach` installs a permissive gate for the legacy tests;
// these cases override that gate explicitly per-case.
describe('emission gate (SMI-5019 wire-in)', () => {
  beforeEach(() => {
    // Override the outer permissive gate — start each case with no gate
    // installed, so the default-suppress behaviour is the natural baseline.
    setEmissionGate(undefined)
  })

  it('default-suppress: no gate installed → no emit', async () => {
    const handler = () => 'ok'
    const wrappedFn = withTelemetry(handler as unknown as (...a: unknown[]) => unknown, BASE_OPTS)

    const result = await (wrappedFn as unknown as () => Promise<string>)()

    expect(result).toBe('ok')
    expect(mockTrack).not.toHaveBeenCalled()
  })

  it('gate returns true → emit', async () => {
    setEmissionGate(() => true)

    const handler = () => 'ok'
    const wrappedFn = withTelemetry(handler as unknown as (...a: unknown[]) => unknown, BASE_OPTS)

    await (wrappedFn as unknown as () => Promise<string>)()

    expect(mockTrack).toHaveBeenCalledOnce()
    expect(mockTrack).toHaveBeenCalledWith(
      expect.objectContaining({ skillId: 'test/skill', success: true })
    )
  })

  it('gate returns false → no emit', async () => {
    setEmissionGate(() => false)

    const handler = () => 'ok'
    const wrappedFn = withTelemetry(handler as unknown as (...a: unknown[]) => unknown, BASE_OPTS)

    await (wrappedFn as unknown as () => Promise<string>)()

    expect(mockTrack).not.toHaveBeenCalled()
  })

  it('gate is evaluated per-call (toggling predicate produces emit then no-emit)', async () => {
    // Toggle true → false across the two invocations. Verifies the gate is
    // NOT memoised at install time — each call queries it fresh, matching
    // the per-call extractFramework contract (H4).
    let nextReturn = true
    setEmissionGate(() => {
      const value = nextReturn
      nextReturn = !nextReturn
      return value
    })

    const handler = () => 'ok'
    const wrappedFn = withTelemetry(handler as unknown as (...a: unknown[]) => unknown, BASE_OPTS)

    await (wrappedFn as unknown as () => Promise<string>)()
    expect(mockTrack).toHaveBeenCalledOnce()

    mockTrack.mockReset()

    await (wrappedFn as unknown as () => Promise<string>)()
    expect(mockTrack).not.toHaveBeenCalled()
  })

  it('gate is also consulted on throw — no emit when suppressed even if handler fails', async () => {
    // Reinforces the privacy-safe invariant: a throwing handler must not
    // smuggle telemetry past a suppressing gate via the finally block.
    setEmissionGate(() => false)

    const boom = (): never => {
      throw new Error('handler exploded')
    }
    const wrappedBoom = withTelemetry(boom as unknown as (...a: unknown[]) => unknown, BASE_OPTS)

    await expect((wrappedBoom as unknown as () => Promise<never>)()).rejects.toThrow(
      'handler exploded'
    )

    expect(mockTrack).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// SMI-5456 agent-mediation marker threading + opencode/hermes framework
// emission live in the sibling `wrap.marker.test.ts` (500-line file gate).
// ---------------------------------------------------------------------------
