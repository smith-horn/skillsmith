/**
 * SMI-6362 §1: `withTelemetry`'s second sink — a `tool_call` event dispatched
 * through `emitToolCallEvent` (`../audit/remote-audit.js`) alongside the
 * pre-existing `trackSkillInvoke` (PostHog `skill_invoke`) sink. Sibling to
 * `wrap.test.ts` (500-line file gate), matching the existing
 * `wrap.gate.test.ts` / `wrap.marker.test.ts` split convention for this file.
 *
 * The plan's AC-11 test-coverage row for "`wrap.ts` second sink" requires
 * proving, at the `withTelemetry` integration level (not re-testing
 * `emitToolCallEvent`'s own unit behaviour, already covered exhaustively by
 * `remote-audit.test.ts`):
 *   - gate-off ⇒ BOTH sinks stay silent, not just the legacy one (the D-1
 *     client-side invariant, asserted at the single enforcement point)
 *   - gate-on (with tool-name context installed) ⇒ both sinks fire
 *   - a transport-layer rejection from the second sink does not change the
 *     wrapped function's own return value or thrown errors
 *   - an identity provider returning `null` ⇒ no POST is attempted and
 *     `skippedNoIdentity` increments
 *
 * These tests exercise the REAL `remote-audit.js` (only `getOrCreateInstallId`
 * and global `fetch` are stubbed, matching `remote-audit.test.ts`'s own
 * convention) so they prove the actual wiring `wrap.ts` performs, not a
 * stand-in that could silently drift from it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { withTelemetry, setEmissionGate, runWithToolNameContext } from './wrap.js'

vi.mock('./posthog.js', () => ({
  trackSkillInvoke: vi.fn(),
}))

// SMI-5615: test seam for the Wave-2 `logging/redact.ts` module — see
// wrap.test.ts for rationale.
vi.mock('../logging/redact.js', () => ({
  redactSensitiveData: (s: string) => s,
}))

// The real implementation reads/writes `~/.skillsmith/config.json` under a
// file lock — unwanted disk I/O in a unit test. Matches
// remote-audit.test.ts's own convention exactly.
vi.mock('../config/device-identity.js', () => ({
  getOrCreateInstallId: vi.fn(() => 'a'.repeat(64)),
}))

import { trackSkillInvoke } from './posthog.js'
import {
  setTelemetryIdentityProvider,
  getTelemetryEmitStats,
  _resetTelemetryEmitStatsForTests,
} from '../audit/remote-audit.js'

const mockTrack = vi.mocked(trackSkillInvoke)

const TOOL_OPTS = {
  source: 'mcp-tool' as const,
  extractSkillId: () => 'test/skill',
}

const fetchSpy = vi.fn()

beforeEach(() => {
  mockTrack.mockReset()
  vi.stubGlobal('fetch', fetchSpy)
  fetchSpy.mockReset()
  fetchSpy.mockResolvedValue(
    new Response(null, { status: 200, headers: { 'X-Skillsmith-Telemetry-Accepted': '1' } })
  )
  _resetTelemetryEmitStatsForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
  setEmissionGate(undefined)
  setTelemetryIdentityProvider(null)
  _resetTelemetryEmitStatsForTests()
})

// Allow the fire-and-forget `void postTelemetryEvent(...).then(...)` chain
// inside `emitToolCallEvent` to actually run — it is not awaited by
// `wrap.ts` by design (fire-and-forget), so assertions on `fetchSpy` /
// `getTelemetryEmitStats()` need one microtask flush first.
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('second sink (tool_call via emitToolCallEvent, SMI-6362 §1)', () => {
  it('gate-off ⇒ both sinks stay silent, not just the legacy one', async () => {
    setEmissionGate(undefined) // default-suppress — no gate installed
    setTelemetryIdentityProvider(() => ({ accessToken: 'jwt-abc' }))

    const handler = () => 'ok'
    const wrapped = withTelemetry(handler as unknown as (...a: unknown[]) => unknown, TOOL_OPTS)

    await runWithToolNameContext('search', () => (wrapped as unknown as () => Promise<string>)())
    await flush()

    expect(mockTrack).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('gate-on with tool-name context installed ⇒ both sinks fire', async () => {
    setEmissionGate(() => true)
    setTelemetryIdentityProvider(() => ({ accessToken: 'jwt-abc' }))

    const handler = () => 'ok'
    const wrapped = withTelemetry(handler as unknown as (...a: unknown[]) => unknown, TOOL_OPTS)

    await runWithToolNameContext('search', () => (wrapped as unknown as () => Promise<string>)())
    await flush()

    expect(mockTrack).toHaveBeenCalledOnce()
    expect(fetchSpy).toHaveBeenCalledOnce()
    const body = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string) as {
      event: string
      metadata: Record<string, unknown>
    }
    expect(body.event).toBe('tool_call')
    expect(body.metadata).toMatchObject({ tool_name: 'search', success: true })
    expect(getTelemetryEmitStats().accepted).toBe(1)
  })

  it('no tool-name context installed ⇒ second sink never fires, legacy sink still does', async () => {
    // Guards the source-gating precondition itself: a `mcp-tool` call whose
    // dispatcher never installed `runWithToolNameContext` (e.g. a code path
    // reached outside `call-tool-handler.ts`) must not emit a `tool_call`
    // with an undefined tool name.
    setEmissionGate(() => true)
    setTelemetryIdentityProvider(() => ({ accessToken: 'jwt-abc' }))

    const handler = () => 'ok'
    const wrapped = withTelemetry(handler as unknown as (...a: unknown[]) => unknown, TOOL_OPTS)

    await (wrapped as unknown as () => Promise<string>)()
    await flush()

    expect(mockTrack).toHaveBeenCalledOnce()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('identity provider returns null ⇒ no POST is attempted and skippedNoIdentity increments', async () => {
    setEmissionGate(() => true)
    setTelemetryIdentityProvider(() => null)

    const handler = () => 'ok'
    const wrapped = withTelemetry(handler as unknown as (...a: unknown[]) => unknown, TOOL_OPTS)

    await runWithToolNameContext('search', () => (wrapped as unknown as () => Promise<string>)())
    await flush()

    // The legacy PostHog sink is unaffected by the second sink's identity gate.
    expect(mockTrack).toHaveBeenCalledOnce()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(getTelemetryEmitStats().skippedNoIdentity).toBe(1)
  })

  it("a transport-layer rejection from the second sink does not change the wrapped fn's return value", async () => {
    setEmissionGate(() => true)
    setTelemetryIdentityProvider(() => ({ accessToken: 'jwt-abc' }))
    fetchSpy.mockRejectedValueOnce(new Error('network down'))

    const handler = () => 'still works'
    const wrapped = withTelemetry(handler as unknown as (...a: unknown[]) => unknown, TOOL_OPTS)

    const result = await runWithToolNameContext('search', () =>
      (wrapped as unknown as () => Promise<string>)()
    )
    await flush()

    expect(result).toBe('still works')
    // postTelemetryEvent swallows the rejection internally and classifies it
    // as `failed` — it never surfaces to the caller.
    expect(getTelemetryEmitStats().failed).toBe(1)
  })

  it('a transport-layer rejection from the second sink does not change a thrown error', async () => {
    setEmissionGate(() => true)
    setTelemetryIdentityProvider(() => ({ accessToken: 'jwt-abc' }))
    fetchSpy.mockRejectedValueOnce(new Error('network down'))

    const boom = (): never => {
      throw new Error('handler exploded')
    }
    const wrappedBoom = withTelemetry(boom as unknown as (...a: unknown[]) => unknown, TOOL_OPTS)

    await expect(
      runWithToolNameContext('search', () => (wrappedBoom as unknown as () => Promise<never>)())
    ).rejects.toThrow('handler exploded')
    await flush()

    expect(mockTrack).toHaveBeenCalledWith(expect.objectContaining({ success: false }))
    expect(getTelemetryEmitStats().failed).toBe(1)
  })

  it('emitToolCallEvent throwing synchronously is swallowed by the same boundary that protects trackSkillInvoke', async () => {
    // A harder case than a rejected fetch: the sink itself throws
    // synchronously (e.g. a future refactor that reads something unguarded).
    // wrap.ts's outer try/catch around the whole `if (gateOn)` block must
    // swallow it identically to the existing `trackSkillInvoke`-throws case
    // (see wrap.test.ts's "emit-failure survival" case).
    setEmissionGate(() => true)
    setTelemetryIdentityProvider(() => {
      throw new Error('identity provider blew up')
    })

    const handler = () => 'still works'
    const wrapped = withTelemetry(handler as unknown as (...a: unknown[]) => unknown, TOOL_OPTS)

    const result = await runWithToolNameContext('search', () =>
      (wrapped as unknown as () => Promise<string>)()
    )

    expect(result).toBe('still works')
    // The legacy sink, evaluated first in the same finally block, still fired.
    expect(mockTrack).toHaveBeenCalledOnce()
  })
})
