/**
 * SMI-6744 A5.5.2(b)/(c) delta — the persisted bridge-verdict entry shape,
 * split out of `ruflo-bridge-state.ts` to stay under this repo's
 * <500-line-per-file convention (CLAUDE.md § CI Health Requirements). A leaf
 * module: no dependency on the rest of that file, which re-exports
 * everything here so callers keep importing from the one entry point.
 *
 * SMI-6967 H-1/M-5 correction: two liveness-related latches live on this
 * entry, and they answer DIFFERENT questions — never collapse them (see
 * `ruflo-bridge-state.liveness.ts`'s own doc comment for the full fold):
 *   - `everProducerPresent` gates whether the liveness arm can fire AT ALL.
 *     It latches from a producer actually existing (the bridge reported
 *     `connected`, or the store already held entries) — nothing stronger.
 *   - `everLearned` never gates anything by itself any more (the H-1 bug: the
 *     old code gated the arm on THIS flag, making a connected bridge that
 *     has never produced a single pattern/trajectory permanently
 *     unreportable — precisely the silent-stall shape SMI-6744 exists to
 *     catch). It now only changes the WORDING of the rendered line once the
 *     arm is armed.
 */

/**
 * The detector's five-value vocabulary (`ruflo-bridge-verdict.mjs`) plus
 * `unreadable`, which the detector itself never returns — it is this
 * writer's own classification for "could not even reach the server to ask,"
 * adopted verbatim from A5.5.2. A verdict string outside this set (a future
 * upstream rewording, or a hand-edited state file) renders via
 * {@link renderBridgeVerdictLine}'s not-evaluated branch, never promoted to
 * the reader's own `malformed` axis below.
 */
export const KNOWN_VERDICTS = [
  'healthy',
  'degraded',
  // Written by the probe, not by the detector: the backend read clean but
  // identity or freshness could not be corroborated. Its own token because
  // "could not ask" is not "healthy" and its remedy (inspect the store and
  // the authority file) differs from the detector's 'malformed' (re-run the
  // detector against the payload).
  'unverified',
  'not-evaluated',
  'malformed',
  'unrecognized',
  'unreadable',
] as const
export type BridgeVerdictToken = (typeof KNOWN_VERDICTS)[number]

export function isKnownVerdict(v: string): v is BridgeVerdictToken {
  return (KNOWN_VERDICTS as readonly string[]).includes(v)
}

export interface BridgeEntry {
  /** ISO-8601 — when this probe completed (successfully or not). */
  evaluatedAt: string
  /** One of {@link KNOWN_VERDICTS}, or an out-of-set token from a future detector. */
  verdict: string
  reason: string
  /** `embeddingBackend` as observed this probe, when the payload carried one. */
  observedBackend: string | null
  /** `DERIVED_FROM.version` (ruflo-bridge-verdict.mjs) at probe time — remediation-command context. */
  derivedFromVersion: string | null
  patternsLearned: number | null
  trajectoriesRecorded: number | null
  /**
   * A5.5.2 liveness arm: consecutive probes with neither counter moved,
   * counted only once {@link everProducerPresent} has armed the arm (SMI-6967
   * H-1). Reset to 0 by {@link countersRegressed}.
   */
  consecutiveNoLearning: number
  /**
   * SMI-6967 H-1: latches `true` the first time any probe observes a
   * PRODUCER — `bridge.status === 'connected'` and/or `agentdb.totalEntries
   * > 0` — and never un-latches. Gates `renderBridgeLivenessLine` entirely:
   * before this is true there is nothing to report a stall about. Absent on
   * an entry written before this field existed; readers must treat
   * `undefined` the same as `false` (dormant), never as `true` — the same
   * convention {@link everLearned} already uses.
   */
  everProducerPresent: boolean
  /**
   * SMI-6967 H-9: latches `true` the first time any probe observes a
   * counter above zero, and never un-latches. SMI-6967 H-1 retires this
   * field's GATING role (see this file's own doc comment) — it is now used
   * only to WORD `renderBridgeLivenessLine`'s line once
   * {@link everProducerPresent} has armed it: a producer that has never
   * learned anything reads differently from one that learned and then
   * stalled. Absent on an entry written before this field existed; readers
   * must treat `undefined` the same as `false` (dormant), never as `true`.
   */
  everLearned: boolean
  /**
   * SMI-6967 M-5: `true` when the MOST RECENT probe observed either counter
   * strictly below its own last-observed baseline — the store was wiped or
   * reset, the loudest possible signal for a feature about bridge integrity,
   * previously indistinguishable from ordinary progress (both reset
   * {@link consecutiveNoLearning} to 0). Not latched: describes only the
   * latest probe, the same scope `verdict` itself has. Absent on an entry
   * written before this field existed; readers must treat `undefined` the
   * same as `false`.
   */
  countersRegressed: boolean
  /**
   * SMI-6967 H-9: the last NON-NULL pair of counters this checkout has
   * observed, carried forward unchanged across any probe that could not read
   * them (`patternsLearned`/`trajectoriesRecorded` above are THIS probe's own
   * raw reading, which can be null even when this baseline is not). This is
   * the baseline `foldLiveness` compares the next real observation against —
   * distinguishing "not observed this probe" from "observed and unchanged"
   * rather than letting a null reading silently reset or silently extend a
   * real streak. SMI-6967 M-5: a probe reading only ONE of the two axes now
   * moves only that axis's own baseline — see `ruflo-bridge-state.liveness.ts`.
   */
  lastObservedPatternsLearned: number | null
  lastObservedTrajectoriesRecorded: number | null
}

export type BridgeState = Record<string, BridgeEntry>
