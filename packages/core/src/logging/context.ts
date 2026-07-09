/**
 * SMI-5615: Correlation-ID context for the shared logging + telemetry pipeline.
 *
 * Lives in `logging/` (not `telemetry/wrap.ts`) so both `telemetry/wrap.ts`
 * and the future `logging/logger.ts` (Wave 2) can read/write it without a
 * circular import between the `telemetry` and `logging` subtrees (F4). This
 * module imports ONLY `node:async_hooks` — it must never import from
 * `../telemetry/*`, or the one-directional `telemetry -> logging` boundary
 * this split exists to guarantee breaks. An ESLint `no-restricted-imports`
 * boundary guard (Wave 2, §1) enforces this mechanically; keep it true by
 * construction here regardless.
 *
 * Mirrors the existing `markerStorage` / `runWithMarkerContext` pattern in
 * `packages/core/src/telemetry/wrap.ts`: a module-scoped `AsyncLocalStorage`
 * instance, installed per-call via a `runWith*` function, read live via
 * `.getStore()` — never memoised. `AsyncLocalStorage` (not a module-scoped
 * variable) because harnesses batch PARALLEL tool calls to one server
 * process; a plain module slot would let call A's completion clear call B's
 * still-in-flight correlation ID.
 *
 * Install-site correction (F1, see `docs/internal/implementation/production-error-logging.md`):
 * the correlation ID is installed by `withTelemetry` around its *entire*
 * `wrappedFn` body (try + finally), not just the inner `handler(...args)`
 * call — otherwise the emit path's `getCorrelationId()` read happens after
 * the scope has already unwound and always returns `undefined`.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Per-call correlation ID, scoped via `runWithCorrelationId`. Read live via
 * `getCorrelationId()` — never memoised — so every consumer (the
 * `withTelemetry` emit path, and later `logging/logger.ts`) observes the ID
 * for its OWN call's async continuation, never a sibling's.
 */
export const correlationIdStorage = new AsyncLocalStorage<string>()

/**
 * Run `fn` with `id` installed as the correlation ID for every telemetry
 * emit / log call inside its async continuation. Concurrency-safe: parallel
 * invocations each see only their own ID; code outside any
 * `runWithCorrelationId` scope sees no ID (`getCorrelationId()` returns
 * `undefined`).
 *
 * Callers should mint-if-absent (`getCorrelationId() ?? randomUUID()`)
 * before calling this, so a wrapped call nested inside another wrapped
 * call's continuation inherits the outer ID instead of fragmenting one
 * logical request's trace across multiple IDs.
 */
export function runWithCorrelationId<T>(id: string, fn: () => Promise<T>): Promise<T> {
  return correlationIdStorage.run(id, fn)
}

/**
 * Read the correlation ID installed for the current async continuation, or
 * `undefined` if called outside any `runWithCorrelationId` scope (e.g.
 * fire-and-forget work started before any tool call establishes a scope).
 *
 * Must be read synchronously at the log/emit call site — never deferred to
 * an async flush/rotation callback, which could fire outside the
 * originating call's scope (F3).
 */
export function getCorrelationId(): string | undefined {
  return correlationIdStorage.getStore()
}
