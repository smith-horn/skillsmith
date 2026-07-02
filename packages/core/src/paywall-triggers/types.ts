/**
 * Trigger-state types (SMI-5456 Wave 1 Step 5, QD-3).
 *
 * @module @skillsmith/core/paywall-triggers/types
 */

/** Paywall trigger IDs from PRD §8.1 (T1 version currency, T2 quota forecast, T3 sharing, T4 security depth). */
export type TriggerId = 'T1' | 'T2' | 'T3' | 'T4'

/** Days a trigger stays muted after its dismissal threshold is reached (PRD §8.1 principle 2). */
export const TRIGGER_MUTE_DAYS = 30

/** Dismissals before a trigger is muted (PRD §8.1: "two dismissals... suppress it for 30 days"). */
export const TRIGGER_DISMISSAL_THRESHOLD = 2

/** On-disk per-trigger state (`~/.skillsmith/paywall-triggers/<id>.json`). */
export interface TriggerState {
  schema: 1
  triggerId: TriggerId
  /** Session id of the last session this trigger was shown in, or null. */
  lastSessionShown: string | null
  /** Total dismissal count (never resets, even after a mute expires). */
  dismissalCount: number
  /** Epoch-ms the mute lifts, or null when not currently muted. */
  mutedUntil: number | null
}

export function emptyTriggerState(triggerId: TriggerId): TriggerState {
  return { schema: 1, triggerId, lastSessionShown: null, dismissalCount: 0, mutedUntil: null }
}
