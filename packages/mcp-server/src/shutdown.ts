/**
 * @fileoverview Unified shutdown coordinator for the Skillsmith MCP server
 * (SMI-5479, extended SMI-5649 + SMI-5640).
 * @module @skillsmith/mcp-server/shutdown
 *
 * Extracted from `index.ts`'s `main()` into its own module for two reasons:
 * 1. `index.ts` has `main().catch(console.error)` at module scope — importing
 *    it (even for a unit test of an unrelated export) runs the ENTIRE server
 *    bootstrap (DB init, stdio transport connect). This module has no
 *    top-level side effects, so it can be imported and unit-tested directly.
 * 2. Keeps `index.ts` under the `audit:standards` 500-LOC file-size gate.
 *
 * Before this (pass-2 of the plan review), nothing ever called
 * `shutdownPostHog()` — the PostHog client buffers events (10s
 * `flushInterval`, `posthog.ts:95`), so a server that exits before that
 * window elapses loses every buffered `skill_invoke` event: an unsigned bias
 * on the mediation-gate metric (systematically undercounts short sessions)
 * and a smoke run that calls one tool and exits loses the event 100% of the
 * time.
 *
 * SMI-5649 + SMI-5640: this module grew from a single db-close+telemetry-flush
 * trigger into the ONE shutdown coordinator for the whole process. Previously,
 * `context.async.ts` (and its sync sibling `context.ts`) each registered their
 * OWN independent SIGTERM/SIGINT handlers whose fire-and-forget
 * `backgroundSync?.stop()` raced this module's `closeDbOnShutdown()` with no
 * ordering guarantee — an in-flight sync write could hit a closed db. Both
 * independent registrations are now deleted; `index.ts` is the single
 * registration site, and `runShutdownSequence` below owns the ordered
 * sequence: quiesce background work -> close LLM failover -> close/persist db
 * -> flush telemetry. A periodic autosave timer (SMI-5640) also lives here,
 * bounding data loss on an *ungraceful* kill (SIGKILL/crash/power-loss) that
 * no shutdown hook can ever catch.
 *
 * See docs/internal/implementation/mcp-shutdown-followup-hardening-wave-a-design.md
 * for the full design rationale.
 */

import { shutdownPostHog } from '@skillsmith/core/telemetry'
import type { DatabaseType } from '@skillsmith/core'
import { createLogger } from '@skillsmith/core/logging'

/** Bound on how long a shutdown flush may block process exit. */
export const TELEMETRY_SHUTDOWN_FLUSH_TIMEOUT_MS = 2000

/**
 * Bound on how long background-work quiesce (awaiting an in-flight sync) may
 * block process exit (SMI-5649). Symmetric with
 * {@link TELEMETRY_SHUTDOWN_FLUSH_TIMEOUT_MS} — see the design doc §2.3 for
 * the full rationale on why proceeding to close the db on timeout is safe.
 */
export const SHUTDOWN_QUIESCE_TIMEOUT_MS = 2000

/**
 * Default periodic autosave cadence for the WASM driver (SMI-5640): 5
 * minutes. Overridable via `SKILLSMITH_AUTOSAVE_INTERVAL_MS` (primarily so
 * tests don't wait 5 real minutes); disable entirely via
 * `SKILLSMITH_AUTOSAVE_DISABLE=1`. See
 * docs/internal/process/guards-and-opt-outs.md.
 */
const DEFAULT_AUTOSAVE_INTERVAL_MS = 300_000

const logger = createLogger('mcp')

// ── coordinator-owned module state ──────────────────────────────────────────
let shuttingDown = false
/** Re-entrancy latch (SMI-5649): a second trigger awaits the SAME in-flight
 * sequence rather than racing a second, independent one. Load-bearing, not
 * cosmetic — see the design doc §1.3 Subtlety A. */
let shutdownPromise: Promise<void> | null = null
/** Periodic autosave timer handle (SMI-5640). */
let flushTimer: ReturnType<typeof setInterval> | null = null

/**
 * Late-bound cleanup steps handed to the ONE shutdown coordinator by
 * `index.ts`. All hooks are optional and called fail-soft — a missing or
 * throwing hook never blocks or crashes the shutdown sequence.
 */
export interface ShutdownHooks {
  /** Lazy getter for the tool-context db (late-bound; `toolContext` is
   * assigned in `main()` AFTER the trigger is built). */
  getDb?: () => DatabaseType | undefined
  /** Quiesce background async work: abort + await in-flight sync. Resolves
   * when settled (or when the caller's own bounded timeout elapses). */
  quiesce?: () => Promise<void>
  /** Close the LLM failover chain (synchronous, idempotent). */
  closeLlmFailover?: () => void
}

/**
 * Attempt to flush + shut down the PostHog client, bounded by `timeoutMs`
 * (`Promise.race` against a plain timer) so a hung PostHog client can never
 * block process exit. Fail-soft — mirrors `shutdownPostHog`'s own internal
 * try/catch; a flush error must never propagate.
 *
 * Unguarded internal helper — see {@link flushTelemetryOnShutdown} for the
 * guarded public wrapper. Split out (SMI-5649) so the coordinator's own
 * step 4 isn't skipped by the `shuttingDown` guard it itself sets at step 0.
 */
