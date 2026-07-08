/**
 * First-Run Welcome Message Middleware — SMI-5573
 *
 * The MCP server's first-run welcome message used to be printed via
 * `console.error` (stderr) in `index.ts`, *before* `server.connect(transport)`
 * runs. Most MCP hosts (including Claude Code) never surface stderr to the
 * end user, so the message was effectively invisible. Two more facts rule out
 * the "obvious" fixes:
 *
 *  1. The message is generated before there's a connected client — there is
 *     no transport to write to yet.
 *  2. This server declares no MCP `logging` capability, so
 *     `server.sendLoggingMessage()` would silently no-op even if called after
 *     `connect()`.
 *
 * This codebase already has a proven, tested pattern for exactly this kind of
 * "one-time message injection into a tool response" problem:
 * `middleware/telemetry-consent.ts`'s `annotateResponseWithConsent`, which
 * parses `content[0].text` as JSON, splices extra fields into the parsed
 * object, and re-serializes — falling back to returning the response
 * untouched if parsing fails. This module mirrors that parse/splice/
 * re-serialize/fallback-on-parse-failure shape for the welcome message.
 *
 * Key difference from `telemetry-consent.ts`: that module's "have we already
 * shown this?" bookkeeping (`promptedIds` / `wasConsentPrompted` /
 * `markConsentPrompted`) lives OUTSIDE the annotator, in the caller
 * (`call-tool-handler.ts`'s `maybeAnnotate`). Here, the one-shot "pending"
 * state and its consumption are internal to {@link annotateResponseWithWelcome}
 * itself, because the consumption rule is more subtle than "did we splice
 * successfully": an ERROR response must NEVER consume the pending state, even
 * though there was a pending message when the call was made, so a transient
 * first-call failure doesn't permanently lose the welcome message — it must
 * still be delivered on the next successful call. Folding that rule into the
 * annotator (rather than asking every future caller to reimplement it)
 * removes an entire class of "the wiring pass forgot the isError check"
 * mistakes.
 *
 * Wiring (owned by a separate pass, NOT this module): call
 * `setPendingWelcome(message, failures)` once at server startup when
 * first-run setup completes, and call `annotateResponseWithWelcome(result)`
 * on every dispatched `CallToolResult` (mirroring `maybeAnnotate` in
 * `call-tool-handler.ts`) — the module-level pending flag makes repeat calls
 * after consumption (or when nothing is pending) cheap no-ops, so it's safe
 * to call unconditionally.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/**
 * The not-yet-delivered welcome payload. `null` once there is nothing left
 * to deliver (either never set, or already consumed by a successful splice).
 */
export interface PendingWelcomeState {
  /** The rendered first-run welcome message (prose, may be multi-line). */
  message: string
  /**
   * Names/ids of Tier-1 skills that failed to auto-install during first-run
   * setup. Empty array when every Tier-1 skill installed cleanly.
   */
  tier1InstallFailures: string[]
}

/**
 * Per-process pending-welcome state. Same singleton-within-the-process
 * approach as `telemetry-consent.ts`'s module-level `consentCache` /
 * `promptedIds` — this middleware has exactly one first-run welcome to
 * deliver per server process, so a class instance would be overkill.
 */
let pendingWelcome: PendingWelcomeState | null = null

/**
 * Record that a first-run welcome message is pending delivery. Called
 * (by a separate wiring pass) exactly once at server startup, after
 * first-run setup completes — before `server.connect(transport)` is even
 * relevant, since delivery happens lazily on the first successful tool call.
 *
 * Calling this again before the pending message is consumed OVERWRITES the
 * previous pending state; first-run setup runs at most once per process, so
 * this is not expected to happen in practice, but overwrite (rather than
 * ignore) is the safer choice if it ever does — it keeps the newest call
 * authoritative instead of silently discarding it.
 *
 * @param message The rendered welcome message to deliver.
 * @param failures Tier-1 skill names/ids that failed to auto-install. Pass
 *   an empty array when nothing failed — `annotateResponseWithWelcome` always
 *   splices `tier1_install_failures` as an array (never omits it).
 */
export function setPendingWelcome(message: string, failures: string[]): void {
  pendingWelcome = { message, tier1InstallFailures: [...failures] }
}

/**
 * True iff a welcome message is queued for delivery and has not yet been
 * consumed by a successful {@link annotateResponseWithWelcome} splice.
 *
 * A peek, not a mutation — safe to call as often as needed (e.g. by a caller
 * deciding whether it's worth calling the annotator at all, or by tests
 * asserting one-shot consumption).
 */
export function hasPendingWelcome(): boolean {
  return pendingWelcome !== null
}

/**
 * Augment an existing MCP tool response with the pending welcome message,
 * consuming the pending state ONLY on a genuinely successful splice.
 *
 * The MCP `CallToolResult` shape is `{ content: [{ type: 'text', text: <json> }], isError?: boolean }`.
 * We parse `text`, splice in `welcome_message` + `tier1_install_failures`,
 * and re-serialize — mirroring `telemetry-consent.ts`'s
 * `annotateResponseWithConsent` exactly. If parsing fails for any reason
 * (binary content, malformed payload, non-text first block, empty content
 * array), we return the response untouched: the welcome message is a soft
 * signal and must never corrupt a tool result.
 *
 * Consumption rules (both must hold before the pending state is cleared):
 *  1. `response.isError` must be falsy — an error envelope is left
 *     completely untouched (no splice attempted) AND the pending state
 *     survives, so the message is retried on the next successful call
 *     instead of being silently lost to a transient first-call failure.
 *  2. The parse-and-splice must actually succeed — if `content[0].text`
 *     isn't valid JSON (or the shape is otherwise unsplice-able), the
 *     response is returned untouched AND the pending state survives, for the
 *     same reason: a fail-open no-op must never consume a message the caller
 *     never actually saw.
 *
 * Idempotent by construction: once the splice succeeds, `pendingWelcome` is
 * cleared, so every subsequent call (including a second call on an
 * already-annotated response, or any call once nothing is pending) is a
 * cheap no-op that returns its input unchanged.
 */
export function annotateResponseWithWelcome(response: CallToolResult): CallToolResult {
  if (!pendingWelcome) return response
  if (response.isError) return response

  const content = response.content
  if (!Array.isArray(content) || content.length === 0) return response

  const first = content[0] as { type?: unknown; text?: unknown } | undefined
  if (!first || first.type !== 'text' || typeof first.text !== 'string') return response

  let parsed: unknown
  try {
    parsed = JSON.parse(first.text)
  } catch {
    return response
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return response
  }

  const annotated = parsed as Record<string, unknown>
  annotated.welcome_message = pendingWelcome.message
  annotated.tier1_install_failures = pendingWelcome.tier1InstallFailures

  const nextContent = [...content]
  nextContent[0] = {
    ...first,
    text: JSON.stringify(annotated, null, 2),
  } as (typeof content)[number]

  // Consume ONLY now — after the splice has genuinely succeeded. Every
  // early return above leaves `pendingWelcome` untouched.
  pendingWelcome = null

  return { ...response, content: nextContent }
}

/**
 * Test-only helper. Not exported from the package index.
 *
 * Clears the pending-welcome singleton so tests start with a clean slate,
 * mirroring `telemetry-consent.ts`'s `_resetConsentCacheForTests`.
 */
export function _resetPendingWelcomeForTests(): void {
  pendingWelcome = null
}
