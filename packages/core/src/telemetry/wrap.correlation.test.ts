/**
 * SMI-5615: `withTelemetry` correlation-ID + error-capture coverage. Sibling
 * to `wrap.test.ts` / `wrap.marker.test.ts` / `wrap.gate.test.ts` (split per
 * the 500-line file gate).
 *
 * Covers the Shared-State / Coordination Audit (P-5) `correlationIdStorage`
 * row + the §2 error-capture extension:
 *   - a thrown error results in a `trackSkillInvoke` payload with
 *     `errorName` / `errorMessage` / `correlationId` populated
 *   - two concurrent, overlapping `withTelemetry`-wrapped calls each retain
 *     their OWN correlation ID (neither observes the other's)
 *   - a wrapped call invoked from inside another wrapped call's handler
 *     inherits the outer correlation ID (nested-call, mint-if-absent case)
 *   - the success-path payload shape: `correlationId` present, `errorName` /
 *     `errorMessage` absent
 *   - `errorMessage` is redacted (via the mocked `redactSensitiveData` seam)
 *     and truncated to <=256 chars
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { withTelemetry, setEmissionGate } from './wrap.js'

vi.mock('./posthog.js', () => ({
  trackSkillInvoke: vi.fn(),
}))

// SMI-5615: isolation seam for the Wave-2 `logging/redact.ts` module (landed
// alongside this file — see docs/internal/implementation/production-error-logging.md).
// The factory below marks redacted text so tests can assert the redaction
// call site was actually exercised, distinct from a passthrough no-op.
vi.mock('../logging/redact.js', () => ({
  redactSensitiveData: (s: string) => s.replace('SECRET_TOKEN', '[REDACTED]'),
}))

import { trackSkillInvoke } from './posthog.js'
const mockTrack = vi.mocked(trackSkillInvoke)

const BASE_OPTS = {
  source: 'mcp-tool' as const,
  extractSkillId: () => 'test/skill',
}

beforeEach(() => {
  mockTrack.mockReset()
  setEmissionGate(() => true)
})

afterEach(() => {
  setEmissionGate(undefined)
})

// ---------------------------------------------------------------------------
// Error capture on throw
// ---------------------------------------------------------------------------

describe('error capture (SMI-5615)', () => {
  it('populates errorName/errorMessage/correlationId when the handler throws', async () => {
    const boom = (): never => {
      throw new TypeError('handler exploded: SECRET_TOKEN')
    }
    const wrapped = withTelemetry(boom as unknown as (...a: unknown[]) => unknown, BASE_OPTS)

    await expect((wrapped as unknown as () => Promise<never>)()).rejects.toThrow('handler exploded')

    expect(mockTrack).toHaveBeenCalledOnce()
    const payload = mockTrack.mock.calls[0][0]
    expect(payload.success).toBe(false)
    expect(payload.errorName).toBe('TypeError')
    // Redacted (SECRET_TOKEN -> [REDACTED] per the mocked redact seam above).
    expect(payload.errorMessage).toBe('handler exploded: [REDACTED]')
    expect(payload.correlationId).toEqual(expect.any(String))
    expect(payload.correlationId!.length).toBeGreaterThan(0)
  })

  it('captures the class name for a non-Error thrown value', async () => {
    const boom = (): never => {
      throw 'a plain string failure'
    }
    const wrapped = withTelemetry(boom as unknown as (...a: unknown[]) => unknown, BASE_OPTS)

    await expect((wrapped as unknown as () => Promise<never>)()).rejects.toBe(
      'a plain string failure'
    )

    expect(mockTrack).toHaveBeenCalledOnce()
    const payload = mockTrack.mock.calls[0][0]
    expect(payload.errorName).toBe('string')
    expect(payload.errorMessage).toBe('a plain string failure')
  })

  it('truncates errorMessage to 256 characters', async () => {
    const longMessage = 'x'.repeat(1000)
    const boom = (): never => {
      throw new Error(longMessage)
    }
    const wrapped = withTelemetry(boom as unknown as (...a: unknown[]) => unknown, BASE_OPTS)

    await expect((wrapped as unknown as () => Promise<never>)()).rejects.toThrow()

    const payload = mockTrack.mock.calls[0][0]
    expect(payload.errorMessage).toHaveLength(256)
  })

  it('success-path payload has correlationId but no errorName/errorMessage', async () => {
    const handler = () => 'ok'
    const wrapped = withTelemetry(handler as unknown as (...a: unknown[]) => unknown, BASE_OPTS)

    await (wrapped as unknown as () => Promise<string>)()

    expect(mockTrack).toHaveBeenCalledOnce()
    const payload = mockTrack.mock.calls[0][0]
    expect(payload.success).toBe(true)
    expect(payload.correlationId).toEqual(expect.any(String))
    expect(payload.errorName).toBeUndefined()
    expect(payload.errorMessage).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Concurrent calls each retain their OWN correlation ID (P-5 invariant)
// ---------------------------------------------------------------------------

describe('correlation-ID concurrency (P-5 invariant)', () => {
  it('two concurrent, overlapping calls each retain their own correlation ID', async () => {
    // Force interleaving with manually-resolved promises: A starts first, B
    // starts second, A finishes (and emits) while B is still awaiting, then B
    // finishes — B's emit must still carry B's OWN correlation ID, not A's.
    let releaseA!: () => void
    let releaseB!: () => void
    const blockA = new Promise<void>((r) => (releaseA = r))
    const blockB = new Promise<void>((r) => (releaseB = r))

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

    const callA = wrappedA()
    const callB = wrappedB()

    releaseA()
    await callA
    releaseB()
    await callB

    expect(mockTrack).toHaveBeenCalledTimes(2)
    const [payloadA, payloadB] = mockTrack.mock.calls.map((c) => c[0])
    expect(payloadA.skillId).toBe('tool-a')
    expect(payloadB.skillId).toBe('tool-b')
    expect(payloadA.correlationId).toEqual(expect.any(String))
    expect(payloadB.correlationId).toEqual(expect.any(String))
    // The heart of the invariant: neither call observes the other's ID.
    expect(payloadA.correlationId).not.toBe(payloadB.correlationId)
  })

  it('a nested wrapped call inherits the outer correlation ID (mint-if-absent)', async () => {
    const innerHandler = () => {
      // Captured from the LAST trackSkillInvoke call once the inner call
      // completes (below); we read it back from mockTrack after both resolve.
      return 'inner'
    }
    const inner = withTelemetry(innerHandler as unknown as (...a: unknown[]) => unknown, {
      ...BASE_OPTS,
      extractSkillId: () => 'tool-inner',
    })

    const outerHandler = async () => {
      await inner()
      return 'outer'
    }
    const outer = withTelemetry(outerHandler as unknown as (...a: unknown[]) => unknown, {
      ...BASE_OPTS,
      extractSkillId: () => 'tool-outer',
    })

    await (outer as unknown as () => Promise<string>)()

    expect(mockTrack).toHaveBeenCalledTimes(2)
    const calls = mockTrack.mock.calls.map((c) => c[0])
    const innerPayload = calls.find((p) => p.skillId === 'tool-inner')
    const outerPayload = calls.find((p) => p.skillId === 'tool-outer')
    const innerCorrelationId = innerPayload?.correlationId
    const outerCorrelationId = outerPayload?.correlationId

    expect(innerCorrelationId).toEqual(expect.any(String))
    expect(outerCorrelationId).toEqual(expect.any(String))
    // Mint-if-absent: the nested call inherits the outer ID rather than
    // minting a fresh one, so one logical request keeps a single ID.
    expect(innerCorrelationId).toBe(outerCorrelationId)
  })

  it('sequential (non-nested) calls each mint a fresh, distinct correlation ID', async () => {
    const handler = () => 'ok'
    const wrapped = withTelemetry(handler as unknown as (...a: unknown[]) => unknown, BASE_OPTS)

    await (wrapped as unknown as () => Promise<string>)()
    await (wrapped as unknown as () => Promise<string>)()

    expect(mockTrack).toHaveBeenCalledTimes(2)
    const [first, second] = mockTrack.mock.calls.map((c) => c[0])
    expect(first.correlationId).toEqual(expect.any(String))
    expect(second.correlationId).toEqual(expect.any(String))
    expect(first.correlationId).not.toBe(second.correlationId)
  })
})