async function doFlushTelemetry(
  timeoutMs: number = TELEMETRY_SHUTDOWN_FLUSH_TIMEOUT_MS
): Promise<void> {
  try {
    await Promise.race([
      shutdownPostHog(),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ])
  } catch {
    // Fail-soft — a telemetry flush error must never block shutdown.
  }
}

/**
 * Attempt to flush + shut down the PostHog client, bounded by `timeoutMs`.
 *
 * Idempotent within a process: a second call while a flush is already in
 * flight (or has completed) is a no-op, so wiring this to multiple shutdown
 * triggers (transport close, SIGTERM, SIGINT) can never double-flush or race.
 * This guarded wrapper is for standalone callers (e.g. the integration test);
 * the coordinator's own step 4 calls the internal unguarded
 * {@link doFlushTelemetry} directly so its own `shuttingDown = true` (set at
 * step 0) can't short-circuit its own flush (design doc §1.3 Subtlety B).
 */
export async function flushTelemetryOnShutdown(
  timeoutMs: number = TELEMETRY_SHUTDOWN_FLUSH_TIMEOUT_MS
): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  await doFlushTelemetry(timeoutMs)
}

/**
 * Test-only reset of the module-level shutdown coordinator state. Not
 * exported from the package index.
 */
export function _resetShutdownGuardForTests(): void {
  shuttingDown = false
  shutdownPromise = null
  stopPeriodicFlush()
}

/**
 * Fail-soft, synchronous close of the tool-context database on shutdown.
 *
 * On the WASM (`sql.js`) driver, `close()` is the only thing that ever
 * persists the in-memory database to disk (`sqljsDriver.ts`'s `close()` →
 * `persist()` → `writeFileSync`) — see SMI-5639. Before this, nothing in the
 * shutdown path ever called `close()`, so every write made during a session
 * was silently discarded on normal exit.
 *
 * Never throws — a `getDb()` that itself throws, or a `close()` that
 * throws, is caught and logged via `logger.error` (NOT `.debug`/`.info`,
 * which are disk-only per SMI-5615 — a failed persist is a genuine
 * data-loss event and must be visible on stderr, not silently swallowed the
 * same way the original bug was invisible).
 *
 * Idempotent by construction: `db.open` reflects the driver's real closed
 * state (both `SqlJsDatabaseAdapter` and `BetterSqlite3Database` expose a
 * reliable `open` getter), so calling this twice — e.g. `transport.onclose`
 * racing a signal — only calls `.close()` once. No separate module-level
 * guard flag is needed.
 *
 * @param getDb - Lazy getter for the current db (late-bound, so it can read
 *   a `toolContext` that isn't assigned yet at trigger-creation time).
 */
export function closeDbOnShutdown(getDb?: () => DatabaseType | undefined): void {
  try {
    const db = getDb?.()
    if (db && db.open) {
      db.close()
    }
  } catch (error) {
    logger.error(
      '[skillsmith] Failed to close database on shutdown — recent writes may not be persisted',
      { err: error }
    )
  }
}

/**
 * Fail-soft wrapper around `hooks.quiesce`: awaits background-work quiesce
 * (abort + await in-flight sync), never letting a throwing/rejecting hook
 * escape into the shutdown sequence. The bounded timeout itself lives in the
 * hook implementation (`index.ts`'s `quiesceBackgroundSync`, SMI-5649 §2.3) —
 * this wrapper is defense-in-depth for a hook that misbehaves outside that
 * contract.
 */
async function runQuiesce(quiesce?: () => Promise<void>): Promise<void> {
  if (!quiesce) return
  try {
    await quiesce()
  } catch (error) {
    logger.error('[skillsmith] Background sync quiesce failed during shutdown', { err: error })
  }
}

/**
 * Fail-soft wrapper around `hooks.closeLlmFailover`: closes the LLM failover
 * chain (if configured), never letting a throwing hook escape into the
 * shutdown sequence.
 */
function safeCloseLlmFailover(closeLlmFailover?: () => void): void {
  try {
    closeLlmFailover?.()
  } catch (error) {
    logger.error('[skillsmith] Failed to close LLM failover chain on shutdown', { err: error })
  }
}

/**
 * The ONE shutdown coordinator (SMI-5649 + SMI-5640). Idempotent and
 * re-entrant: a second call while a sequence is already in flight returns
 * the SAME promise rather than racing a second, independent sequence — this
 * is load-bearing (design doc §1.3 Subtlety A), not cosmetic: without it, a
 * second trigger (e.g. `onclose` firing while a `SIGTERM`-triggered sequence
 * is still parked in quiesce) could exit the process mid-persist, re-losing
 * exactly the data this wave protects.
 *
 * Ordered sequence: stop the autosave timer -> quiesce background work
 * (abort + await in-flight sync, bounded fail-soft) -> close the LLM
 * failover chain -> close/persist the db (idempotent via `db.open`) -> flush
 * telemetry (bounded fail-soft).
 */
