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
