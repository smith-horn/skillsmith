/**
 * Per-skill GitHub tree-URL builder (Node port)
 * @module scripts/indexer/skill-url
 *
 * SMI-5286 Wave 1a (C-1): the load-bearing dedup fix. `skills.repo_url` was
 * the unique constraint and upsert `onConflict` target at the time this was
 * written; SMI-5898 Wave 2 added `repo_url_canonical` (a case-insensitive,
 * trigger-maintained derivative — `20260819000000_smi5898_repo_url_canonical.sql`)
 * as a second, now-primary unique constraint, and both `indexer-runners.batch.ts`
 * files (Node + Deno) upsert against it instead. `repo_url` itself is still
 * the source column this helper builds and is still unique (case-sensitive),
 * so the distinct-per-skill-URL reasoning below is unaffected — only the
 * upsert's conflict-inference target changed.
 *
 * The community discovery emitters historically persisted the BARE
 * repo-root `html_url` for every skill, so N SKILL.md files in one repo
 * collided on `repo_url` → last-writer-wins → a single row.
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
