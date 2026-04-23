/**
 * SMI-4415: Signal-of-intent gate for the GitHub importer.
 *
 * Purpose: between the de-duplication step and the blocklist / saveOutput
 * step in `import-github-skills.ts`, drop repositories that do not exhibit
 * a *structural* signal of being a Claude Code skill. This is the Tier 2
 * companion to SMI-4408's tactical blocklist — the blocklist catches known
 * bad repos by exact match, this gate catches the long tail by shape.
 *
 * Design:
 *  - Multi-signal composite score (Option D in the SMI-4415 plan).
 *  - **Structural-signal floor** (plan-review H4): `shouldIngest` requires
 *    BOTH `hasStructuralSignal === true` AND `score >= threshold`. This
 *    closes the pure-metadata gaming hole where description (+2) + name
 *    regex (+2) alone could clear the threshold with zero structural proof.
 *  - Zero extra GitHub API calls — only reads fields already present on
 *    `ImportedSkill` (populated from the GitHub search response).
 *
 * Plan: docs/internal/implementation/smi-4415-indexer-signal-of-intent.md
 */

import type { ImportedSkill } from './types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default signal-score threshold. Revisit against the Wave 0 evidence
 * before tuning; changes with a ≥20% `intent_admit_rate` delta against
 * the rolling baseline require plan-review.
 */
export const SIGNAL_THRESHOLD = 4

/**
 * Structural topic tags that constitute a "this is a Claude skill" signal
 * at the highest weight (+4). Matching is case-insensitive against
 * `ImportedSkill.topics`.
 *
 * Wave 0 R1 expanded this set to include `agent-skills` and `agent-skill`
 * after fixture verification showed `anthropics/skills` (121k stars) and
 * `prismatic-io/prismatic-skills` (26 stars) rely on those conventions
 * rather than the older `claude-skill` / `claude-code-skill` tags.
 */
const STRUCTURAL_TOPIC_SET: ReadonlySet<string> = new Set([
  'claude-skill',
  'claude-code-skill',
  'anthropic-skill',
  'agent-skills',
  'agent-skill',
])

/** Secondary structural topic — contributes +1 (not enough to clear threshold alone). */
const MCP_SERVER_TOPIC = 'mcp-server'

/**
 * Owner-level trust list. Any repository whose `author` matches an entry
 * here is deemed to carry author-vouched intent, worth +5 (enough to clear
 * the default threshold on its own).
 *
 * TRUTH SOURCE: `supabase/functions/indexer/high-trust-authors.ts`
 * (distinct `.owner` values from the `HIGH_TRUST_AUTHORS` array).
 * Cross-boundary imports from `supabase/functions/` into `packages/core/`
 * are unsupported (the Edge Function pipeline compiles under Deno, not
 * Node), so the values are duplicated here and must be **manually synced**
 * when that file changes. The two files are the authoritative pair for
 * "trusted owner."
 *
 * Wave 0 R2 added `daymade` — `daymade/claude-code-skills` (901⭐ community
 * marketplace) has no topics and would otherwise fail the structural floor
 * despite legitimate intent. Author manually verified 2026-04-21.
 *
 * Matching: case-insensitive (done in `isHighTrustOwner`).
 */
export const HIGH_TRUST_OWNERS: ReadonlySet<string> = new Set([
  'anthropics',
  'huggingface',
  'vercel-labs',
  'resend',
  'addyosmani',
  'amplitude',
  'microsoft',
  'google-gemini',
  'awslabs',
  'SalesforceCommerceCloud',
  // Wave 0 R2: manually verified community author.
  'daymade',
])

// ---------------------------------------------------------------------------
// Weight configuration
// ---------------------------------------------------------------------------

/**
 * Scoring weights. Mirrors the table in the plan (Wave 1 Step 1).
 *
 * Structural signals (`*_STRUCTURAL`) are the only ones that can satisfy
 * the `hasStructuralSignal` floor required by `shouldIngest`. Metadata
 * signals (description, name, language, license, stars) contribute to
 * the score but cannot cross the floor by themselves.
 */
const WEIGHTS = {
  STRUCTURAL_TOPIC: 4, // structural
  MCP_SERVER_TOPIC: 1, // structural
  HIGH_TRUST_OWNER: 5, // structural
  DESCRIPTION_MATCH: 2, // metadata
  NAME_MATCH: 2, // metadata
  LANGUAGE_MATCH: 1, // metadata
  LICENSE_PRESENT: 1, // metadata
  STARS_THRESHOLD: 1, // metadata
} as const

