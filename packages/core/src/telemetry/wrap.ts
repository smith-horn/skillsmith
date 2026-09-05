/**
 * SMI-5016: In-process telemetry HOF + Set-based registry.
 *
 * `withTelemetry` wraps a handler function with timing + emit + error-safe
 * envelope. A module-scoped `Set<Function>` tracks all wrapped functions so
 * the three-tree snapshot test (SMI-5018) can assert 100% dispatcher coverage
 * via `isTelemetered()`.
 *
 * Applied review change H3: registry is an exported Set (not function-object
 * mutation) so arrow-const exports can be wrapped without mutation.
 * Applied review change H4: `framework` is captured per-call, not memoised.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { trackSkillInvoke } from './posthog.js'
import type { AgentMarker } from './agent-marker.js'
import { getCorrelationId, runWithCorrelationId } from '../logging/context.js'
import { redactSensitiveData } from '../logging/redact.js'
import { emitToolCallEvent } from '../audit/remote-audit.js'

// ---------------------------------------------------------------------------
// Module-scoped registry (NOT exported — access only via isTelemetered)
// ---------------------------------------------------------------------------

// `(...args: never[]) => unknown` is the ESLint-compliant "any callable"
// shape: contravariant params accept any function reference, and we never
// invoke entries — `wrapped` is identity-only (used by .has/.add).
type AnyFunction = (...args: never[]) => unknown

const wrapped = new Set<AnyFunction>()

// ---------------------------------------------------------------------------
// Emission gate (SMI-5019 wire-in; SMI-5479 AsyncLocalStorage refactor)
// ---------------------------------------------------------------------------
//
// Default-suppress: until an emission gate is active, `withTelemetry` does NOT
// emit. Privacy-safe by construction — the alternative (default-emit) risks
// emitting telemetry for an unknown anonymous_id before consent has been
// resolved. We pick the privacy-safe default per SMI-5019; a misconfigured host
// that never opens a gate simply emits no telemetry, which is observable
// (counts stay at zero) and recoverable.
//
// Two gates feed the emit-path read (in the `finally` block below), in
// precedence order:
//
//   1. `emissionGateStorage` (PRIMARY) — an `AsyncLocalStorage<boolean>`
//      scoped per tool call via `runWithEmissionGate`. New call sites (the
//      mcp-server dispatch handler + license-gate middleware) resolve consent
//      ONCE at dispatch and pass that resolved VALUE into the scope; the store
//      then governs every emit for the whole of that call's async
//      continuation. Mirrors the marker-context ALS below one-for-one — the
//      reason nested / concurrent installs are safe: `.run()` is reentrant and
//      each async continuation is isolated, so a sibling call can never observe
//      or clear this call's gate.
//   2. `emissionGate` (FALLBACK) — a process-wide module `let`, a THUNK
//      installed via `setEmissionGate`, consulted only when no ALS store is
//      present. Retained solely as a test seam and a deprecated fallback for
//      the pre-SMI-5479 shape; new production code MUST use
//      `runWithEmissionGate`.
//
// Multi-tenancy caveat (RESOLVED by SMI-5479): the gate used to be purely
// module-scoped, which a future multi-tenant transport could not share safely.
// The `AsyncLocalStorage`-backed per-request state that caveat deferred is now
// applied here — per-call scope isolates concurrent consents. See the matching
// note in `license.gate.ts`.
const emissionGateStorage = new AsyncLocalStorage<boolean>()

/**
 * Run `fn` with `enabled` installed as the emission-gate decision for every
 * telemetry emit inside its async continuation. Concurrency-safe: parallel
 * invocations each see only their own value; code outside any
 * `runWithEmissionGate` scope falls back to the module `let` (default-suppress
 * when that too is unset).
 *
 * Takes a resolved boolean VALUE (consent resolved once at dispatch) — contrast
 * `setEmissionGate`, which takes a predicate thunk. The value is read live in
 * the emit path, so an in-flight call always observes the gate active for ITS
 * OWN scope, never a sibling's.
 */
export function runWithEmissionGate<T>(enabled: boolean, fn: () => Promise<T>): Promise<T> {
  return emissionGateStorage.run(enabled, fn)
}

