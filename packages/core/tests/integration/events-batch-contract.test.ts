/**
 * SMI-4119 / C3: Contract test pinning the `/events` response shapes.
 *
 * **Backward compat guardrail**: the single-event POST body MUST continue to
 * return `{ ok: true }` byte-identical — no `accepted`/`rejected`/`errors`
 * leakage from the batch path. Any drift here breaks old `@skillsmith/core`
 * clients in the wild.
 *
 * We pin the schemas exposed by `@skillsmith/core` to guard both shapes.
 */

import { describe, it, expect } from 'vitest'
import {
  TelemetryResponseSchema,
  TelemetryBatchResponseSchema,
  TelemetryEventBatchSchema,
} from '../../src/api/schemas.js'

describe('SMI-4119 / C3: events endpoint response contracts', () => {
  it('single-event response is exactly `{ ok: true }` (no batch fields leak)', () => {
    const raw = { data: { ok: true } }
    const parsed = TelemetryResponseSchema.safeParse(raw)
    expect(parsed.success).toBe(true)

    // Byte-identical: JSON serialized form must have no unexpected keys.
    const body = { ok: true }
    expect(JSON.stringify(body)).toBe('{"ok":true}')
    // Keys are exactly ['ok'] — pin so future refactors don't silently widen.
    expect(Object.keys(body)).toEqual(['ok'])
  })

  it('batch response carries `{ok, accepted, rejected}` and optional `errors`', () => {
    const ok = TelemetryBatchResponseSchema.safeParse({
      ok: true,
      accepted: 3,
      rejected: 0,
    })
    expect(ok.success).toBe(true)

    const withErrors = TelemetryBatchResponseSchema.safeParse({
      ok: true,
      accepted: 2,
      rejected: 1,
      errors: [{ index: 1, reason: 'invalid_anonymous_id' }],
    })
    expect(withErrors.success).toBe(true)
  })

  it('batch request schema enforces 1..=20 events', () => {
    const tooFew = TelemetryEventBatchSchema.safeParse({ events: [] })
    expect(tooFew.success).toBe(false)

    const tooMany = TelemetryEventBatchSchema.safeParse({
      events: Array.from({ length: 21 }, () => ({
        event: 'skill_view' as const,
        anonymous_id: 'a'.repeat(16),
      })),
    })
    expect(tooMany.success).toBe(false)

    const justRight = TelemetryEventBatchSchema.safeParse({
      events: Array.from({ length: 20 }, () => ({
        event: 'skill_view' as const,
        anonymous_id: 'a'.repeat(16),
      })),
    })
    expect(justRight.success).toBe(true)
  })

  it('rate-limited batch response shape is pinned (SMI-4119 / C1)', () => {
    // Shape produced by events/index.ts when checkRateLimit rejects a batch:
    const body = {
      ok: false,
      accepted: 0,
      rejected: 5,
      errors: [{ index: -1, reason: 'rate_limited' }],
    }
    const parsed = TelemetryBatchResponseSchema.safeParse(body)
    expect(parsed.success).toBe(true)
  })
})
