/**
 * Skill processor helpers (Node port)
 * @module scripts/indexer/skill-processor.helpers
 *
 * SMI-4852: Node-flavored sibling of
 * `supabase/functions/indexer/skill-processor.helpers.ts`. Byte-identical body
 * for `repoUpdatedAtKey` and `minimalSkillPayload` — guarded by
 * `scripts/indexer/tests/parity.test.ts`.
 */

import type { GitHubRepository } from './topic-search.ts'
import type { HighTrustAuthor } from './high-trust-authors.ts'

export function repoUpdatedAtKey(repo: GitHubRepository): string {
  return repo.updatedAt ?? repo.url
}

export function minimalSkillPayload(repo: GitHubRepository): {
  repo_url: string
  last_seen_at: string
  repo_updated_at: string | null
  tree_hash?: string
  last_tree_hash_check?: string
} {
  const base = {
    repo_url: repo.url,
    last_seen_at: new Date().toISOString(),
    repo_updated_at: repo.updatedAt ?? null,
  }
  // SMI-4861 Wave 1 fix (SMI-4887): backfill tree_hash on the skip-gate path.
  // repo.treeHash, when set, came from the wildcard Trees fetch this run — fresh,
  // not the stale metadata the docstring above warns about. Without this, the
  // 89% of skills hitting the SMI-4846 prehash gate never get tree_hash written,
  // and the SMI-4861 cache never warms.
  if (repo.treeHash) {
    return { ...base, tree_hash: repo.treeHash, last_tree_hash_check: new Date().toISOString() }
  }
  return base
}

/**
 * SMI-4858: Guaranteed-non-empty skill name resolver. `skills.name NOT NULL`
 * must hold across every discovery path; falls back through `repoName`, the
 * second segment of `fullName`, and finally a sentinel. `sanitize` is the
 * call-site's sanitizer (kept injection-style to avoid an import cycle
 * between this helper module and skill-processor.ts).
 */
export function resolveSkillName(
  candidate: string | undefined,
  repo: GitHubRepository,
  sanitize: (name: string) => string
): string {
  const fb = repo.repoName || repo.fullName?.split('/')[1] || 'unnamed-skill'
  return sanitize(candidate || repo.name || fb) || sanitize(fb) || 'unnamed-skill'
}

/**
 * SMI-2402: Trust tier identifiers, ordered highest-to-lowest.
 */
export type TrustTier = 'verified' | 'curated' | 'community' | 'experimental' | 'unknown'

/**
 * SMI-2402: Banded quality-score model. Each trust tier owns a fixed,
 * non-overlapping `[floor, ceil]` score band; a 0–1 intrinsic-quality score
 * spreads skills *within* their band. Cross-tier ordering is therefore
 * structurally guaranteed (a `verified` skill can never score below a
 * `curated` one), while within-tier ordering becomes meaningful.
 *
 * Exposed as a function rather than a bare `const` so the Node↔Deno
 * `parity.test.ts` (`extractBody` covers `export function`s only) can assert
 * byte-identity of the band table across both trees (Review finding #1).
 */
export function getTierBands(): Record<TrustTier, { floor: number; ceil: number }> {
  return {
    verified: { floor: 0.85, ceil: 1.0 },
    curated: { floor: 0.7, ceil: 0.85 },
    community: { floor: 0.5, ceil: 0.7 },
    experimental: { floor: 0.35, ceil: 0.5 },
    unknown: { floor: 0.2, ceil: 0.35 },
  }
}

/** SMI-2402: clamp a number into [0, 1]. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(value, 0), 1)
}

/**
 * SMI-2402: Metadata subset consumed by the intrinsic-quality formula.
 * Mirrors `SkillMdValidation['metadata']` without importing it (avoids a
 * cycle: skill-processor.ts imports this module).
 */
export interface IntrinsicQualityMetadata {
  name?: string
  description?: string
  author?: string
  triggers?: string[]
  frontmatterTags?: string[]
  frontmatterCategory?: string
}

/**
 * SMI-2402: Strip fenced code blocks (triple-backtick ... triple-backtick)
 * from markdown. `hasHeadings` counts `##`..`######` lines via a multiline
 * regex; without this strip, `###`-prefixed lines *inside* a code sample
 * would inflate the heading count (Review finding #3).
 */
function stripFencedBlocks(content: string): string {
  return content.replace(/```[\s\S]*?```/g, '')
}

/**
 * SMI-2402: structureQuality sub-signal — detects skill *structure* (not
 * length; verbosity is explicitly not rewarded — see plan §Decision 6 and
 * the thin-dispatcher methodology SMI-2458). Three boolean checks, averaged:
 *
 * - `hasHeadings`   — ≥3 section headings (`##`..`######`), fenced code stripped first.
 * - `hasExample`    — ≥1 fenced code block.
 * - `hasDispatcherRefs` — ≥1 relative `.md` link, the thin-dispatcher hallmark.
 *
 * An empty/undefined `content` yields 0 (Review finding #3). The
 * `hasDispatcherRefs` regex matches *any* in-text `.md` link (e.g.
 * `[changelog](./CHANGELOG.md)`) — accepted as benign noise: a SKILL.md
 * linking sibling docs at all is the signal we want (Review finding #3).
 */