// Process-wide FALLBACK gate — a module `let` thunk (test-only / deprecated).
// Superseded by `runWithEmissionGate`; retained so existing unit tests and any
// pre-SMI-5479 caller keep working with zero churn.
let emissionGate: (() => boolean) | undefined

/**
 * Install (or clear) the process-wide FALLBACK emission gate.
 *
 * @deprecated Prefer `runWithEmissionGate`, which scopes the decision to a
 * single call's async continuation and auto-unwinds — no reset discipline, no
 * cross-call leak. `setEmissionGate` survives only as a test seam and the
 * pre-SMI-5479 fallback: its predicate is consulted (evaluated once per wrapped
 * call, in the `finally` block) ONLY when no `runWithEmissionGate` scope is
 * active. Pass a predicate to enable emission when it returns true; pass
 * `undefined` to revert to default-suppress.
 */
export function setEmissionGate(gate: (() => boolean) | undefined): void {
  emissionGate = gate
}

// ---------------------------------------------------------------------------
// Agent-mediation marker context (SMI-5456)
// ---------------------------------------------------------------------------
//
// The three per-event marker fields (`agent_session`, `nudge_origin`,
// `trigger_id`) do not live in the handler's arguments — they arrive on the MCP
// request's `_meta` or a session marker file, both resolved by the dispatch
// layer. The dispatcher runs each dispatch inside `runWithMarkerContext` and
// `withTelemetry` reads the store live in its emit path — never memoised,
// mirroring the per-call `framework` capture (H4).
//
// `AsyncLocalStorage` (not a module-scoped variable) because harnesses batch
// PARALLEL tool calls to one server process (Claude Code emits multiple
// tool_use blocks in one response). A module-scoped slot would let call A's
// completion clear call B's still-in-flight marker — silently zeroing
// `agent_session` on genuinely mediated calls and undercounting the mediation
// gate metric. ALS scopes the marker to each call's own async continuation, so
// concurrent calls cannot observe or clear each other's context.
const markerStorage = new AsyncLocalStorage<AgentMarker>()

/**
 * Run `fn` with `marker` installed as the agent-mediation context for every
 * telemetry emit inside its async continuation. Concurrency-safe: parallel
 * invocations each see only their own marker; code outside any
 * `runWithMarkerContext` scope sees no marker (fields default false/false/null).
 */
export function runWithMarkerContext<T>(marker: AgentMarker, fn: () => Promise<T>): Promise<T> {
  return markerStorage.run(marker, fn)
}

// ---------------------------------------------------------------------------
// Tool-name context (SMI-6362 §1)
// ---------------------------------------------------------------------------
//
// `tool_name` (the literal MCP tool name, e.g. `'search'`) is known only at
// the single MCP dispatch call site (`call-tool-handler.ts`'s
// `request.params.name`) — none of the ~30 `withTelemetry(...)` call sites
// across `packages/mcp-server/src/tools/*` know their own registered name,
// and adding a new required `WithTelemetryOpts` field would mean touching
// every one of them for a value the dispatcher already has for free. Same
// ALS-context shape as `markerStorage` above, for the same reason: the
// dispatcher installs it once per call, and every wrapped handler nested
// inside that call's async continuation (including ones reached through
// `withLicenseAndQuota` middleware) sees it without any per-call-site change.
const toolNameStorage = new AsyncLocalStorage<string>()

/**
 * Run `fn` with `toolName` installed as the dispatch-level tool-name context
 * for every `emitToolCallEvent` inside its async continuation. Mirrors
 * `runWithMarkerContext` — concurrency-safe, no manual clearing.
 */
export function runWithToolNameContext<T>(toolName: string, fn: () => Promise<T>): Promise<T> {
  return toolNameStorage.run(toolName, fn)
}

// ---------------------------------------------------------------------------
// Error capture (SMI-5615)
// ---------------------------------------------------------------------------
//
// `trackSkillInvoke` previously reported only `success: boolean` on failure —
// the caught error was discarded entirely. No stack traces leave the machine:
// only the error's class name and a redacted, truncated message ride the
// already-consent-gated `skill_invoke` event.

