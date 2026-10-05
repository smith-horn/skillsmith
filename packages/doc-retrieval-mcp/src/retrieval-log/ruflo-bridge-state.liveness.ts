/**
 * SMI-6744 A5.5.2 liveness arm, split out of `ruflo-bridge-state.ts` to stay
 * under this repo's <500-line-per-file convention (CLAUDE.md § CI Health
 * Requirements). One-way dependency only: this file imports the `BridgeEntry`
 * type from `ruflo-bridge-state.ts`, never the reverse at the value level —
 * the main module re-exports {@link foldLiveness} so callers (and the
 * writer) still import everything from that one entry point.
 *
 * SMI-6967 H-1 rewrite (misreading correction), then reverted by SMI-6985
 * (corrected in place rather than appended below — see
 * `ruflo-bridge-state.render.ts`'s `renderBridgeLivenessLine` doc comment for
 * the full history). H-1's decision was to gate the arm on a PRODUCER
 * EXISTING rather than on learning having happened, because the prior (H-9)
 * implementation conflated the two onto one flag (`everLearned`), making a
 * connected bridge with real store entries that has simply never produced a
 * pattern or trajectory permanently unreportable. SMI-6985 found that gate
 * itself wrong: measured live, nothing in this repository calls the
 * trajectory-capture hooks at all, so "a producer exists" is permanently
 * true here and the H-1 gate fired perpetually, un-actionably. This fold
 * still tracks two latches that never collapse into each other, but their
 * roles are reversed from H-1's:
 *   - `everLearned` (role restored): GATES the arm. Latches the first time
 *     any probe observes a counter above zero.
 *   - `everProducerPresent` (role retired, still folded): latches from the
 *     probe observing `bridge.status === 'connected'` and/or
 *     `agentdb.totalEntries > 0` — passed in as `producerPresentThisProbe` —
 *     but no longer gates or words anything; kept in case a future consumer
 *     needs "has a producer ever existed" as its own signal.
 * A fresh checkout with no payload at all still renders nothing: neither
 * latch is ever set from a probe that could not ask.
 *
 * SMI-6967 M-5 (two more findings from the same review):
 *   - A counter DECREASE (the store was wiped/reset) is the loudest possible
 *     signal for a feature about bridge integrity, and used to be
 *     indistinguishable from steady progress (both reset the streak to 0).
 *     `countersRegressed` surfaces it explicitly, for exactly the probe that
 *     observed the decrease — it is not latched, the same scope `verdict`
 *     itself has.
 *   - A PARTIAL read (one counter valid, the other not) used to be collapsed
 *     into a full not-observed probe, discarding a real reading on the valid
 *     axis. Each axis is now folded independently; only an axis actually
 *     read this probe can move that axis's own baseline, and "unchanged"
 *     requires every axis that WAS read to agree with its own baseline (an
 *     axis not read this probe agrees trivially — nothing moved it).
 *   - A migration from a pre-H-9 entry (no `lastObservedPatternsLearned`/
 *     `lastObservedTrajectoriesRecorded` fields at all — `undefined`, never
 *     written) now seeds the baseline from the entry's own legacy
 *     `patternsLearned`/`trajectoriesRecorded` reading when that was itself a
 *     valid number, instead of silently discarding it and costing a whole
 *     probe cycle re-establishing it. Distinct from an H-9-era entry's own
 *     explicit `null` ("armed, but never yet observed"), which is NOT
 *     migrated — `undefined` is the only trigger.
 *
 * SMI-6967 L-1: every external counter is validated as a finite,
 * non-negative number before any `>`/`<`/`===` comparison — an untrusted
 * JSON value (`0.5`, `"5"`, `Infinity`, `true`, `[1]`, a negative number)
 * must never arm a latch or move a counter. An invalid value is treated
 * exactly like a missing (`null`) reading on that axis.
 *
 * SMI-6967 PR-gate (H-A) correction: {@link isValidCount} is now exported and
 * re-exported from `ruflo-bridge-state.ts` (the same single-entry-point
 * pattern as {@link foldLiveness}) so `scripts/ruflo-bridge-probe.mjs`'s own
 * `isProducerPresent()` can import this SAME validator for
 * `agentdb.totalEntries`, rather than carrying a second, laxer copy
 * (`Number.isFinite`, which wrongly accepted `0.5`) one function over. One
 * source of truth for "what counts as a valid non-negative integer read from
 * untrusted JSON" — never a second predicate that can drift from this one.
 *
 * SMI-6985 correction of record (owner-decided, superseding the H-1 rewrite
 * above as the render-time GATE, corrected in place rather than appended
 * below): `everProducerPresent` is still folded here exactly as H-1 describes
 * — latched, never un-latched, independent of `everLearned` — but
 * `ruflo-bridge-state.render.ts`'s `renderBridgeLivenessLine` no longer gates
 * on it. Measured live: nothing in this repository calls the trajectory-
 * capture hooks at all, so on a real connected bridge with a non-empty store
 * (this checkout's actual, permanent state), `everProducerPresent` latches
 * immediately and stays true forever while `everLearned` never does — the
 * H-1 gate therefore fired "has never recorded a pattern or trajectory"
 * perpetually, on a condition nobody could act on. The render layer now
 * gates on `everLearned` instead (see that function's own doc comment for
 * the full correction). `everProducerPresent` remains folded here, unused by
 * the render layer today, in case a future consumer needs "has a producer
 * ever existed" as a distinct signal from "has it ever learned anything."
 *
 * **Follow-on filed, not built (SMI-6985):** once a trajectory writer exists
 * and the liveness arm can actually arm, a payload that answers but omits
 * `intelligence.patternsLearned`/`.trajectoriesRecorded` would silently
 * freeze `consecutiveNoLearning` forever (the "nothing observed this probe"
 * branch below carries it forward unchanged) — the same silent-stall shape
 * one layer out. See `renderBridgeLivenessLine`'s own doc comment for why
 * that fix (a `consecutiveCountersUnreadable`-shaped streak) is deliberately
 * not implemented yet: the arm it would protect cannot currently arm at all.
 */

