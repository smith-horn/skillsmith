/**
 * Discovery topic rotation across UTC cron slots (Node port)
 * @module scripts/indexer/topic-rotation
 *
 * SMI-4852: Node-flavored sibling of `supabase/functions/indexer/topic-rotation.ts`.
 * Pure function — no env, no I/O, no fetches. Byte-identical to the Deno parent;
 * parity guarded by `scripts/indexer/tests/parity.test.ts`.
 *
 * SMI-4374: The indexer's discovery invocations at 06/12/18 UTC were saturating
 * Supabase's 150s wall-clock IDLE_TIMEOUT ceiling (3/3 recent scheduled
 * discovery slots timed out; passing runs finished at p95=113s / 75% of
 * ceiling) because each invocation scanned all 10 DEFAULT_TOPICS. Topic
 * search was ~57% of wall time; trimming to a 1/3 subset per slot cuts
 * that to ~21s and leaves ~80s headroom.
 *
 * This module partitions DEFAULT_TOPICS disjointly across the 3 existing
 * discovery cron slots. Invocation count stays at 4/day (respects parent
 * SMI-4118's quota-reduction goal — no new cron slots).
 *
 * Precedence (body wins over env wins over slot wins over fallback;
 * matches SMI-4241 maintenance pattern + preserves the existing
 * SKILLSMITH_INDEX_TOPICS escape hatch as an operator override):
 *   1. body.topics explicit array        → source='body_topics'
 *   2. SKILLSMITH_INDEX_TOPICS env var   → source='env'
 *   3. body.cronSlot ∈ {6, 12, 18}       → source='cron_slot'
 *   4. anything else (undefined / bad input / NaN / non-integer / string) → source='fallback'
 */

/**
 * Strict disjoint partitioning of DEFAULT_TOPICS across 3 discovery slots.
 * Union equals DEFAULT_TOPICS; pairwise intersections are empty.
 * See docs/internal/research/smi-4374-indexer-discovery-slot-split.md for the
 * sizing rationale.
 *
 * SMI-4388 (2026-04-21): Slot 18 previously held the three empty cross-ecosystem
 * topics (gemini-skill, gemini-cli-skill, ai-coding-skill). Redistributed to
 * hold the two plugin topics (claude-code-plugin, claude-plugin); slot 12 shed
 * those to preserve the 3/2/2 wall-clock balance established by SMI-4374. Total
 * topic count dropped from 10 to 7.
 */
export const DISCOVERY_SLOT_TOPICS: Readonly<Record<number, readonly string[]>> = Object.freeze({
  6: Object.freeze(['claude-code-skill', 'claude-code', 'anthropic-claude']),
  12: Object.freeze(['claude-skill', 'claude-skills']),
  18: Object.freeze(['claude-code-plugin', 'claude-plugin']),
})

/** Where the resolved topic list came from — surfaced in audit_logs.metadata. */
export type RotationSource = 'body_topics' | 'env' | 'cron_slot' | 'fallback'

/** Input to `selectTopics`. All fields optional; fallback handles every absence. */
export interface SelectTopicsInput {
  /** Operator override from `workflow_dispatch` or ad-hoc curl. */
  bodyTopics?: unknown
  /** SKILLSMITH_INDEX_TOPICS — pre-split via `.split(',').map(trim)` by caller. */
  envTopics?: string[] | undefined
  /** `body.cronSlot` as supplied by `indexer.yml`'s scheduled run path. */
  cronSlot?: unknown
  /** Full topic list for fallback — caller passes `DEFAULT_TOPICS`. */
  defaultTopics: readonly string[]
}

/** Output: selected topics + provenance label. */
export interface SelectTopicsResult {
  topics: string[]
  source: RotationSource
}

/**
 * Resolve the topic subset for an indexer discovery invocation.
 *
 * Pure function — no env reads, no clock reads, no Supabase I/O.
 * Caller is responsible for env + body destructuring.
 *
 * Behavior contract (tested in topic-rotation.test.ts):
 *   - body.topics array (non-empty) wins unconditionally.
 *   - env list (non-empty) wins next.
 *   - cronSlot in {6, 12, 18} selects the matching rotation subset.
 *   - any other cronSlot (7, -1, 6.5, NaN, Infinity, '6', undefined, null,
 *     boolean, object) falls through to DEFAULT_TOPICS. No exceptions thrown.
 *   - Returned `topics` is always a fresh mutable string[] (never exposes the
 *     frozen DISCOVERY_SLOT_TOPICS subarrays to the caller).
 */
export function selectTopics(input: SelectTopicsInput): SelectTopicsResult {
  const { bodyTopics, envTopics, cronSlot, defaultTopics } = input

  // 1. Operator override: explicit body.topics (array of strings).
  if (Array.isArray(bodyTopics) && bodyTopics.length > 0) {
    return { topics: [...(bodyTopics as string[])], source: 'body_topics' }
  }

  // 2. Env override: SKILLSMITH_INDEX_TOPICS (pre-parsed by caller).
  if (Array.isArray(envTopics) && envTopics.length > 0) {
    return { topics: [...envTopics], source: 'env' }
  }

  // 3. Slot rotation: accept only integers that map to a known slot. Reject
  //    strings (even stringified numbers), floats, NaN, Infinity, negatives,
  //    and unknown hours. Reject is silent — caller logs source='fallback'.
  if (
    typeof cronSlot === 'number' &&
    Number.isInteger(cronSlot) &&
    Number.isFinite(cronSlot) &&
    Object.prototype.hasOwnProperty.call(DISCOVERY_SLOT_TOPICS, cronSlot)
  ) {
    return {
      topics: [...DISCOVERY_SLOT_TOPICS[cronSlot]],
      source: 'cron_slot',
    }
  }

  // 4. Fallback: full DEFAULT_TOPICS (preserves pre-4374 ad-hoc curl behavior).
  return { topics: [...defaultTopics], source: 'fallback' }
}
