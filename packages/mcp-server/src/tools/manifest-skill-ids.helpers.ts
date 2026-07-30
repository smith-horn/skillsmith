/**
 * @fileoverview Shared manifest-scoped installed-skill-id resolution.
 * @module @skillsmith/mcp-server/tools/manifest-skill-ids.helpers
 * @see SMI-5895 Wave 2 Step 2
 *
 * Both `skill_outdated` (outdated.ts) and `skill_updates` (skill-updates.ts)
 * need to bound their per-skill comparison loop to only the skills the user
 * actually has installed, per the local manifest
 * (`~/.skillsmith/manifest.json`) — `skill_updates` previously reinvented
 * this independently via an unfiltered `SELECT DISTINCT skill_id FROM
 * skill_versions` (every skill ever indexed by the registry, not just
 * installed ones — the reported `updatesAvailable: 2833` bug), instead of
 * reusing `outdated.ts`'s already-correct manifest-scoped pattern
 * (`loadManifest()` -> `Object.values(manifest.installedSkills)`, inherently
 * bounded by install count). Extracted here so the two tools can't drift
 * apart again on how "which skills are installed" is determined.
 */

import type { SkillManifest } from './install.types.js'

/**
 * Return the de-duplicated set of registry skill IDs recorded in the
 * manifest's `installedSkills` entries.
 *
 * The manifest is single/global, not per-client (SMI-5894 Wave 1 Step 3's
 * `name`/`name::client` composite keys still all land in one file) — a
 * skill installed under two clients produces two entries sharing the same
 * `id`, so the result is de-duplicated to avoid double-counting the same
 * registry skill twice in a per-id comparison loop. Filters out entries
 * with an empty/missing `id` (corrupt or manually-edited manifest rows,
 * same guard `outdated.ts` already applies per SMI-3177).
 *
 * `loadManifest()` performs no schema validation — it returns whatever
 * `JSON.parse` produced for `~/.skillsmith/manifest.json` — so a truncated or
 * hand-edited file missing the `installedSkills` key entirely arrives here as
 * `undefined`. Treat that as "nothing installed" rather than letting
 * `Object.values(undefined)` throw out of the tool call.
 */
export function getManifestInstalledSkillIds(manifest: SkillManifest): string[] {
  const ids = new Set<string>()
  if (!manifest.installedSkills || typeof manifest.installedSkills !== 'object') {
    return []
  }
  for (const entry of Object.values(manifest.installedSkills)) {
    if (typeof entry.id === 'string' && entry.id.trim().length > 0) {
      ids.add(entry.id)
    }
  }
  return [...ids]
}
