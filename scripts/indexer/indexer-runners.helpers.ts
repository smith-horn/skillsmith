/**
 * Pure helper functions extracted from indexer-runners.ts (SMI-4736; Node port SMI-4852).
 * @module scripts/indexer/indexer-runners.helpers
 *
 * Node-flavored sibling of `supabase/functions/indexer/indexer-runners.helpers.ts`.
 * Bodies are byte-identical to the Deno parent — pure helpers with no Deno-only
 * APIs. Parity drift is guarded by `scripts/indexer/tests/parity.test.ts`.
 *
 * Contains `bumpDiscoveryPath` and `resolveHighTrustAuthor` — both pure
 * (no Supabase/Node-specific deps) and exported for direct unit testing.
 */

import { sanitizeForLog } from './_shared/validation.ts'
import type { GitHubRepository } from './topic-search.ts'
import { getHighTrustAuthor, type HighTrustAuthor } from './high-trust-authors.ts'

/**
 * SMI-4387: Increment the discovery-path yield counter for a repo that just
 * landed indexed-or-updated. Loud-fails (console.error + `_error:` bucket) if
 * the discovery site forgot to stamp `discoveryPath` — surfaces gaps in
 * dashboards instead of hiding them under an `'unknown'` catch-all.
 *
 * Pure, exported for direct unit testing.
 */
export function bumpDiscoveryPath(counts: Record<string, number>, repo: GitHubRepository): void {
  let key = repo.discoveryPath
  if (!key) {
    // sanitizeForLog: strip control chars + truncate — matches module log-safety pattern.
    console.error(`[SMI-4387] Missing discoveryPath for ${sanitizeForLog(repo.url)}`)
    key = '_error:missing_discovery_path'
  }
  counts[key] = (counts[key] ?? 0) + 1
}

/**
 * SMI-4386: Resolve the high-trust author for a repo, with registry fallback.
 *
 * `highTrustSkillMap` is populated only in Phase 1 (high-trust indexing) with
 * path-qualified URLs. Phase 2 (topic search) and Phase 3 (code/subdirectory
 * search) emit raw repo URLs Phase 1 never touched — those miss the map.
 * When they do, fall back to the `HIGH_TRUST_AUTHORS` registry via exact
 * owner+repoName match. If the repo is registered it graduates to verified;
 * otherwise undefined flows through and community-tier logic runs normally.
 *
 * Returned tuple: `[author, fallbackFired]`. Caller increments a counter on
 * `fallbackFired === true` so dashboards can detect Phase-1-URL-scheme drift.
 *
 * Pure, exported for direct unit testing.
 */
export function resolveHighTrustAuthor(
  highTrustSkillMap: Map<string, HighTrustAuthor>,
  repo: GitHubRepository
): [HighTrustAuthor | undefined, boolean] {
  const fromMap = highTrustSkillMap.get(repo.url)
  if (fromMap) return [fromMap, false]
  const fromRegistry = getHighTrustAuthor(repo.owner, repo.repoName)
  return [fromRegistry, fromRegistry !== undefined]
}