const MAX_ERROR_MESSAGE_LENGTH = 256

/** Extract a best-effort string message from an unknown caught value. */
function errorMessageOf(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}

/** Truncate a (already redacted) error message to `MAX_ERROR_MESSAGE_LENGTH`. */
function truncateErrorMessage(message: string): string {
  return message.length > MAX_ERROR_MESSAGE_LENGTH
    ? message.slice(0, MAX_ERROR_MESSAGE_LENGTH)
    : message
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for `withTelemetry`.
 *
 * `extractSkillId` and `extractFramework` receive the arguments array at
 * call-time so they can derive values from the live request context.
 * `extractFramework` is intentionally per-call (H4) — not memoised.
 */
// The HOF is generic over an arbitrary args tuple + return type, so wrapping
// preserves the handler's exact signature at every call site. We parameterize
// over (TArgs, TReturn) directly rather than `F extends (...args: any[]) => any`
// because the latter degrades return-type inference through the cast chain in
// the wrapper body — see SMI-5012 stack PR-2.
export interface WithTelemetryOpts<TArgs extends readonly unknown[]> {
  /** Discriminator stored with the event — which invocation surface this is. */
  source: 'mcp-tool' | 'cli' | 'vscode-extension'
  /** Derive the skill ID from the handler's arguments at call-time. */
  extractSkillId: (args: TArgs) => string
  /**
   * Derive the framework string from the handler's arguments at call-time.
   * Per H4: called once per invocation, never memoised.
   * Returns `'unknown'` if omitted.
   */
  extractFramework?: (args: TArgs) => string
}

// ---------------------------------------------------------------------------
// HOF
// ---------------------------------------------------------------------------

/**
 * Wraps `handler` with a timing + telemetry emit envelope and registers the
 * returned function in the module-scoped `wrapped` Set.
 *
 * Guarantees:
 * - The emit happens even when `handler` throws (`finally` block).
 * - Telemetry errors are swallowed — they never affect the caller.
 * - The returned function preserves the original call signature (`F`).
 * - Calling `withTelemetry` on the same original function twice produces two
 *   distinct wrapped functions (both registered in the Set).
 *
 * @example
 * // Arrow-const export — the critical H3 case:
 * export const myTool = withTelemetry(
 *   async (args) => { ... },
 *   { source: 'mcp-tool', extractSkillId: (a) => a[0].skill }
 * )
 */
export function withTelemetry<TArgs extends readonly unknown[], TReturn>(
  handler: (...args: TArgs) => Promise<TReturn> | TReturn,
  opts: WithTelemetryOpts<TArgs>
): (...args: TArgs) => Promise<TReturn> {
  const wrappedFn = async (...args: TArgs): Promise<TReturn> => {
    // SMI-5615 (F1 fix, corrected from the naive design): the correlation-ID
    // scope wraps the ENTIRE body below — try *and* finally — not just the
    // `handler(...args)` call. Installing it around only the handler would
    // leave the finally block's emit path outside the ALS scope, so the
    // `getCorrelationId()` read there would always see `undefined`, silently
    // defeating the feature. Mint-if-absent (`getCorrelationId() ?? randomUUID()`)
    // means a wrapped call nested inside another wrapped call's continuation
    // inherits the outer ID instead of fragmenting one logical request's trace.
    return runWithCorrelationId(getCorrelationId() ?? randomUUID(), async () => {
      const start = Date.now()
      const skillId = opts.extractSkillId(args)
      // Per H4: evaluated per-call so a single server process can serve multiple
      // clients with different frameworks on the same HTTP transport.
      const framework = opts.extractFramework?.(args) ?? 'unknown'
      let success = true
      let caughtError: unknown
      try {
        return await handler(...args)
      } catch (e) {
        success = false
        caughtError = e
        throw e
      } finally {
        // Emit BEFORE the catch re-throw lands; swallow telemetry errors so they
        // never affect the wrapped function's observable behaviour.
        try {
          // SMI-5019 wire-in / SMI-5479 refactor: consult the emission gate. The
          // per-call ALS store (PRIMARY) wins over the module `let` thunk
          // (FALLBACK). `??` — not `||` — so an ALS `false` suppresses even when a
          // permissive module gate is installed: a consent-off scope must never
          // leak emission. Default-suppress holds when neither is present (no
          // store + no thunk → `undefined` → no emit).
          const gateOn =
            emissionGateStorage.getStore() ?? (emissionGate ? emissionGate() : undefined)
          if (gateOn) {
            // SMI-5456: thread the marker from this call's ALS scope into the
            // event. Read here (not memoised) so it reflects the marker installed
            // for THIS call's async continuation — concurrent calls each see
            // their own. Consent parity is automatic — these fields only ride an
            // event that the emission gate already permitted.
            const marker = markerStorage.getStore()
            // SMI-6362 §1: computed once, shared by both sinks below — the
            // second sink (emitToolCallEvent) needs the identical error
            // fields trackSkillInvoke already derives, not a second
            // independent computation that could drift from this one.
            const resolvedFramework = marker?.harness ?? framework
            const durationMs = Date.now() - start
            const errorFields = success
              ? {}
              : {
                  errorName:
                    caughtError instanceof Error
                      ? caughtError.constructor.name
                      : typeof caughtError,
                  errorMessage: truncateErrorMessage(
                    redactSensitiveData(errorMessageOf(caughtError))
                  ),
                }
            trackSkillInvoke({
              skillId,
              source: opts.source,
              // Per-harness attribution: the marker channel's vocabulary-validated
              // `harness` wins over the extractor result — every MCP-tool call
              // site hardcodes `extractFramework: () => 'unknown'`, so without
              // this the per-harness split never survives to the wire. H4
              // (per-call, never memoised) is preserved: the ALS store IS
              // per-request state, read here on every emit. CLI / VS Code
              // callers never install marker context, so `getStore()` is
              // undefined there and their real extractors keep winning.
              framework: resolvedFramework,
              durationMs,
              success,
              agentSession: marker?.agentSession ?? false,
              nudgeOrigin: marker?.nudgeOrigin ?? false,
              triggerId: marker?.triggerId ?? null,
              // SMI-5615: cross-signal join key — a disk log line, an OTel span,
              // and this PostHog event for one failure share this ID. Read live
              // from the still-open scope established above (F1 fix), always
              // present regardless of success/failure.
              correlationId: getCorrelationId(),
              // SMI-5615: capture the previously-discarded error on failure only.
              // No stack traces leave the machine — class name + redacted,
              // truncated (<=256 char) message only.
              ...errorFields,
            })

            // SMI-6362 §1: second, independent sink — a `tool_call` row in
            // `search_metrics`, distinct from the `skill_invoke` PostHog
            // event above (D-3). Only for MCP tool calls (`tool_call` is
            // Lane-B-only per D-2a/D-3; CLI/VS Code sources have no
            // equivalent dispatch-level tool-name context installed). Same
            // `gateOn` check as above by construction (both live inside this
            // one `if (gateOn)` block) — the client-side half of D-1 is
            // enforced at this single point.
            if (opts.source === 'mcp-tool') {
              const toolName = toolNameStorage.getStore()
              if (toolName !== undefined) {
                emitToolCallEvent({
                  toolName,
                  framework: resolvedFramework,
                  durationMs,
                  success,
                  sessionId: marker?.sessionId,
                  // SMI-6362 §1: named limitation — see the doc comment on
                  // ToolCallEventPayload.isSubagent in remote-audit.ts.
                  isSubagent: false,
                  ...errorFields,
                })
              }
            }
          }
        } catch {
          // Intentionally swallowed — telemetry must never break user code.
        }
      }
    })
  }

  wrapped.add(wrappedFn)
  return wrappedFn
}

// ---------------------------------------------------------------------------
// Registry accessor
// ---------------------------------------------------------------------------

/**
 * Returns `true` if `fn` was produced by `withTelemetry`.
 *
 * Used by the three-tree snapshot test (SMI-5018) to assert that every
 * dispatcher export is telemetry-wrapped.
 *
 * Note: checks the *wrapped* function reference, not the original handler.
 * `isTelemetered(originalHandler)` is always `false`.
 */
export function isTelemetered(fn: AnyFunction): boolean {
  return wrapped.has(fn)
}
