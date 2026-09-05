import { createHmac } from 'node:crypto'
import { getApiKey } from '../config/index.js'
import { getOrCreateInstallId } from '../config/device-identity.js'

export interface InstallEventPayload {
  skillId: string
  source: 'mcp' | 'cli' | 'vscode'
  success: boolean
  durationMs?: number
  trustTier?: string
  errorCode?: string
}

/**
 * SMI-5193: Search-event payload emitted from the MCP `search` tool to the
 * Skillsmith telemetry endpoint (`/functions/v1/events`).
 *
 * **All keys MUST be snake_case** — the `events` edge function's
 * `sanitizeMetadata` allowlists `results_count`, `duration_ms`, `has_query`,
 * `trust_tier`, `category`. camelCase variants are silently dropped server-side
 * (event accepted, metadata lost). The event name is `'search'` (in the edge
 * function's `ALLOWED_EVENTS`); `'skill_search'` would 400 silently.
 */
export interface SearchEventPayload {
  query: string
  results_count: number
  duration_ms: number
  has_query: boolean
  trust_tier?: string
  category?: string
}

const DEFAULT_API_BASE = 'https://api.skillsmith.app'
const EVENT_ENDPOINT = '/functions/v1/events'
const REQUEST_TIMEOUT_MS = 2000

/**
 * HMAC key used to derive the telemetry actor ID from the caller's API key.
 *
 * This is NOT password storage — it is a keyed, deterministic, non-reversible
 * correlation ID used to distinguish one caller from another in aggregate
 * telemetry. HMAC-SHA-256 is the correct primitive for that use case:
 *  - Keyed construction cleanly signals "opaque identifier derivation", not
 *    password hashing.
 *  - Fast (no KDF latency on the hot install path).
 *  - Deterministic so the same API key always maps to the same actor ID,
 *    enabling per-caller aggregation server-side.
 *
 * A slow KDF (bcrypt/scrypt/Argon2) would be inappropriate here — it adds
 * latency without changing any security property we need.
 */
const TELEMETRY_ACTOR_KEY = 'skillsmith-telemetry-actor:v1'

function hashForActor(apiKey: string): string {
  // codeql[js/insufficient-password-hash] Deterministic telemetry actor-ID
  // derivation via HMAC-SHA-256 — not password storage. See TELEMETRY_ACTOR_KEY
  // doc-comment above for full rationale.
  return createHmac('sha256', TELEMETRY_ACTOR_KEY).update(apiKey).digest('hex')
}

function getApiBase(): string {
  return process.env.SKILLSMITH_API_URL || DEFAULT_API_BASE
}

function isDisabled(): boolean {
  const flag = process.env.SKILLSMITH_TELEMETRY
  return flag === '0' || flag === 'false' || flag === 'off'
}

interface TelemetryEventBody {
  event: string
  anonymous_id: string
  metadata: Record<string, unknown>
}

/**
 * Best-effort POST to the Skillsmith events endpoint.
 *
 * Used by all `emit*Event` exports — never throws, swallows network/abort/
 * endpoint errors, and respects the 2s timeout. Telemetry failures must
 * never break the caller's flow.
 *
 * SMI-6362 (D-8): returns the raw `Response` (or `null` on a swallowed
 * transport failure) so a caller that needs emission-durability
 * classification — `emitToolCallEvent` below — can read it. The two
 * pre-existing callers (`emitInstallEvent`, `emitSearchEvent`) ignore the
 * return value, unchanged.
 */
