/**
 * High-Trust Authors Configuration (Node port)
 * @module scripts/indexer/high-trust-authors
 *
 * SMI-4852: Node-flavored sibling of
 * `supabase/functions/indexer/high-trust-authors.ts`. Parity guarded by the
 * SMI-4852 cluster-A port; drift would surface in CI typecheck/grep.
 *
 * SMI-4843 Phase 5b (2026-05-18): the entry list outgrew the 500-line file
 * limit and was split — the `HighTrustAuthor` type lives in
 * `./high-trust-authors.types.ts`, the founding verified-org + curated set in
 * `./high-trust-authors.core.ts`, and the skills.sh top-275 leaderboard
 * expansion in `./high-trust-authors.leaderboard.ts`. This module re-assembles
 * them into `HIGH_TRUST_AUTHORS` and keeps the lookup helpers.
 */

import type { HighTrustAuthor } from './high-trust-authors.types.ts'
import { CORE_HIGH_TRUST_AUTHORS } from './high-trust-authors.core.ts'
import { LEADERBOARD_HIGH_TRUST_AUTHORS } from './high-trust-authors.leaderboard.ts'

export type { HighTrustAuthor }

/**
 * High-trust authors configuration.
 *
 * Founding verified company repositories + curated individual publishers
 * (`CORE_HIGH_TRUST_AUTHORS`) followed by the skills.sh top-275 leaderboard
 * expansion (`LEADERBOARD_HIGH_TRUST_AUTHORS`). All skills from verified-tier
 * authors are marked "verified" trust tier; curated tier per SMI-2381.
 */
export const HIGH_TRUST_AUTHORS: HighTrustAuthor[] = [
  ...CORE_HIGH_TRUST_AUTHORS,
  ...LEADERBOARD_HIGH_TRUST_AUTHORS,
]

/**
 * Check if a skill should be excluded from indexing
 * SMI-2413: Case-insensitive comparison for excludeSkills and includeSkills
 */
export function shouldExcludeSkill(author: HighTrustAuthor, skillName: string): boolean {
  const normalizedName = skillName.toLowerCase()

  // Check explicit exclusions (case-insensitive)
  if (author.excludeSkills?.some((e) => e.toLowerCase() === normalizedName)) {
    return true
  }

  // If includeSkills is set, exclude anything not in the list (case-insensitive)
  if (
    author.includeSkills &&
    !author.includeSkills.some((i) => i.toLowerCase() === normalizedName)
  ) {
    return true
  }

  return false
}

/**
 * Get the high-trust author config for a repository
 */
export function getHighTrustAuthor(owner: string, repo: string): HighTrustAuthor | undefined {
  return HIGH_TRUST_AUTHORS.find(
    (a) =>
      a.owner.toLowerCase() === owner.toLowerCase() && a.repo.toLowerCase() === repo.toLowerCase()
  )
}

/**
 * Check if a repository is from a high-trust author
 */
export function isHighTrustRepository(owner: string, repo: string): boolean {
  return getHighTrustAuthor(owner, repo) !== undefined
}
