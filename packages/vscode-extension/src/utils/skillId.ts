/**
 * Skill-ID normalization helpers shared by the sidebar (#1436) and the detail
 * panel (#1437).
 *
 * Installed skills are keyed by their on-disk directory slug (e.g. `my-skill`),
 * while registry/search results carry a fully-qualified `author/name` id
 * (e.g. `smith-horn/my-skill`). To cross-reference "is this registry hit also
 * installed?" both forms must be reduced to a common comparison key.
 *
 * @module utils/skillId
 */

/**
 * Reduce any skill id to a case-insensitive comparison key by stripping an
 * optional `author/` prefix and lowercasing.
 *
 * - `smith-horn/My-Skill` → `my-skill`
 * - `my-skill`           → `my-skill`
 *
 * Note: slugs can collide across different authors, so a match is a best-effort
 * "also installed" hint, not an identity proof. Callers using this for a UI
 * marker accept the residual false-positive risk.
 *
 * @param id - A skill id in either `author/name` or bare-slug form
 * @returns The lowercased trailing slug segment
 */
export function skillComparisonKey(id: string): string {
  return (id.split('/').pop() ?? id).toLowerCase()
}

/**
 * Build a Set of comparison keys from a list of installed-skill ids, for O(1)
 * "also installed" lookups against registry results.
 *
 * @param installedIds - Installed skill ids (typically on-disk dir slugs)
 * @returns A Set of normalized comparison keys
 */
export function buildInstalledKeySet(installedIds: readonly string[]): Set<string> {
  return new Set(installedIds.map(skillComparisonKey))
}
