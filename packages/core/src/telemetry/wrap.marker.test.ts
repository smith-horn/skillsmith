/**
 * SMI-5456: withTelemetry agent-mediation marker threading + Tier-2 framework
 * emission. Sibling to `wrap.test.ts` (split per the 500-line file gate).
 *
 * Covers:
 *   - marker context threaded into the emitted payload (via runWithMarkerContext)
 *   - defaults false / false / null outside any marker scope
 *   - consent parity (suppressed gate emits nothing, marker or not)
 *   - concurrent no-bleed (P-5 invariant) — parallel calls each emit their
 *     OWN marker; an unscoped call stays neutral while others' scopes are live
 *   - per-framework emission incl. the opencode / hermes enum additions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { withTelemetry, setEmissionGate, runWithMarkerContext } from './wrap.js'

vi.mock('./posthog.js', () => ({
  trackSkillInvoke: vi.fn(),
}))

import { trackSkillInvoke } from './posthog.js'
const mockTrack = vi.mocked(trackSkillInvoke)

beforeEach(() => {
  mockTrack.mockReset()
  // Default-suppress since SMI-5019 — install a permissive gate so emit-path
  // assertions below observe behaviour. Consent-parity case overrides per-test.
  setEmissionGate(() => true)
})

afterEach(() => {
  setEmissionGate(undefined)
  // Marker context needs no reset: AsyncLocalStorage auto-scopes to each
  // runWithMarkerContext callback, so nothing can leak across tests.
})

const BASE_OPTS = {
  source: 'mcp-tool' as const,
  extractSkillId: () => 'test/skill',
}

// ---------------------------------------------------------------------------
// Marker threading
// ---------------------------------------------------------------------------

describe('agent-mediation marker threading', () => {
  it('threads the scoped marker context into the emitted payload', async () => {
    const handler = () => 'ok'
    const wrapped = withTelemetry(handler as unknown as (...a: unknown[]) => unknown, BASE_OPTS)

    await runWithMarkerContext({ agentSession: true, nudgeOrigin: true, triggerId: 'T-42' }, () =>
      (wrapped as unknown as () => Promise<unknown>)()
    )

    expect(mockTrack).toHaveBeenCalledWith(
      expect.objectContaining({ agentSession: true, nudgeOrigin: true, triggerId: 'T-42' })
    )
  })

  it('defaults to false / false / null when called outside any marker scope', async () => {
    const handler = () => 'ok'
    const wrapped = withTelemetry(handler as unknown as (...a: unknown[]) => unknown, BASE_OPTS)
    await (wrapped as unknown as () => Promise<unknown>)()

    expect(mockTrack).toHaveBeenCalledWith(
      expect.objectContaining({ agentSession: false, nudgeOrigin: false, triggerId: null })
    )
  })

  it('consent parity — marker fields never emit when the gate suppresses', async () => {
    // The marker scope is live, but consent is OFF. The event (and therefore
    // the new fields) must not be emitted at all.
    setEmissionGate(() => false)

    const handler = () => 'ok'
    const wrapped = withTelemetry(handler as unknown as (...a: unknown[]) => unknown, BASE_OPTS)
    await runWithMarkerContext({ agentSession: true, nudgeOrigin: true, triggerId: 'T-99' }, () =>
      (wrapped as unknown as () => Promise<unknown>)()
    )

    expect(mockTrack).not.toHaveBeenCalled()
  })

  it('concurrent tool calls do not bleed marker context (P-5 invariant)', async () => {
    // Failure mode this guards: with a module-scoped slot, call A's completion
    // clears call B's still-in-flight marker → B emits agent_session=false on
    // a genuinely mediated call, undercounting the mediation-gate metric.
    // Force the interleaving with manually-resolved promises: A starts first,
    // B starts second, A finishes (and emits) while B is still awaiting, then
    // B finishes — B's emit must still carry B's OWN marker.
    let releaseA!: () => void
    let releaseB!: () => void
    const blockA = new Promise<void>((r) => (releaseA = r))
    const blockB = new Promise<void>((r) => (releaseB = r))

    const emitted: Array<{ skillId: string; agentSession: boolean; triggerId: string | null }> = []
    mockTrack.mockImplementation((p) => {
      emitted.push({
        skillId: p.skillId,
        agentSession: p.agentSession ?? false,
        triggerId: p.triggerId ?? null,
      })
    })

    const handlerA = async () => {
      await blockA
      return 'A'
    }
    const handlerB = async () => {
      await blockB
      return 'B'
    }
    const wrappedA = withTelemetry(handlerA, { ...BASE_OPTS, extractSkillId: () => 'tool-a' })
    const wrappedB = withTelemetry(handlerB, { ...BASE_OPTS, extractSkillId: () => 'tool-b' })

    const callA = runWithMarkerContext(
      { agentSession: true, nudgeOrigin: false, triggerId: 'A' },
      () => wrappedA()
    )
    const callB = runWithMarkerContext(
      { agentSession: true, nudgeOrigin: true, triggerId: 'B' },
      () => wrappedB()
    )
    // A concurrent third call OUTSIDE any marker scope, also in flight.
    let releaseC!: () => void
    const blockC = new Promise<void>((r) => (releaseC = r))
    const wrappedC = withTelemetry(
      async () => {
        await blockC
        return 'C'
      },
      { ...BASE_OPTS, extractSkillId: () => 'tool-c' }
    )
    const callC = wrappedC()

    // A completes (and emits) FIRST, while B and C are still awaiting.
    releaseA()
    await callA
    // B completes next — its emit must read B's marker, not undefined/A's.
    releaseB()
    await callB
    // C completes last, outside any scope, while nothing else is live.
    releaseC()
    await callC

    expect(emitted).toEqual([
      { skillId: 'tool-a', agentSession: true, triggerId: 'A' },
      { skillId: 'tool-b', agentSession: true, triggerId: 'B' },
      { skillId: 'tool-c', agentSession: false, triggerId: null },
    ])
  })
})

// ---------------------------------------------------------------------------
// Per-framework emission incl. Tier-2 enum values
// ---------------------------------------------------------------------------

describe('per-framework emission (opencode / hermes)', () => {
  it.each(['opencode', 'hermes', 'claude-code', 'cursor'])(
    'emits framework=%s from extractFramework',
    async (fw) => {
      const handler = () => 'ok'
      const wrapped = withTelemetry(handler as unknown as (...a: unknown[]) => unknown, {
        ...BASE_OPTS,
        extractFramework: () => fw,
      })
      await (wrapped as unknown as () => Promise<unknown>)()

      expect(mockTrack).toHaveBeenLastCalledWith(expect.objectContaining({ framework: fw }))
    }
  )
})
