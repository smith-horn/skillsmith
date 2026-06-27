/**
 * @fileoverview Types for skill source provenance recovery.
 * @module @skillsmith/core/provenance/types
 * @see SMI-5407: Skill Source Provenance Recovery
 *
 * Recovers the canonical GitHub source of locally-installed skills so that
 * "Check for updates" (skill_outdated) and "View Changes" (skill_diff) can
 * resolve. All network/registry access is injected via {@link RecoveryDeps};
 * the core service performs no network I/O.
 */

/**
 * How a skill's source was recovered. Tiers are tried in confidence order.
 */
export type RecoveryMethod =
  | 'git-remote' // <dir>/.git/config origin remote
  | 'plugin-json' // <dir>/.claude-plugin/plugin.json repository
  | 'registry-name' // registry name match (review-only)
  | 'registry-embedding' // embedding tiebreak over name candidates (opt-in)
  | 'author-hint' // frontmatter author hint (opt-in)
  | 'catalog-db' // local catalog skills.db repo_url (opt-in)
  | 'user-specified' // resolved via an explicit --set override

/**
 * Confidence in a recovered source. Only `exact`, `high`, and `user-specified`
 * auto-backfill; `medium`/`low` are review-only.
 */
export type RecoveryConfidence = 'exact' | 'high' | 'medium' | 'low' | 'user-specified' | 'unknown'

/** A recovered canonical GitHub source. `url` is always `https://github.com/<owner>/<repo>`. */
export interface RecoveredSource {
  owner: string
  repo: string
  url: string
}

/** A candidate registry match for an ambiguous (multi-result) name lookup. */
export interface RecoveryCandidate {
  /** Registry UUID (skills.id). */
  id: string
  name: string
  owner: string
  repo: string
  /** `https://github.com/<owner>/<repo>` (buildRawUrl-compatible). */
  url: string
  qualityScore: number
}

/** Outcome status for a single skill. */
export type SkillRecoveryStatus = 'recovered' | 'already_tracked' | 'unknown' | 'skipped_backup'

/** Result of attempting to recover one skill's source. */
export interface SkillRecoveryResult {
  /** Skill directory basename. */
  skillName: string
  /** Absolute install path (the skill directory). */
  installPath: string
  /** Recovered source, or null when unresolved / ambiguous. */
  recoveredSource: RecoveredSource | null
  /** Registry UUID when a registry tier resolved a single match, else null. */
  registryId: string | null
  /** Method that produced the result, or null when unknown / skipped. */
  method: RecoveryMethod | null
  confidence: RecoveryConfidence
  /** Populated only for ambiguous registry matches (> 1 candidate). */
  candidates: RecoveryCandidate[]
  status: SkillRecoveryStatus
}

/** Aggregate counts over a recovery run. */
export interface RecoverySummary {
  total: number
  recovered: number
  already_tracked: number
  unknown: number
  skipped_backup: number
}

/** Full recovery report. */
export interface RecoveryReport {
  skills: SkillRecoveryResult[]
  summary: RecoverySummary
}

/**
 * Injected dependencies for the recovery service. Keeping these injected lets
 * unit tests run fully offline with mocks and keeps SearchService / the API
 * client out of the core module (CLI / MCP layers wire the real impls).
 */
export interface RecoveryDeps {
  /** SHA-256 of SKILL.md content (reuse `hashContent`). */
  hashContent: (content: string) => string
  /** Registry name lookup. Returns 0+ candidates for an exact/prefix name. */
  findCandidatesByName: (name: string) => Promise<RecoveryCandidate[]>
  /** Opt-in embedding tiebreak; returns candidates reranked best-first. */
  rankByEmbedding?: (
    skillName: string,
    skillMd: string,
    candidates: RecoveryCandidate[]
  ) => Promise<RecoveryCandidate[]>
  /** Opt-in local catalog hint; returns a GitHub repo_url or null. */
  lookupCatalogRepoUrl?: (name: string) => Promise<string | null>
}

/** Human-readable label per recovery method (CLI rendering). */
export const METHOD_LABELS: Record<RecoveryMethod, string> = {
  'git-remote': 'git remote',
  'plugin-json': 'plugin manifest',
  'registry-name': 'registry name match',
  'registry-embedding': 'registry embedding match',
  'author-hint': 'frontmatter author hint',
  'catalog-db': 'catalog repo_url',
  'user-specified': 'user specified',
}