async function postTelemetryEvent(
  body: TelemetryEventBody,
  opts?: { headers?: Record<string, string> }
): Promise<Response | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    return await fetch(`${getApiBase()}${EVENT_ENDPOINT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(opts?.headers ?? {}) },
      signal: controller.signal,
      body: JSON.stringify(body),
    })
  } catch {
    // Best-effort: swallow all errors (network, abort, endpoint down).
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Emit a skill-install event to Skillsmith's remote telemetry endpoint.
 *
 * Best-effort: never throws, never blocks the caller. Silently skips in these cases:
 * - No API key available (CLI offline / unauthenticated)
 * - SKILLSMITH_TELEMETRY=0 (opt-out)
 * - Network / endpoint failure
 *
 * The API key is mapped to a namespaced, non-reversible telemetry actor ID
 * (HMAC-SHA-256 keyed by `skillsmith-telemetry-actor:v1`) before transmission.
 * The server stores that digest as `actor` — never the raw key, never an
 * email, never a user ID.
 *
 * Event shape when emitted:
 *   event_type: "telemetry:skill_install"
 *   actor:      hmac_sha256("skillsmith-telemetry-actor:v1", apiKey) hex
 *   metadata:   { skill_id, source, success, duration_ms?, trust_tier?, error_code? }
 */
export async function emitInstallEvent(payload: InstallEventPayload): Promise<void> {
  if (isDisabled()) return
  const apiKey = getApiKey()
  if (!apiKey) return

  await postTelemetryEvent({
    event: 'skill_install',
    anonymous_id: hashForActor(apiKey),
    metadata: {
      skill_id: payload.skillId,
      source: payload.source,
      success: payload.success,
      ...(payload.durationMs !== undefined && { duration_ms: payload.durationMs }),
      ...(payload.trustTier !== undefined && { trust_tier: payload.trustTier }),
      ...(payload.errorCode !== undefined && { error_code: payload.errorCode }),
    },
  })
}

/**
 * SMI-5193: Emit a search event to Skillsmith's remote telemetry endpoint.
 *
 * Fire-and-forget (synchronous, returns `void`) — wraps `postTelemetryEvent`
 * with `void` so the caller never awaits. The MCP search tool calls this
 * after a search completes so the usage report's search count reflects MCP
 * searches (landing in `search_metrics` via the `events` edge function).
 *
 * Silently skips in these cases:
 * - No API key available (CLI offline / unauthenticated)
 * - SKILLSMITH_TELEMETRY=0 (opt-out)
 * - Network / endpoint failure
 *
 * CRITICAL — silent-failure modes that motivated this signature:
 * - `event` MUST be `'search'` (in `events/index.ts` ALLOWED_EVENTS).
 *   `'skill_search'` would 400 silently.
 * - `anonymous_id` is REQUIRED (validated as 16-128 char hex server-side).
 *   Missing → 400 silently.
 * - Metadata keys MUST be snake_case — `sanitizeMetadata` allowlists
 *   `results_count`, `duration_ms`, `has_query`, `trust_tier`, `category`.
 *   camelCase variants are silently dropped.
 */
export function emitSearchEvent(payload: SearchEventPayload): void {
  if (isDisabled()) return
  const apiKey = getApiKey()
  if (!apiKey) return

  void postTelemetryEvent({
    event: 'search',
    anonymous_id: hashForActor(apiKey),
    metadata: payload as unknown as Record<string, unknown>,
  })
}

// ---------------------------------------------------------------------------
// SMI-6362 §1: `tool_call` events (Lane B, JWT-authenticated MCP tool calls)
// ---------------------------------------------------------------------------

/**
 * The synchronously-available, background-refreshed identity `wrap.ts`
 * needs to attribute a `tool_call` event. Never resolved inline on the
 * emit path — see `setTelemetryIdentityProvider`.
 *
 * `sdkVersion` is deliberately optional and resolved by the mcp-server
 * caller (`context.async.ts`), not here: `@skillsmith/core` has no
 * dependency on `@modelcontextprotocol/sdk` or any mcp-server package
 * metadata, so this module must stay agnostic to how the caller derives it.
 *
 * `tier` is intentionally NOT part of this shape yet. Wave 3 (SMI-6362)
 * ships without it: the only synchronous, already-cached tier resolver in
 * the codebase (`createLicenseMiddleware`'s per-instance cache,
 * `middleware/license.ts`) is constructed in `index.ts`'s `main()`, after
 * `context.async.ts` (where this provider is installed) has already run —
 * `context.async.ts` cannot reach it without a new cross-module wiring path,
 * which is out of this wave's stated file footprint. Named limitation,
 * tracked as a Wave 6 follow-up in the plan doc — not silently dropped.
 */
export interface TelemetryIdentity {
  accessToken: string
  apiKey?: string
  sdkVersion?: string
}

export type TelemetryIdentityProvider = () => TelemetryIdentity | null

let telemetryIdentityProvider: TelemetryIdentityProvider | null = null

/**
 * Install (or clear, with `null`) the module-level identity provider
 * `emitToolCallEvent` reads synchronously on every call. The provider itself
 * must never block — see the design note in the SMI-6362 plan §1
 * ("Credential plumbing"): the cache is refreshed in the background by the
 * caller (on install, on 401, and on a timer), never inline here.
 */
export function setTelemetryIdentityProvider(provider: TelemetryIdentityProvider | null): void {
  telemetryIdentityProvider = provider
}

/**
 * SMI-6362 §1: one of the three refresh triggers the plan names for the
 * identity cache ("on install, on 401 from the events endpoint, and on a
 * 5-minute timer"). This module cannot itself refresh anything — it has no
 * knowledge of how the caller resolves a token — so it only signals
 * "the cached token was rejected as invalid" via this optional callback,
 * which `context.async.ts` registers alongside the provider. `classifyResponse`
 * fires it on `reason === 'invalid_jwt'` and nowhere else (an `identity_required`
 * or `consent_denied` rejection is not a stale-token problem and refreshing
 * would not fix it).
 */
let telemetryIdentityInvalidationHandler: (() => void) | null = null

export function setTelemetryIdentityInvalidationHandler(handler: (() => void) | null): void {
  telemetryIdentityInvalidationHandler = handler
}

/** Payload `wrap.ts`'s second sink builds per MCP tool call. */
export interface ToolCallEventPayload {
  toolName: string
  framework: string
  durationMs: number
  success: boolean
  /** SMI-6362 §1: from the agent-marker file's own session id, when present. */
  sessionId?: string
  /**
   * SMI-6362 §1: always `false` this wave. No MCP harness today distinguishes
   * a subagent-issued tool call from a top-level one at the protocol level —
   * the marker channel's `_meta`/file schema (SMI-5456) has no such field,
   * and subagents share the SAME MCP server process as the top-level agent,
   * so there is no process-level signal either. Sending a guessed value
   * would be actively misleading in a paid analytics surface; `false` is the
   * only honest default until a real signal exists. Named limitation,
   * tracked as a Wave 6 follow-up in the plan doc (parallel to D-9).
   */
  isSubagent: boolean
  errorName?: string
  errorMessage?: string
}

interface TelemetryEmitStats {
  accepted: number
  rejected: number
  failed: number
  skippedNoIdentity: number
  /**
   * SMI-6362 Wave 4 (D-8, completing what Wave 3 left unexported): the
   * `X-Skillsmith-Telemetry-Reason` from the most recent rejection, so the
   * read path (`analytics.ts` AC-10) can render an actionable line — e.g.
   * `ambiguous_team` -> "set SKILLSMITH_LICENSE_KEY to choose which team" —
   * instead of just a count. `null` until the first rejection this process.
   */
  lastRejectionReason: string | null
}

const emitStats: TelemetryEmitStats = {
  accepted: 0,
  rejected: 0,
  failed: 0,
  skippedNoIdentity: 0,
  lastRejectionReason: null,
}

/** SMI-6362 (D-8): a snapshot of this process's `tool_call` emission outcomes. */
export function getTelemetryEmitStats(): TelemetryEmitStats {
  return { ...emitStats }
}

/** Reset for tests only. */
export function _resetTelemetryEmitStatsForTests(): void {
  emitStats.accepted = 0
  emitStats.rejected = 0
  emitStats.failed = 0
  emitStats.skippedNoIdentity = 0
  emitStats.lastRejectionReason = null
  loggedRejectReasons.clear()
}

// SMI-6362 (D-8): log a rejection reason once per reason per process, not
// once per event — a sustained rejection (e.g. a stale token) must not spam
// stderr on every single tool call.
const loggedRejectReasons = new Set<string>()

function classifyResponse(response: Response | null): void {
  if (!response) {
    emitStats.failed++
    return
  }
  if (response.ok && response.headers.get('X-Skillsmith-Telemetry-Accepted') === '1') {
    emitStats.accepted++
    return
  }
  emitStats.rejected++
  const reason = response.headers.get('X-Skillsmith-Telemetry-Reason') ?? 'unknown'
  emitStats.lastRejectionReason = reason
  if (!loggedRejectReasons.has(reason)) {
    loggedRejectReasons.add(reason)
    console.debug(
      `[skillsmith] tool_call telemetry rejected (reason=${reason}); further rejections with this reason are counted but not logged again this process`
    )
  }
  // SMI-6362 §1: only a stale/invalid token is worth an out-of-band refresh —
  // `identity_required` (no JWT sent at all), `consent_denied`/`consent_required`,
  // `no_team`, etc. would not be fixed by re-resolving the same token.
  if (reason === 'invalid_jwt') {
    telemetryIdentityInvalidationHandler?.()
  }
}

/**
 * SMI-6362 §1: emit a `tool_call` event for an MCP tool invocation.
 *
 * Fire-and-forget (synchronous, returns `void`), mirroring `emitSearchEvent`.
 * Reads the identity provider synchronously; if none is installed or it
 * returns `null` (no cached credential yet), the event is skipped entirely
 * — never sent unauthenticated, per the plan's "no fallback to an
 * unauthenticated POST" rule (§1, "Credential plumbing").
 */
export function emitToolCallEvent(payload: ToolCallEventPayload): void {
  if (isDisabled()) return

  const identity = telemetryIdentityProvider?.()
  if (!identity) {
    emitStats.skippedNoIdentity++
    return
  }

  const metadata: Record<string, unknown> = {
    tool_name: payload.toolName,
    source: 'mcp-tool',
    framework: payload.framework,
    duration_ms: payload.durationMs,
    success: payload.success,
    platform: process.platform,
    is_subagent: payload.isSubagent,
  }
  if (payload.sessionId !== undefined) metadata.session_id = payload.sessionId
  if (identity.sdkVersion !== undefined) metadata.sdk_version = identity.sdkVersion
  if (!payload.success) {
    if (payload.errorName !== undefined) metadata.error_name = payload.errorName
    if (payload.errorMessage !== undefined) metadata.error_message = payload.errorMessage
  }

  void postTelemetryEvent(
    {
      event: 'tool_call',
      anonymous_id: getOrCreateInstallId(),
      metadata,
    },
    { headers: { Authorization: `Bearer ${identity.accessToken}` } }
  ).then(classifyResponse)
}
