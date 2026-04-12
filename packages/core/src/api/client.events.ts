/**
 * Event batching glue for SkillsmithApiClient
 * @module api/client.events
 *
 * SMI-4119: Keeps batcher wiring out of client.ts to stay under the 500-line cap.
 *
 * This module exposes a small helper that builds a flush function bound to a
 * client's base URL / auth headers and posts batches to `POST /events`.
 */

import type { TelemetryEvent } from './client.js'
import { buildRequestHeaders } from './utils.js'
import { createEventBatcher, type EventBatcher } from './event-batcher.js'

/**
 * Inputs required to POST a batch to `/events`.
 * Kept narrow so we don't expose private client fields.
 */
export interface BatchPostContext {
  baseUrl: string
  anonKey: string | undefined
  apiKey: string | undefined
  /** Request timeout in ms. */
  timeout: number
}

/**
 * Build a flush function that POSTs a batch to `${baseUrl}/events`.
 *
 * Emits `X-Skillsmith-Batched: true` so the edge function can stamp
 * `audit_logs.metadata.batched` and post-deploy SQL can distinguish
 * batched vs stale single-client traffic.
 *
 * Throws on non-2xx responses so the batcher can retry.
 */
export function createBatchFlushFn(
  ctx: () => BatchPostContext
): (events: TelemetryEvent[]) => Promise<void> {
  return async (events: TelemetryEvent[]): Promise<void> => {
    if (events.length === 0) return
    const { baseUrl, anonKey, apiKey, timeout } = ctx()

    // SMI-4119: Correlation ID per batch POST so operators can join all
    // `audit_logs` rows inserted from one client flush. Format matches the
    // edge function's validation regex `[a-zA-Z0-9_-]{1,64}`.
    const batchId = generateBatchId()

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const res = await fetch(`${baseUrl}/events`, {
        method: 'POST',
        headers: {
          ...buildRequestHeaders(anonKey),
          ...(apiKey ? { 'X-API-Key': apiKey } : {}),
          'X-Skillsmith-Batched': 'true',
          'X-Skillsmith-Batch-Id': batchId,
        },
        body: JSON.stringify({ events }),
        signal: controller.signal,
      })
      if (!res.ok) {
        // Drain the body to free the socket; ignore parse errors.
        await res.text().catch(() => '')
        throw new Error(`events batch POST failed: ${res.status}`)
      }
      // Drain body to allow keep-alive reuse; ignore errors.
      await res.text().catch(() => '')
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Build an EventBatcher that POSTs to `${baseUrl}/events` using the live
 * auth context returned by `ctx()`. Lazily re-reads context on each flush so
 * config changes (e.g. API key rotation) are honored.
 */
export function buildClientEventBatcher(ctx: () => BatchPostContext): EventBatcher {
  return createEventBatcher(createBatchFlushFn(ctx))
}

/**
 * Generate a short, URL-safe correlation ID for a batch POST.
 * Uses `crypto.randomUUID` when available; falls back to Math.random so the
 * code runs in environments without the Web Crypto API.
 */
function generateBatchId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } }
  if (g.crypto && typeof g.crypto.randomUUID === 'function') {
    return g.crypto.randomUUID()
  }
  return `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