export function runShutdownSequence(hooks: ShutdownHooks): Promise<void> {
  if (shutdownPromise) return shutdownPromise
  shutdownPromise = (async () => {
    shuttingDown = true
    stopPeriodicFlush() // 0. stop autosave before we begin tearing down
    await runQuiesce(hooks.quiesce) // 1. abort + await in-flight sync (bounded, fail-soft)
    safeCloseLlmFailover(hooks.closeLlmFailover) // 2. close LLM failover
    closeDbOnShutdown(hooks.getDb) // 3. close/persist db (idempotent via db.open)
    await doFlushTelemetry() // 4. flush PostHog (bounded, fail-soft)
  })()
  return shutdownPromise
}

/**
 * Build the single shutdown trigger. `index.ts` registers the returned
 * function on `transport.onclose` + `SIGTERM` + `SIGINT` — the ONE
 * registration site for the whole server (SMI-5649: `context.async.ts` and
 * `context.ts` previously each registered their own independent, racing set).
 * Registering ANY listener for SIGTERM/SIGINT overrides Node's default
 * terminate-on-signal behavior, so `index.ts` MUST call this for each trigger
 * to preserve today's default (process exits promptly on those signals)
 * rather than leaving the process hanging once a listener is registered.
 *
 * @param onDone - Called once the shutdown sequence settles (index.ts passes
 *   `() => process.exit(0)`).
 * @param hooks - Late-bound cleanup steps (see {@link ShutdownHooks}).
 */
export function createShutdownTrigger(onDone: () => void, hooks: ShutdownHooks = {}): () => void {
  return () => {
    void runShutdownSequence(hooks).finally(onDone)
  }
}

// ── SMI-5640: periodic autosave (WASM driver only) ──────────────────────────

/** Structural shape of the WASM driver's explicit persist method. Not on the
 * shared `Database`/`DatabaseType` interface — `SqlJsDatabaseAdapter` alone
 * exposes it (`sqljsDriver.ts`). Kept localized here (a structural guard)
 * rather than widening the shared interface, since the native
 * (better-sqlite3) driver has no meaningful equivalent — it writes through
 * to disk on every statement and needs no timer. */
type Persistable = { persist: () => void }

function isPersistable(db: unknown): db is Persistable {
  return !!db && typeof (db as Partial<Persistable>).persist === 'function'
}

/**
 * Fail-soft periodic persist for the WASM driver (SMI-5640): calls the
 * driver's own `persist()` (export + `writeFileSync`, without tearing down
 * the WASM instance — see the design doc §3.1 for why this is preferred over
 * `close()`+reopen). No-op on the native (better-sqlite3) driver — it has no
 * `persist` method and needs none — and on a closed or in-memory db.
 */
export function persistDbIfSupported(getDb?: () => DatabaseType | undefined): void {
  try {
    const db = getDb?.()
    if (db && db.open && !db.memory && isPersistable(db)) {
      db.persist()
    }
  } catch (error) {
    logger.error(
      '[skillsmith] Periodic autosave persist failed — recent writes may not survive an ungraceful kill',
      { err: error }
    )
  }
}

/**
 * Start the periodic autosave timer (SMI-5640): defense-in-depth for an
 * *ungraceful* kill (SIGKILL, crash, power loss) that no shutdown hook can
 * ever catch. Only arms the timer for a WASM + file-backed db — no pointless
 * wakeups on the native path or in-memory tests. `unref()`'d so it can never
 * keep the event loop alive or block process exit.
 *
 * Cadence: `SKILLSMITH_AUTOSAVE_INTERVAL_MS` env override, else
 * {@link DEFAULT_AUTOSAVE_INTERVAL_MS} (5 minutes — see design doc §3.3 for
 * the cost/benefit rationale). Disable entirely via
 * `SKILLSMITH_AUTOSAVE_DISABLE=1`.
 *
 * The flush callback no-ops while `shuttingDown` is set — the shutdown
 * sequence owns the final persist (step 3 above), so once it starts, the
 * timer callback (if it fires again before `stopPeriodicFlush()` clears it)
 * must not race it. See design doc §3.5 for the full flush-vs-live-query
 * atomicity argument (every driver op is synchronous within one microtask,
 * so a timer-driven `persist()` can never observe a half-applied statement).
 */
export function startPeriodicFlush(getDb: () => DatabaseType | undefined): void {
  if (process.env.SKILLSMITH_AUTOSAVE_DISABLE === '1') return
  const db = getDb()
  if (!db || db.memory || !isPersistable(db)) return // WASM + file-backed only
  const intervalMs =
    Number(process.env.SKILLSMITH_AUTOSAVE_INTERVAL_MS) || DEFAULT_AUTOSAVE_INTERVAL_MS
  flushTimer = setInterval(() => {
    if (shuttingDown) return // shutdown owns the final persist
    persistDbIfSupported(getDb)
  }, intervalMs)
  flushTimer.unref?.()
}

/** Stop the periodic autosave timer. Idempotent. Called as step 0 of
 * {@link runShutdownSequence} and by {@link _resetShutdownGuardForTests}. */
export function stopPeriodicFlush(): void {
  if (flushTimer) {
    clearInterval(flushTimer)
    flushTimer = null
  }
}
