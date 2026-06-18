/**
 * Per-skill GitHub tree-URL builder (Node port)
 * @module scripts/indexer/skill-url
 *
 * SMI-5286 Wave 1a (C-1): the load-bearing dedup fix. `skills.repo_url` is the
 * ONLY unique constraint (migration 001:26) and the upsert `onConflict` target
 * (`indexer-runners.batch.ts:153`). The community discovery emitters historically
 * persisted the BARE repo-root `html_url` for every skill, so N SKILL.md files in
 * one repo collided on `repo_url` → last-writer-wins → a single row.
 *
 * This helper constructs a DISTINCT per-skill URL of the shape
 *   `${repoHtmlUrl}/tree/${defaultBranch}/${skillPath}`
 * mirroring the high-trust path that already produces naturally-distinct rows at
 * `high-trust-indexer.ts:261`. Each enumerated SKILL.md therefore yields a
 * distinct `repo_url` and never collides.
 *
 * Kept tiny and dependency-free so every emitter (subdirectory-search,
 * code-search, topic-search) can import it without a cycle.
 */

/**
 * Build the per-skill tree URL for a SKILL.md discovered in a repository.
 *
 * `skillPath` is the SKILL.md's parent directory (the convention used everywhere
 * in the indexer — `extractSkillPath`/`fetchSkillPathsFromTree` both strip the
 * trailing `/SKILL.md`). It mirrors `high-trust-indexer.ts:261`'s `resolvedPath`.
 *
 * Normalization:
 *   - strips a trailing slash from `repoHtmlUrl`
 *   - drops a single leading slash from `skillPath`
 *   - for a root-level skill (`skillPath === ''`) returns the bare
 *     `${repoHtmlUrl}/tree/${defaultBranch}` (a root SKILL.md has no parent dir,
 *     matching high-trust semantics where `resolvedPath` is the skill dir)
 *
 * @param repoHtmlUrl - The repository root HTML URL (e.g. `https://github.com/o/r`)
 * @param defaultBranch - The repository default branch (e.g. `main`)
 * @param skillPath - The SKILL.md parent directory (e.g. `.agents/skills/foo`), or `''` for root
 * @returns A distinct per-skill tree URL
 */
export function buildSkillTreeUrl(
  repoHtmlUrl: string,
  defaultBranch: string,
  skillPath: string
): string {
  const root = repoHtmlUrl.replace(/\/+$/, '')
  const path = skillPath.replace(/^\/+/, '')
  if (path === '') {
    return `${root}/tree/${defaultBranch}`
  }
  return `${root}/tree/${defaultBranch}/${path}`
}
