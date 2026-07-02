/**
 * Paywall trigger-state store (SMI-5456 Wave 1 Step 5, QD-3).
 *
 * PRD §8.1 defines four paywall triggers (T1 version currency, T2 quota
 * forecast, T3 sharing, T4 security-depth disclosure) with two frequency
 * rules: at most one upgrade prompt per session, and two dismissals of the
 * same trigger suppress it for 30 days. This module persists the state those
 * rules need — per-trigger last-shown session id, dismissal count, and mute
 * expiry — under `~/.skillsmith/paywall-triggers/` (deliberately NOT
 * `~/.skillsmith/triggers/` — see `path.ts`'s header for the pre-existing,
 * unrelated `packages/core/src/triggers/` module this avoids colliding with).
 *
 * WAVE-1 SCOPE LIMITATION (read before wiring this into anything):
 * The trigger RULES live in the pack's prompt wording (PRD §6 change 6) —
 * the agent, running inside whatever harness's model, decides in
 * conversation whether to mention a trigger, and the user's response
 * ("no thanks") is plain conversational text the agent sees, not a
 * structured tool call. There is currently NO MCP tool or CLI command that
 * reports a T1/T2/T4 dismissal from that conversation into this store — no
 * Wave-1 exclusion-9 tool covers it (PRD §10 exclusion 9's only two
 * acknowledged exceptions are the undo tool and the Wave-2 stats surface).
 * That means: {@link recordTriggerDismissal} is real, tested infrastructure
 * with NO live caller in Wave 1. This is intentional staged infrastructure
 * (the same shape the change-journal module shipped in — Step 3, before the
 * apply tools became its first real caller in a later step) — NOT an
 * "unconsumed dismissal-recording pathway" in the house anti-pattern sense,
 * because nothing in this codebase currently calls it as if dismissals were
 * being captured. Do not present in-conversation dismissal tracking as a
 * shipped product behavior (docs, marketing copy, the eval-matrix report)
 * until a real consumer exists. What DOES already work end-to-end in Wave 1:
 * the session-cap half via {@link canShowTrigger}/{@link recordImpression} —
 * though even that has no live caller yet either, since trigger *display*
 * also currently lives entirely in the pack's prompt wording. Both halves
 * are ready for whichever surface (a future tool, or a CLI diagnostic) needs
 * them; the eval-matrix worker (Step 6) should treat "trigger frequency cap
 * enforced server-side" as NOT YET TRUE for the published Tier badges.
 *
 * Single-writer-per-trigger-file note: like the journal (P-5), each trigger
 * file is read-modify-written directly (not append-only, since there's only
 * ever one live state per trigger, not a growing log) — concurrent writers
 * to the SAME trigger id are not expected in Wave 1 (no live caller), so no
 * write-queue serialization is implemented here; add one if/when a consumer
 * with real concurrency (e.g. two parallel MCP requests) lands.
 *
 * @module @skillsmith/core/paywall-triggers/store
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { getTriggerStateFilePath } from './path.js'
import {
  TRIGGER_DISMISSAL_THRESHOLD,
  TRIGGER_MUTE_DAYS,
  emptyTriggerState,
  type TriggerId,
  type TriggerState,
} from './types.js'

const MUTE_DURATION_MS = TRIGGER_MUTE_DAYS * 24 * 60 * 60 * 1000

/** Load a trigger's persisted state, or a fresh empty state if none exists or it is corrupt. */
export function loadTriggerState(triggerId: TriggerId): TriggerState {
  const path = getTriggerStateFilePath(triggerId)
  if (!existsSync(path)) return emptyTriggerState(triggerId)
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<TriggerState>
    if (parsed.triggerId !== triggerId) return emptyTriggerState(triggerId)
    return {
      schema: 1,
      triggerId,
      lastSessionShown:
        typeof parsed.lastSessionShown === 'string' ? parsed.lastSessionShown : null,
      dismissalCount: typeof parsed.dismissalCount === 'number' ? parsed.dismissalCount : 0,
      mutedUntil: typeof parsed.mutedUntil === 'number' ? parsed.mutedUntil : null,
    }
  } catch {
    return emptyTriggerState(triggerId)
  }
}

function saveTriggerState(state: TriggerState): void {
  const path = getTriggerStateFilePath(state.triggerId)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
}

/**
 * Is `triggerId` currently muted (30-day suppression after
 * {@link TRIGGER_DISMISSAL_THRESHOLD} dismissals)?
 *
 * @param now - injectable clock for tests.
 */
export function isTriggerMuted(state: TriggerState, now: number = Date.now()): boolean {
  return state.mutedUntil !== null && now < state.mutedUntil
}

/**
 * P-5 "one prompt per session enforced from persisted state, not memory":
 * true when `triggerId` has NOT already been shown in `sessionId` AND is not
 * currently muted. Concurrent sessions may each independently see `true` and
 * both prompt once — accepted, documented (P-5 table).
 */
export function canShowTrigger(
  triggerId: TriggerId,
  sessionId: string,
  now: number = Date.now()
): boolean {
  const state = loadTriggerState(triggerId)
  if (isTriggerMuted(state, now)) return false
  return state.lastSessionShown !== sessionId
}

/** Record that `triggerId` was shown in `sessionId` (persisted — the session cap). */
export function recordImpression(triggerId: TriggerId, sessionId: string): TriggerState {
  const state = loadTriggerState(triggerId)
  const next: TriggerState = { ...state, lastSessionShown: sessionId }
  saveTriggerState(next)
  return next
}

/**
 * Record a dismissal. On reaching {@link TRIGGER_DISMISSAL_THRESHOLD}
 * dismissals, sets a {@link TRIGGER_MUTE_DAYS}-day mute from `now`.
 *
 * See the module header: no Wave-1 caller reports a real in-conversation
 * dismissal today. This function is correct, tested library code — not an
 * inert stub — for whichever surface becomes that caller.
 */
export function recordTriggerDismissal(
  triggerId: TriggerId,
  now: number = Date.now()
): TriggerState {
  const state = loadTriggerState(triggerId)
  const dismissalCount = state.dismissalCount + 1
  const mutedUntil =
    dismissalCount >= TRIGGER_DISMISSAL_THRESHOLD ? now + MUTE_DURATION_MS : state.mutedUntil
  const next: TriggerState = { ...state, dismissalCount, mutedUntil }
  saveTriggerState(next)
  return next
}
