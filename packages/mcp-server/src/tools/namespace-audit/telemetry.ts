/**
 * @fileoverview Aggregate-only server telemetry for the consumer namespace
 *               audit (SMI-4587 Wave 1 Step 8a, decision #7).
 * @module @skillsmith/mcp-server/tools/namespace-audit/telemetry
 *
 * Emits a single `telemetry:namespace_audit_complete` event per audit run
 * via the existing `events` edge function. Aggregate-only by design — the
 * payload contains COUNTS and RESOLUTION COUNTERS but never `auditId`,
 * file paths, identifiers, skill names, or any other free-form text from
 * the user's filesystem (decision #7 in plan).
 *
 * Why a dedicated emitter (not `emitInstallEvent`):
 *   - `emitInstallEvent` is shaped around a different event kind
 *     (`event: 'skill_install'`) with install-specific metadata.
 *   - The audit is best-effort like installs; we keep its silent-failure
 *     semantics but with our own actor + payload contract.
 *
 * Payload shape (exact):
 *   {
 *     event: 'namespace_audit_complete',
 *     anonymous_id: hmac_sha256(API_KEY) hex | null,
 *     metadata: {
 *       tier:           'community' | 'individual' | 'team' | 'enterprise',
 *       audit_mode:     'preventative' | 'power_user' | 'governance',
 *       collisions: { exact: number, generic: number, semantic: number },
 *       resolved_auto:    number,
 *       resolved_manual:  number,
 *       resolved_skipped: number,
 *       user_id?:       string | null   // hashed actor proxy when caller wants it
 *     }
 *   }
 *
 * The emitter is a no-op when:
 *   - `audit_mode === 'off'` (the detector also short-circuits)
 *   - `SKILLSMITH_TELEMETRY=0|false|off`
 *
 * Network failures are swallowed — telemetry must never break an audit run.
 */

import { createHmac } from 'node:crypto'

import type { AuditMode, Tier } from '@skillsmith/core/config/audit-mode'

import type { InventoryAuditResult } from '../../audit/collision-detector.types.js'

const DEFAULT_API_BASE = 'https://api.skillsmith.app'
const EVENT_ENDPOINT = '/functions/v1/events'
const REQUEST_TIMEOUT_MS = 2000

/**
 * Same actor-derivation rationale as `remote-audit.ts`. Reused as a
 * keyed correlation ID for aggregate audit telemetry — NOT password
 * storage. The constant is intentionally distinct from the install
 * actor key so the two streams cannot be cross-correlated server-side.
 */
const TELEMETRY_ACTOR_KEY = 'skillsmith-namespace-audit-actor:v1'

export interface AuditCompleteContext {
  /** Subscription tier of the caller. */
  tier: Tier
  /**
   * Resolved audit mode. `'off'` is accepted but causes the emitter to
   * short-circuit (decision #7 defense-in-depth) — the detector should
   * already have skipped this call entirely.
   */
  audit_mode: AuditMode
  /** Counters emitted by Wave 2's rename engine. Wave 1 always 0. */
  resolved_auto: number
  resolved_manual: number
  resolved_skipped: number
  /**
   * Optional opaque caller identifier (already-hashed by the caller).
   * Pass `null` to omit. Wave 1 callers pass `null`.
   */
  user_id?: string | null
}

export interface AuditCompleteTelemetryOptions {
  /**
   * API key override for tests. Defaults to `SKILLSMITH_API_KEY`. When
   * neither this nor the env var is set, `anonymous_id` is `null`.
   */
  apiKey?: string | null
  /** Override the events endpoint. Defaults to `SKILLSMITH_API_URL`. */
  apiUrl?: string
  /** Test seam: inject a fetch implementation. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch
}

/**
 * Emit the `telemetry:namespace_audit_complete` event for one audit run.
 *
 * Best-effort: never throws, never blocks the caller. Returns the
 * stringified payload that was attempted (or `null` when the emitter
 * short-circuited) so tests can assert on the wire body without re-
 * stringifying the request.
 */
export async function emitAuditCompleteEvent(
  result: InventoryAuditResult,
  ctx: AuditCompleteContext,
  opts: AuditCompleteTelemetryOptions = {}
): Promise<string | null> {
  if (isDisabled()) return null
  // Decision #7: 'off' mode never emits — defense-in-depth even though
  // the detector already short-circuits before reaching this call.
  if (ctx.audit_mode === 'off') return null

  const apiKey = opts.apiKey ?? process.env.SKILLSMITH_API_KEY ?? null
  const collisions = aggregateCollisions(result)

  const metadata: Record<string, unknown> = {
    tier: ctx.tier,
    audit_mode: ctx.audit_mode,
    collisions,
    resolved_auto: ctx.resolved_auto,
    resolved_manual: ctx.resolved_manual,
    resolved_skipped: ctx.resolved_skipped,
  }
  // Per decision #7, omit `user_id` entirely when null/undefined to keep
  // the payload aggregate-only. Callers explicitly opt in by passing a
  // non-null hashed actor proxy.
  if (ctx.user_id != null) {
    metadata.user_id = ctx.user_id
  }

  const body = JSON.stringify({
    event: 'namespace_audit_complete',
    anonymous_id: apiKey ? hashForActor(apiKey) : null,
    metadata,
  })

  const apiBase = opts.apiUrl ?? process.env.SKILLSMITH_API_URL ?? DEFAULT_API_BASE
  const fetchImpl = opts.fetchImpl ?? fetch

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    await fetchImpl(`${apiBase}${EVENT_ENDPOINT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body,
    })
  } catch {
    // Best-effort: swallow all errors (network, abort, endpoint down).
  } finally {
    clearTimeout(timer)
  }
  return body
}

/**
 * Aggregate counts only — `result.exactCollisions.length`,
 * `result.genericFlags.length`, `result.semanticCollisions.length`. No
 * identifiers, no paths, no overlapping phrases (decision #7).
 */
function aggregateCollisions(result: InventoryAuditResult): {
  exact: number
  generic: number
  semantic: number
} {
  return {
    exact: result.exactCollisions.length,
    generic: result.genericFlags.length,
    semantic: result.semanticCollisions.length,
  }
}

function hashForActor(apiKey: string): string {
  // codeql[js/insufficient-password-hash] Deterministic telemetry actor-ID
  // derivation via HMAC-SHA-256 — not password storage. Same rationale
  // as remote-audit.ts; key intentionally distinct so the two streams
  // can't be cross-correlated server-side.
  return createHmac('sha256', TELEMETRY_ACTOR_KEY).update(apiKey).digest('hex')
}

function isDisabled(): boolean {
  const flag = process.env.SKILLSMITH_TELEMETRY
  return flag === '0' || flag === 'false' || flag === 'off'
}