import type { BridgeEntry } from './ruflo-bridge-state.js'

/** Return shape of {@link foldLiveness} — the liveness-owned fields of an entry, folded together in one place. */
export interface BridgeLivenessFold {
  consecutiveNoLearning: number
  everLearned: boolean
  everProducerPresent: boolean
  countersRegressed: boolean
  lastObservedPatternsLearned: number | null
  lastObservedTrajectoriesRecorded: number | null
}

/**
 * SMI-6967 L-1 — never trust an external JSON counter before comparing it.
 * These are COUNTS (`patternsLearned`/`trajectoriesRecorded`), so the valid
 * set is non-negative INTEGERS, not merely finite numbers — measured arming
 * on `0.5` is exactly the gap a bare `Number.isFinite` check leaves open
 * (0.5 passes `isFinite` and `>= 0` but is not a count any real probe would
 * ever produce). `Number.isInteger` also rejects `Infinity`/`NaN` on its
 * own, so no separate finiteness check is needed.
 */
export function isValidCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * SMI-6967 M-5 migration seed. `baseline` is read via optional chaining so a
 * pre-H-9 entry that never had the field at all reads as `undefined` —
 * DISTINCT from an H-9-era entry's own explicit `null`. Only the `undefined`
 * case falls back to the entry's legacy raw reading.
 */
function seedBaseline(
  baseline: number | null | undefined,
  legacy: number | null | undefined
): number | null {
  if (baseline !== undefined) return baseline
  return isValidCount(legacy) ? legacy : null
}

/**
 * Folds one probe's observed counters (and producer-presence signal) into
 * the prior entry's liveness state. See this module's own doc comment for
 * the full H-1/M-5/L-1 rationale. `producerPresentThisProbe` is `null` when
 * the probe could not even ask (e.g. the server was unreachable this round).
 */
export function foldLiveness(
  prior: BridgeEntry | null,
  patternsLearned: number | null,
  trajectoriesRecorded: number | null,
  producerPresentThisProbe: boolean | null = null
): BridgeLivenessFold {
  const priorEverLearned = prior?.everLearned === true
  const priorEverProducerPresent = prior?.everProducerPresent === true
  const priorLastP = seedBaseline(prior?.lastObservedPatternsLearned, prior?.patternsLearned)
  const priorLastT = seedBaseline(
    prior?.lastObservedTrajectoriesRecorded,
    prior?.trajectoriesRecorded
  )
  const priorStreak = prior?.consecutiveNoLearning ?? 0

  const everProducerPresent = priorEverProducerPresent || producerPresentThisProbe === true

  const pValid = isValidCount(patternsLearned)
  const tValid = isValidCount(trajectoriesRecorded)

  if (!pValid && !tValid) {
    // Nothing observed this probe at all (unreachable server, or a payload
    // whose counters were both missing or both invalid) — carry everything
    // else forward unchanged.
    return {
      consecutiveNoLearning: priorStreak,
      everLearned: priorEverLearned,
      everProducerPresent,
      countersRegressed: false,
      lastObservedPatternsLearned: priorLastP,
      lastObservedTrajectoriesRecorded: priorLastT,
    }
  }

  const pNum = pValid ? (patternsLearned as number) : null
  const tNum = tValid ? (trajectoriesRecorded as number) : null

  const pBaseline = pValid ? (pNum as number) : priorLastP
  const tBaseline = tValid ? (tNum as number) : priorLastT

  const pRegressed = pValid && priorLastP !== null && (pNum as number) < priorLastP
  const tRegressed = tValid && priorLastT !== null && (tNum as number) < priorLastT
  const regressed = pRegressed || tRegressed

  // An axis not read this probe agrees with its own baseline trivially
  // (nothing moved it); an axis that WAS read agrees only if it equals its
  // own prior baseline (and a prior baseline must exist to agree at all —
  // a first-ever observation on an axis is a change, not an agreement).
  const pUnchanged = pValid ? priorLastP !== null && pNum === priorLastP : true
  const tUnchanged = tValid ? priorLastT !== null && tNum === priorLastT : true
  const unchanged = pUnchanged && tUnchanged

  const everLearned =
    priorEverLearned || (pValid && (pNum as number) > 0) || (tValid && (tNum as number) > 0)

  return {
    consecutiveNoLearning: regressed ? 0 : unchanged ? priorStreak + 1 : 0,
    everLearned,
    everProducerPresent,
    countersRegressed: regressed,
    lastObservedPatternsLearned: pBaseline,
    lastObservedTrajectoriesRecorded: tBaseline,
  }
}
