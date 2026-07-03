/**
 * @fileoverview Flush-on-shutdown wiring for the Skillsmith MCP server (SMI-5479).
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
 */

import { shutdownPostHog } from '@skillsmith/core/telemetry'

/** Bound on how long a shutdown flush may block process exit. */
export const TELEMETRY_SHUTDOWN_FLUSH_TIMEOUT_MS = 2000

let shuttingDown = false

/**
 * Attempt to flush + shut down the PostHog client, bounded by `timeoutMs`
 * (`Promise.race` against a plain timer) so a hung PostHog client can never
 * block process exit. Fail-soft — mirrors `shutdownPostHog`'s own internal
 * try/catch; a flush error must never propagate.
 *
 * Idempotent within a process: a second call while a flush is already in
 * flight (or has completed) is a no-op, so wiring this to multiple shutdown
 * triggers (transport close, SIGTERM, SIGINT) can never double-flush or race.
 */
export async function flushTelemetryOnShutdown(
  timeoutMs: number = TELEMETRY_SHUTDOWN_FLUSH_TIMEOUT_MS
): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
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
 * Test-only reset of the module-level shutdown guard. Not exported from the
 * package index.
 */
export function _resetShutdownGuardForTests(): void {
  shuttingDown = false
}

/**
 * Build a shutdown trigger: run {@link flushTelemetryOnShutdown} then call
 * `onDone` (index.ts passes `() => process.exit(0)`). Registering ANY
 * listener for SIGTERM/SIGINT overrides Node's default terminate-on-signal
 * behavior, so `index.ts` MUST call this for each of transport `onclose` /
 * SIGTERM / SIGINT to preserve today's default (process exits promptly on
 * those signals) rather than leaving the process hanging once a listener is
 * registered.
 */
export function createShutdownTrigger(onDone: () => void): () => void {
  return () => {
    void flushTelemetryOnShutdown().finally(onDone)
  }
}
