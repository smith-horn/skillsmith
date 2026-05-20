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

const wrapped = new Set<Function>()

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
export interface WithTelemetryOpts<F extends (...a: unknown[]) => unknown> {
  /** Discriminator stored with the event — which invocation surface this is. */
  source: 'mcp-tool' | 'cli' | 'vscode-extension'
  /** Derive the skill ID from the handler's arguments at call-time. */
  extractSkillId: (args: Parameters<F>) => string
  /**
   * Derive the framework string from the handler's arguments at call-time.
   * Per H4: called once per invocation, never memoised.
   * Returns `'unknown'` if omitted.
   */
  extractFramework?: (args: Parameters<F>) => string
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
export function withTelemetry<F extends (...a: unknown[]) => unknown>(
  handler: F,
  opts: WithTelemetryOpts<F>
): F {
  const wrappedFn = (async (...args: Parameters<F>) => {
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
        trackSkillInvoke({
          skillId,
          source: opts.source,
          framework,
          durationMs: Date.now() - start,
          success,
        })
      } catch {
        // Intentionally swallowed — telemetry must never break user code.
      }
    }
  }) as F

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
export function isTelemetered(fn: Function): boolean {
  return wrapped.has(fn)
}
