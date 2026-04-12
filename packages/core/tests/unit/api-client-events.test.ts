/**
 * SMI-4119: SkillsmithApiClient event-batching integration tests.
 *
 * Verifies:
 *  - `recordEvent()` enqueues without an immediate POST.
 *  - `flushEvents()` drains the queue and issues a single POST with
 *    `X-Skillsmith-Batched: true` and `{ events: [...] }` body.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SkillsmithApiClient } from '../../src/api/client.js'
import type { TelemetryEvent } from '../../src/api/client.js'

describe('SMI-4119: SkillsmithApiClient event batching', () => {
  const originalFetch = globalThis.fetch
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response('', { status: 200, headers: { 'Content-Type': 'text/plain' } })
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  const mkEvent = (anonId: string): TelemetryEvent => ({
    event: 'skill_view',
    anonymous_id: anonId,
  })

  it('recordEvent does not POST immediately', async () => {
    const client = new SkillsmithApiClient({ baseUrl: 'https://test.invalid' })
    const res = await client.recordEvent(mkEvent('aaaaaaaaaaaaaaaa'))
    expect(res).toEqual({ ok: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('flushEvents drains queued events via a single POST with X-Skillsmith-Batched', async () => {
    const client = new SkillsmithApiClient({ baseUrl: 'https://test.invalid' })
    await client.recordEvent(mkEvent('aaaaaaaaaaaaaaaa'))
    await client.recordEvent(mkEvent('bbbbbbbbbbbbbbbb'))

    await client.flushEvents()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://test.invalid/events')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['X-Skillsmith-Batched']).toBe('true')
    const body = JSON.parse(String(init.body))
    expect(body.events).toHaveLength(2)
    expect(body.events[0].anonymous_id).toBe('aaaaaaaaaaaaaaaa')
  })

  it('offlineMode short-circuits recordEvent (no enqueue, no POST)', async () => {
    const client = new SkillsmithApiClient({ baseUrl: 'https://test.invalid', offlineMode: true })
    const res = await client.recordEvent(mkEvent('aaaaaaaaaaaaaaaa'))
    expect(res).toEqual({ ok: true })
    await client.flushEvents()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
