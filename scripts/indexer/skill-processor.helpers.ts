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
} {
  return {
    repo_url: repo.url,
    last_seen_at: new Date().toISOString(),
    repo_updated_at: repo.updatedAt ?? null,
  }
}
