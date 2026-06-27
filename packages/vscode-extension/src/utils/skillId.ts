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

/** Canonical UUID v4-shaped id (the server's registry accepts these). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * True when a skill id is a bare on-disk install slug (a locally-installed
 * skill) rather than a registry id the MCP `get_skill` tool can resolve.
 *
 * This is the exact complement of the server's `parseSkillIdInternal`
 * (`@skillsmith/core/services/skill-installation.validate`): that function
 * accepts a GitHub URL, an `owner/repo` (or longer slash path), and a UUID —
 * and throws on anything else. So a bare, non-UUID, no-slash id is precisely
 * what the registry rejects and what the detail panel must instead read from
 * `<skills-root>/<id>/SKILL.md` (SMI-5401).
 *
 * Note (mirrors the server): a UUID-named on-disk directory routes to
 * `get_skill`, not disk — surprising but correct, since the server accepts UUID
 * ids and a UUID directory slug is not a real-world installed-skill name.
 *
 * @param id - A skill id from the tree (bare slug) or search view (`owner/repo`)
 * @returns `true` iff the id is a local install slug
 */
export function isLocalSkillId(id: string): boolean {
  if (id.startsWith('https://github.com/')) return false // URL -> registry
  if (id.includes('/')) return false // owner/repo or path -> registry
  if (UUID_RE.test(id)) return false // UUID -> registry
  return true // bare slug -> local
}
