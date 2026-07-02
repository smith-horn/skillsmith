/**
 * @fileoverview Public barrel for the paywall trigger-state store (SMI-5456
 *               Wave 1 Step 5, QD-3). See `store.ts`'s module header for the
 *               Wave-1 scope limitation on in-conversation dismissal
 *               recording, and `path.ts`'s header for why this module is
 *               `paywall-triggers/`, not `triggers/` (a pre-existing,
 *               unrelated module owns that name).
 * @module @skillsmith/core/paywall-triggers
 */

export {
  TRIGGER_DISMISSAL_THRESHOLD,
  TRIGGER_MUTE_DAYS,
  emptyTriggerState,
  type TriggerId,
  type TriggerState,
} from './types.js'

export {
  TRIGGER_STATE_DIR_ENV_VAR,
  getNudgeCooldownState,
  getTriggerStateDirForTests,
  getTriggerStateFilePath,
} from './path.js'

export {
  canShowTrigger,
  isTriggerMuted,
  loadTriggerState,
  recordImpression,
  recordTriggerDismissal,
} from './store.js'