export function computeStructureQuality(content: string | undefined): number {
  if (!content || content.trim().length === 0) return 0
  const stripped = stripFencedBlocks(content)
  const headingCount = (stripped.match(/^#{2,6}\s+.+/gm) ?? []).length
  const hasHeadings = headingCount >= 3 ? 1 : 0
  const hasExample = /```[\s\S]*?```/.test(content) ? 1 : 0
  const hasDispatcherRefs = /\[[^\]]*\]\(\.?\/?[^)]+\.md\)/.test(content) ? 1 : 0
  return (hasHeadings + hasExample + hasDispatcherRefs) / 3
}

/**
 * SMI-2402: Intrinsic-quality score ∈ [0, 1] — a weighted sum of five
 * sub-signals (weights sum to 1.0), each independently clamped to [0, 1].
 * This is the within-band spread; `computeQualityScore` maps it into the
 * tier band.
 *
 * | sub-signal              | weight | computation                                   |
 * |-------------------------|--------|------------------------------------------------|
 * | descQuality             | 0.25   | clamp(descLength / 160)                        |
 * | frontmatterCompleteness | 0.25   | fraction of 6 frontmatter fields present       |
 * | triggerPhrases          | 0.20   | clamp(triggers.length / 5)                     |
 * | structureQuality        | 0.20   | computeStructureQuality(content)               |
 * | popularity              | 0.10   | clamp(log10(stars + 1) / 3)                    |
 *
 * Edge-case clamping (Review finding #3): a missing `description` is treated
 * as `''` (descQuality → 0); `repo.stars` is run through `Math.max(x ?? 0, 0)`
 * before `log10` so a negative or undefined star count cannot produce `NaN`.
 */
export function computeIntrinsicQuality(
  content: string | undefined,
  metadata: IntrinsicQualityMetadata | undefined,
  repo: GitHubRepository
): number {
  const description = metadata?.description ?? repo.description ?? ''
  const descQuality = clamp01(description.length / 160)

  const triggers = metadata?.triggers ?? []
  const fields = [
    typeof metadata?.name === 'string' && metadata.name.trim().length > 0,
    typeof description === 'string' && description.trim().length >= 20,
    typeof metadata?.author === 'string' && metadata.author.trim().length > 0,
    triggers.length >= 1,
    (metadata?.frontmatterTags?.length ?? 0) >= 1,
    typeof metadata?.frontmatterCategory === 'string' &&
      metadata.frontmatterCategory.trim().length > 0,
  ]
  const frontmatterCompleteness = fields.filter(Boolean).length / 6

  const triggerPhrases = clamp01(triggers.length / 5)
  const structureQuality = computeStructureQuality(content)

  const stars = Math.max(repo.stars ?? 0, 0)
  const popularity = clamp01(Math.log10(stars + 1) / 3)

  return clamp01(
    descQuality * 0.25 +
      frontmatterCompleteness * 0.25 +
      triggerPhrases * 0.2 +
      structureQuality * 0.2 +
      popularity * 0.1
  )
}

/**
 * SMI-2402: Map a `(trustTier, intrinsic)` pair to the final 0–1
 * `quality_score`: `floor + (ceil − floor) × intrinsic`. `intrinsic` is
 * clamped to [0, 1] defensively; an unrecognized tier falls back to the
 * `unknown` band.
 */
export function computeQualityScore(trustTier: TrustTier, intrinsic: number): number {
  const bands = getTierBands()
  const band = bands[trustTier] ?? bands.unknown
  return band.floor + (band.ceil - band.floor) * clamp01(intrinsic)
}

/**
 * SMI-2402: Trust-tier selection — the decision tree is unchanged from the
 * pre-banding model (SMI-4651). Extracted from `repositoryToSkill` so the
 * scoring block stays out of the already-long `skill-processor.ts`.
 *
 * Precedence:
 *   1. `highTrustAuthor` present → its `trustTier` (default `verified`).
 *   2. `claude-code-official` repo topic → `verified`.
 *   3. `orgIsVerified === true` → `curated` (GitHub-verified vendor org
 *      without an explicit HIGH_TRUST_AUTHORS entry).
 *   4. stars ≥ 50 → `community`; stars ≥ 5 → `experimental`; else `unknown`.
 *
 * The selected tier now solely picks the score band — `computeQualityScore`
 * spreads within it. `baseQualityScore` is no longer consulted for the score.
 */
export function selectTrustTier(
  repo: GitHubRepository,
  highTrustAuthor?: HighTrustAuthor,
  orgIsVerified?: boolean
): TrustTier {
  if (highTrustAuthor) {
    return highTrustAuthor.trustTier || 'verified'
  }
  if (repo.topics.includes('claude-code-official')) {
    return 'verified'
  }
  if (orgIsVerified === true) {
    return 'curated'
  }
  const stars = Math.max(repo.stars ?? 0, 0)
  if (stars >= 50) return 'community'
  if (stars >= 5) return 'experimental'
  return 'unknown'
}
