/**
 * SMI-6744 A5.5.2 liveness arm, split out of `ruflo-bridge-state.ts` to stay
 * under this repo's <500-line-per-file convention (CLAUDE.md § CI Health
 * Requirements). One-way dependency only: this file imports the `BridgeEntry`
 * type from `ruflo-bridge-state.ts`, never the reverse at the value level —
 * the main module re-exports {@link foldLiveness} so callers (and the
 * writer) still import everything from that one entry point.
 */

import type { BridgeEntry } from './ruflo-bridge-state.js'

/** Return shape of {@link foldLiveness} — the three fields of an entry that the liveness arm owns, folded together in one place. */
export interface BridgeLivenessFold {
  consecutiveNoLearning: number
  everLearned: boolean
  lastObservedPatternsLearned: number | null
  lastObservedTrajectoriesRecorded: number | null
}

/**
 * SMI-6967 H-9 rewrite. Folds one probe's observed counters into the prior
 * entry's liveness state, on three ways rather than two — the same
 * two-way-vs-three-way collapse this module's reader/writer axes were
 * already rewritten to remove:
 *
 * - NOT OBSERVED this probe (either counter `null` — server unreachable,
 *   malformed payload): the streak, the `everLearned` latch, and the
 *   last-observed baseline all carry forward UNCHANGED. A probe that could
 *   not read the counters must neither silently reset a real streak (the
 *   bug: a transient read failure used to zero it) nor silently advance one
 *   (nothing moved; nothing was even asked).
 * - OBSERVED, UNCHANGED (both counters equal the last-observed, non-null,
 *   baseline): the streak advances by one.
 * - OBSERVED, CHANGED (no non-null baseline yet, or either counter differs
 *   from it): the streak resets to 0 and the baseline becomes this probe's
 *   reading.
 *
 * `everLearned` latches `true` the first time either counter is observed
 * above zero, and never un-latches — the gate gating `renderBridgeLivenessLine`'s
 * render entirely: two equal zeros (nothing has ever produced a pattern or
 * trajectory yet, the documented out-of-scope case) no longer counts as
 * "unmoved," so the arm stays dormant instead of firing permanently within
 * days of a fresh checkout.
 */
export function foldLiveness(
  prior: BridgeEntry | null,
  patternsLearned: number | null,
  trajectoriesRecorded: number | null
): BridgeLivenessFold {
  const priorEverLearned = prior?.everLearned === true
  const priorLastP = prior?.lastObservedPatternsLearned ?? null
  const priorLastT = prior?.lastObservedTrajectoriesRecorded ?? null
  const priorStreak = prior?.consecutiveNoLearning ?? 0

  const observedThisProbe = patternsLearned !== null && trajectoriesRecorded !== null
  if (!observedThisProbe) {
    return {
      consecutiveNoLearning: priorStreak,
      everLearned: priorEverLearned,
      lastObservedPatternsLearned: priorLastP,
      lastObservedTrajectoriesRecorded: priorLastT,
    }
  }

  const everLearned = priorEverLearned || patternsLearned > 0 || trajectoriesRecorded > 0
  const hadBaseline = priorLastP !== null && priorLastT !== null
  const unchanged =
    hadBaseline && priorLastP === patternsLearned && priorLastT === trajectoriesRecorded

  return {
    consecutiveNoLearning: unchanged ? priorStreak + 1 : 0,
    everLearned,
    lastObservedPatternsLearned: patternsLearned,
    lastObservedTrajectoriesRecorded: trajectoriesRecorded,
  }
}