const METADATA_LANGUAGES: ReadonlySet<string> = new Set(['Markdown', 'TypeScript', 'JavaScript'])

const STARS_THRESHOLD = 10

// The regex set — module-level so we don't reallocate them per-repo.
const DESCRIPTION_REGEX = /skill|claude-code|claude code|anthropic/i
const NAME_REGEX = /^claude-(code-)?skills?|-skill$/i

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Case-insensitive owner lookup. Kept separate so the HIGH_TRUST_OWNERS
 * set can be iterated at load time without normalizing all entries.
 */
function isHighTrustOwner(author: string): boolean {
  if (!author) return false
  const normalized = author.toLowerCase()
  for (const owner of HIGH_TRUST_OWNERS) {
    if (owner.toLowerCase() === normalized) return true
  }
  return false
}

function hasStructuralTopic(topics: readonly string[] | undefined): boolean {
  if (!topics || topics.length === 0) return false
  for (const topic of topics) {
    if (STRUCTURAL_TOPIC_SET.has(topic.toLowerCase())) return true
  }
  return false
}

function hasMcpServerTopic(topics: readonly string[] | undefined): boolean {
  if (!topics || topics.length === 0) return false
  for (const topic of topics) {
    if (topic.toLowerCase() === MCP_SERVER_TOPIC) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SignalScore {
  /** Sum of weights for every signal that fired. */
  score: number
  /**
   * Human-readable labels for each fired signal — surfaced in import
   * stats (`rejected_for_intent_reasons`) for audit and debugging.
   */
  signals: string[]
  /**
   * True iff at least one structural signal fired. Required (in addition
   * to score >= threshold) by `shouldIngest` per plan-review H4.
   */
  hasStructuralSignal: boolean
}

/**
 * Compute the signal-of-intent score for a single imported skill candidate.
 *
 * Reads only fields already present on `ImportedSkill` — zero additional
 * GitHub API calls. Designed to be cheap enough to run on every deduped
 * repo per import run.
 */
export function computeSignalScore(skill: ImportedSkill): SignalScore {
  const signals: string[] = []
  let score = 0
  let hasStructuralSignal = false

  // ---- Structural signals --------------------------------------------------
  if (hasStructuralTopic(skill.topics)) {
    score += WEIGHTS.STRUCTURAL_TOPIC
    signals.push('structural-topic')
    hasStructuralSignal = true
  }

  if (hasMcpServerTopic(skill.topics)) {
    score += WEIGHTS.MCP_SERVER_TOPIC
    signals.push('mcp-server-topic')
    hasStructuralSignal = true
  }

  if (isHighTrustOwner(skill.author)) {
    score += WEIGHTS.HIGH_TRUST_OWNER
    signals.push('high-trust-owner')
    hasStructuralSignal = true
  }

  // ---- Metadata signals ----------------------------------------------------
  if (skill.description && DESCRIPTION_REGEX.test(skill.description)) {
    score += WEIGHTS.DESCRIPTION_MATCH
    signals.push('description-match')
  }

  if (skill.name && NAME_REGEX.test(skill.name)) {
    score += WEIGHTS.NAME_MATCH
    signals.push('name-match')
  }

  if (skill.language && METADATA_LANGUAGES.has(skill.language)) {
    score += WEIGHTS.LANGUAGE_MATCH
    signals.push('language-match')
  }

  if (skill.license !== null && skill.license !== undefined) {
    score += WEIGHTS.LICENSE_PRESENT
    signals.push('license-present')
  }

  if (typeof skill.stars === 'number' && skill.stars >= STARS_THRESHOLD) {
    score += WEIGHTS.STARS_THRESHOLD
    signals.push('stars-threshold')
  }

  return { score, signals, hasStructuralSignal }
}

/**
 * Intent-gate decision for a single imported skill candidate.
 *
 * Requires BOTH:
 *  1. `hasStructuralSignal === true` — at least one structural signal
 *     (topic tag OR HIGH_TRUST_OWNERS membership) fired. This is the
 *     plan-review H4 floor.
 *  2. `score >= threshold` — the composite score clears the cutoff.
 *
 * Metadata-only matches (description + name + language + license + stars)
 * can contribute to the score but will fail on the floor regardless of
 * how high the sum reaches.
 *
 * @param skill - Deduped importer candidate.
 * @param threshold - Defaults to `SIGNAL_THRESHOLD` (4).
 */
export function shouldIngest(skill: ImportedSkill, threshold: number = SIGNAL_THRESHOLD): boolean {
  const { score, hasStructuralSignal } = computeSignalScore(skill)
  return hasStructuralSignal && score >= threshold
}
