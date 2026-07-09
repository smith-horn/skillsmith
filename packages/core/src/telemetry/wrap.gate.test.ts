/**
 * SMI-5479: `runWithEmissionGate` (AsyncLocalStorage emission gate) unit +
 * concurrency coverage. Sibling to `wrap.test.ts` (split per the 500-line file
 * gate); the pre-SMI-5479 module-`let` emission-gate cases stay in
 * `wrap.test.ts` §9 untouched, proving the retained fallback's zero churn.
 *
 * Covers:
 *   - T5: `runWithEmissionGate` unit — basic emit/suppress, nested scopes
 *     (inner shadows outer), auto-unwind on return AND on throw,
 *     ALS-store-beats-module-`let` precedence, fallback to the module `let`
 *     when no store is present, and the false-shadow pin
 *     (`setEmissionGate(() => true)` + active `runWithEmissionGate(false, …)`
 *     → zero emit — pins `??` vs `||` at the emit read; an accidental `||`
 *     would leak emission from a consent-off call).
 *   - T3: parallel no-bleed for the GATE (P-5 heart) — manually-resolved
 *     promises interleave one scope's exit against an in-flight call in another
 *     scope; the in-flight call still emits per ITS OWN scope. The committed
 *     regression pin for the `wrap.ts` ALS-precedence read — it fails if that
 *     read is ever reverted to consult the module `let` only.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { withTelemetry, setEmissionGate, runWithEmissionGate } from './wrap.js'

vi.mock('./posthog.js', () => ({
  trackSkillInvoke: vi.fn(),
}))

// SMI-5615: test seam for the Wave-2 `logging/redact.ts` module — see
// wrap.test.ts for rationale.
vi.mock('../logging/redact.js', () => ({
  redactSensitiveData: (s: string) => s,
}))

import { trackSkillInvoke } from './posthog.js'
const mockTrack = vi.mocked(trackSkillInvoke)

beforeEach(() => {
  mockTrack.mockReset()
  // No module `let` gate by default — the ALS scope is the unit under test.
  // Cases that exercise the fallback / false-shadow install one explicitly.
  setEmissionGate(undefined)
})

afterEach(() => {
  setEmissionGate(undefined)
  // The ALS gate needs no reset — `runWithEmissionGate` auto-scopes to its
  // callback, so nothing can leak across tests.
})

const BASE_OPTS = {
  source: 'mcp-tool' as const,
  extractSkillId: () => 'test/skill',
}

// ---------------------------------------------------------------------------
// T5 — runWithEmissionGate unit
// ---------------------------------------------------------------------------

describe('runWithEmissionGate (T5 — ALS emission gate)', () => {
  it('emits inside a runWithEmissionGate(true) scope', async () => {
    const wrapped = withTelemetry(() => 'ok', BASE_OPTS)
    await runWithEmissionGate(true, () => wrapped())
    expect(mockTrack).toHaveBeenCalledOnce()
  })

  it('suppresses inside a runWithEmissionGate(false) scope', async () => {
    const wrapped = withTelemetry(() => 'ok', BASE_OPTS)
    await runWithEmissionGate(false, () => wrapped())
    expect(mockTrack).not.toHaveBeenCalled()
  })

  it('nested scopes — inner false shadows outer true (no emit)', async () => {
    const wrapped = withTelemetry(() => 'ok', BASE_OPTS)
    await runWithEmissionGate(true, () => runWithEmissionGate(false, () => wrapped()))
    expect(mockTrack).not.toHaveBeenCalled()
  })

  it('nested scopes — inner true shadows outer false (emit)', async () => {
    const wrapped = withTelemetry(() => 'ok', BASE_OPTS)
    await runWithEmissionGate(false, () => runWithEmissionGate(true, () => wrapped()))
    expect(mockTrack).toHaveBeenCalledOnce()
  })

  it('auto-unwinds on return — a call after the scope resolves falls back to default-suppress', async () => {
    const wrapped = withTelemetry(() => 'ok', BASE_OPTS)
    await runWithEmissionGate(true, () => wrapped())
    expect(mockTrack).toHaveBeenCalledOnce()

    mockTrack.mockReset()
    // Outside the scope now — no module gate installed → default-suppress.
    await wrapped()
    expect(mockTrack).not.toHaveBeenCalled()
  })

  it('auto-unwinds on throw — the scope does not leak to a later out-of-scope call', async () => {
    const boom = withTelemetry((): never => {
      throw new Error('handler exploded')
    }, BASE_OPTS)

    await expect(runWithEmissionGate(true, () => boom())).rejects.toThrow('handler exploded')
    // The throwing call itself emits (success:false) — the `finally` runs inside
    // the still-live scope.
    expect(mockTrack).toHaveBeenCalledOnce()
    expect(mockTrack).toHaveBeenCalledWith(expect.objectContaining({ success: false }))

    mockTrack.mockReset()
    // The scope has unwound — a later out-of-scope call must not inherit `true`.
    const wrapped = withTelemetry(() => 'ok', BASE_OPTS)
    await wrapped()
    expect(mockTrack).not.toHaveBeenCalled()
  })

  it('ALS store beats the module `let` — store true wins over a module-`let` false', async () => {
    setEmissionGate(() => false)
    const wrapped = withTelemetry(() => 'ok', BASE_OPTS)
    await runWithEmissionGate(true, () => wrapped())
    expect(mockTrack).toHaveBeenCalledOnce()
  })

  it('false-shadow pin (`??` not `||`) — store false wins over a permissive module `let`', async () => {
    // The heart of the `??` vs `||` pin: a permissive module gate is installed,
    // but an active consent-OFF ALS scope must suppress. `||` would let the
    // module `true` leak emission from a consent-off call.
    setEmissionGate(() => true)
    const wrapped = withTelemetry(() => 'ok', BASE_OPTS)
    await runWithEmissionGate(false, () => wrapped())
    expect(mockTrack).not.toHaveBeenCalled()
  })

  it('falls back to the module `let` when no ALS scope is present (thunk true → emit)', async () => {
    setEmissionGate(() => true)
    const wrapped = withTelemetry(() => 'ok', BASE_OPTS)
    await wrapped()
    expect(mockTrack).toHaveBeenCalledOnce()
  })

  it('falls back to the module `let` when no ALS scope is present (thunk false → no emit)', async () => {
    setEmissionGate(() => false)
    const wrapped = withTelemetry(() => 'ok', BASE_OPTS)
    await wrapped()
    expect(mockTrack).not.toHaveBeenCalled()
  })

  it('default-suppress — no ALS scope and no module gate → no emit', async () => {
    const wrapped = withTelemetry(() => 'ok', BASE_OPTS)
    await wrapped()
    expect(mockTrack).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// T3 — parallel no-bleed for the GATE (P-5 heart; committed regression pin)
// ---------------------------------------------------------------------------

describe('parallel no-bleed for the emission gate (T3 — P-5 invariant)', () => {
  it('concurrent calls in different gate scopes each emit per their OWN scope', async () => {
    // Failure mode this guards: if the emit read ignored the ALS store (a
    // revert of the `wrap.ts` precedence read to the module `let` only), a
    // consent-ON call's emit would be governed by whatever shared state last
    // held — here call A's consent-OFF scope exiting mid-flight of B. Force the
    // interleaving with manually-resolved promises: A (gate OFF) and B (gate
    // ON) both start; A finishes (and must NOT emit) while B is still awaiting;
    // then B finishes and MUST still emit per its own ON scope.
    let releaseA!: () => void
    let releaseB!: () => void
    const blockA = new Promise<void>((r) => (releaseA = r))
    const blockB = new Promise<void>((r) => (releaseB = r))

    const emitted: string[] = []
    mockTrack.mockImplementation((p) => {
      emitted.push(p.skillId)
    })

    const wrappedA = withTelemetry(
      async () => {
        await blockA
        return 'A'
      },
      { ...BASE_OPTS, extractSkillId: () => 'tool-a' }
    )
    const wrappedB = withTelemetry(
      async () => {
        await blockB
        return 'B'
      },
      { ...BASE_OPTS, extractSkillId: () => 'tool-b' }
    )

    // A in a consent-OFF scope, B in a consent-ON scope, both in flight.
    const callA = runWithEmissionGate(false, () => wrappedA())
    const callB = runWithEmissionGate(true, () => wrappedB())

    // A completes (its `finally` runs inside A's OFF scope) while B still awaits.
    releaseA()
    await callA
    expect(emitted).toEqual([]) // A suppressed correctly; B not yet emitted.

    // B completes — its emit reads B's OWN ON scope, not A's exited OFF scope.
    releaseB()
    await callB

    expect(emitted).toEqual(['tool-b'])
  })

  it('a sibling ON call still emits after a nested (middleware-style) ON scope unwinds', async () => {
    // Models the double-gate reconciliation (Steps 2-3): an outer dispatch
    // scope (ON) drives call X through a NESTED runWithEmissionGate (the
    // middleware's own scope) that resolves and auto-unwinds first, while a
    // sibling direct-dispatch call Y (ON) is still in flight. Y's emit must
    // still fire — the inner scope's exit must not disturb Y's own scope.
    let releaseX!: () => void
    let releaseY!: () => void
    const blockX = new Promise<void>((r) => (releaseX = r))
    const blockY = new Promise<void>((r) => (releaseY = r))

    const emitted: string[] = []
    mockTrack.mockImplementation((p) => {
      emitted.push(p.skillId)
    })

    const wrappedX = withTelemetry(
      async () => {
        await blockX
        return 'X'
      },
      { ...BASE_OPTS, extractSkillId: () => 'tool-x' }
    )
    const wrappedY = withTelemetry(
      async () => {
        await blockY
        return 'Y'
      },
      { ...BASE_OPTS, extractSkillId: () => 'tool-y' }
    )

    // X: a nested ON scope inside an ON dispatch scope (the double-gate shape).
    const callX = runWithEmissionGate(true, () => runWithEmissionGate(true, () => wrappedX()))
    // Y: a sibling direct-dispatch ON scope, in flight.
    const callY = runWithEmissionGate(true, () => wrappedY())

    releaseX()
    await callX
    releaseY()
    await callY

    expect(emitted).toEqual(['tool-x', 'tool-y'])
  })
})
