/**
 * SMI-6744 A5.5.2(b)/(c) delta — the persisted bridge-verdict entry shape,
 * split out of `ruflo-bridge-state.ts` to stay under this repo's
 * <500-line-per-file convention (CLAUDE.md § CI Health Requirements). A leaf
 * module: no dependency on the rest of that file, which re-exports
 * everything here so callers keep importing from the one entry point.
 *
 * SMI-6967 H-1/M-5 correction, then SMI-6985 correction of record (corrected
 * in place rather than appended below): two liveness-related latches live on
 * this entry, and they answer DIFFERENT questions — never collapse them (see
 * `ruflo-bridge-state.liveness.ts`'s own doc comment for the full fold):
 *   - `everLearned` gates whether the liveness arm can fire AT ALL (SMI-6985,
 *     reverting SMI-6967 H-1's `everProducerPresent` gate). It latches from
 *     the counters' own history — `patternsLearned`/`trajectoriesRecorded`
 *     observed above zero at least once — because the owner found, measured
 *     live, that "a producer exists" is the wrong gate: nothing in this
 *     repository calls the trajectory-capture hooks at all, so a connected
 *     bridge with a non-empty store (this checkout's actual, permanent
 *     state) armed the H-1 gate immediately and fired perpetually, on a
 *     condition nobody could act on.
 *   - `everProducerPresent` stays folded (latches from a producer actually
 *     existing — the bridge reported `connected`, or the store already held
 *     entries — nothing stronger) but no longer gates or words anything;
 *     nothing currently reads it. See `ruflo-bridge-state.render.ts`'s
 *     `renderBridgeLivenessLine` doc comment for the full correction.
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
   * counted only once {@link everLearned} has armed the arm (SMI-6985,
   * superseding SMI-6967 H-1's `everProducerPresent` gate — see
   * `ruflo-bridge-state.render.ts`'s `renderBridgeLivenessLine` doc comment
   * for the full correction of record). Reset to 0 by {@link countersRegressed}.
   */
  consecutiveNoLearning: number
  /**
   * SMI-6967 H-1: latches `true` the first time any probe observes a
   * PRODUCER — `bridge.status === 'connected'` and/or `agentdb.totalEntries
   * > 0` — and never un-latches. **SMI-6985 correction of record (owner-
   * decided, corrected in place): this field no longer gates
   * `renderBridgeLivenessLine`.** Measured live, nothing in this repository
   * ever calls the trajectory-capture hooks, so gating on "a producer exists"
   * made the arm fire perpetually and un-actionably on this checkout's
   * permanent, correct state (connected, non-empty store, nothing ever
   * learned). {@link everLearned} is the gate now — see that function's own
   * doc comment for the full history. This field stays folded (still
   * latched, still never un-latched) for a future consumer that needs
   * "has a producer ever existed" as its own signal; nothing reads it today.
   * Absent on an entry written before this field existed; readers must treat
   * `undefined` the same as `false` (dormant), never as `true` — the same
   * convention {@link everLearned} already uses.
   */
  everProducerPresent: boolean
  /**
   * SMI-6967 H-9: latches `true` the first time any probe observes a
   * counter above zero, and never un-latches. **SMI-6985 correction of
   * record: this is now the GATE for `renderBridgeLivenessLine`, not merely
   * its wording** — SMI-6967 H-1 had retired this field's gating role in
   * favor of {@link everProducerPresent}, which the SMI-6985 correction
   * found was gated on the wrong producer (a connected bridge, not a
   * trajectory writer — see `renderBridgeLivenessLine`'s own doc comment).
   * Absent on an entry written before this field existed; readers must
   * treat `undefined` the same as `false` (dormant), never as `true`.
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
