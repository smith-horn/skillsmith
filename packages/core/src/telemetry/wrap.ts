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

import { trackSkillInvoke } from './posthog.js'

// ---------------------------------------------------------------------------
// Module-scoped registry (NOT exported — access only via isTelemetered)
// ---------------------------------------------------------------------------

// `(...args: never[]) => unknown` is the ESLint-compliant "any callable"
// shape: contravariant params accept any function reference, and we never
// invoke entries — `wrapped` is identity-only (used by .has/.add).
type AnyFunction = (...args: never[]) => unknown

const wrapped = new Set<AnyFunction>()

// ---------------------------------------------------------------------------
// Emission gate (SMI-5019 wire-in)
// ---------------------------------------------------------------------------
//
// Default-suppress: until an emission gate is installed via `setEmissionGate`,
// `withTelemetry` does NOT emit. Privacy-safe by construction — consumers
// (e.g. the mcp-server license-gate middleware) MUST call `setEmissionGate`
// during request handling to enable emission for their context.
//
// The alternative (default-emit) would be backwards-compatible but risks
// emitting telemetry for an unknown anonymous_id before consent has been
// resolved. We pick the privacy-safe default per SMI-5019; a misconfigured
// host that forgets to install a gate simply emits no telemetry, which is
// observable (counts stay at zero) and recoverable.
//
// Multi-tenancy caveat: the gate is module-scoped. For a single-tenant MCP
// server process (the v1 shape) this is correct. A future multi-tenant
// transport would need `AsyncLocalStorage`-backed per-request state — see
// the matching caveat in `license.gate.ts`.
let emissionGate: (() => boolean) | undefined

/**
 * Install (or clear) the per-process emission gate.
 *
 * Pass a predicate to enable telemetry only when the predicate returns true;
 * pass `undefined` to revert to the default-suppress behaviour. Callers should
 * always reset to `undefined` in a `finally` so a thrown handler does not
 * leak emission permission to the next request.
 *
 * The predicate is evaluated once per call to a wrapped function, inside the
 * `finally` block, so it sees the live state of any per-request resolver.
 */
export function setEmissionGate(gate: (() => boolean) | undefined): void {
  emissionGate = gate
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
    const start = Date.now()
    const skillId = opts.extractSkillId(args)
    // Per H4: evaluated per-call so a single server process can serve multiple
    // clients with different frameworks on the same HTTP transport.
    const framework = opts.extractFramework?.(args) ?? 'unknown'
    let success = true
    try {
      return await handler(...args)
    } catch (e) {
      success = false
      throw e
    } finally {
      // Emit BEFORE the catch re-throw lands; swallow telemetry errors so they
      // never affect the wrapped function's observable behaviour.
      try {
        // SMI-5019 wire-in: consult the emission gate. Default-suppress when
        // no gate is installed — see module-level comment for the rationale.
        if (emissionGate && emissionGate()) {
          trackSkillInvoke({
            skillId,
            source: opts.source,
            framework,
            durationMs: Date.now() - start,
            success,
          })
        }
      } catch {
        // Intentionally swallowed — telemetry must never break user code.
      }
    }
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
