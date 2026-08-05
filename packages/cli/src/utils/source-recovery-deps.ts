/**
 * @fileoverview Shared SourceRecoveryService dependency wiring for the CLI.
 * @module @skillsmith/cli/utils/source-recovery-deps
 * @see SMI-5407, SMI-5895 (Wave 2 Step 1)
 *
 * Both `sklx audit sources` (audit-sources.action.ts) and `skillsmith
 * update`'s "no recorded registry source" fallback (manage.update.ts) need
 * to hand `SourceRecoveryService` a `findCandidatesByName` (local-DB
 * registry name lookup) and `findRegistryIdByRepoUrl` (offline UUID
 * enrichment) dependency. This wiring was previously hand-rolled once,
 * inline, inside `audit-sources.action.ts` — extracted here so the two CLI
 * callers can't independently drift on how a registry-name candidate or a
 * repo_url -> registryId match is resolved (the same "two implementations,
 * one correct, one drifted" pattern this plan is elsewhere eliminating).
 */
import type { DatabaseType, RecoveryCandidate } from '@skillsmith/core'
import { parseRepoUrl, skillNameVariants } from '@skillsmith/core'

interface SkillRow {
  id: string
  name: string
  repo_url: string | null
  quality_score: number | null
}

/**
 * Build a `findCandidatesByName` {@link RecoveryDeps} dependency backed by
 * the CLI's local `skills.db` cache.
 *
 * Prefers an exact-name match so an affix-broadened query never downgrades
 * a clean exact hit to ambiguous; falls back to affix variants (SMI-5413).
 */
export function buildFindCandidatesByName(
  db: DatabaseType
): (name: string) => Promise<RecoveryCandidate[]> {
  return async (name: string): Promise<RecoveryCandidate[]> => {
    const variants = skillNameVariants(name)
    const placeholders = variants.map(() => '?').join(', ')
    const rows = db
      .prepare<SkillRow>(
        `SELECT id, name, repo_url, quality_score FROM skills WHERE name IN (${placeholders})`
      )
      .all(...variants)

    const candidates: RecoveryCandidate[] = []
    for (const row of rows) {
      if (!row.repo_url) continue
      try {
        const parsed = parseRepoUrl(row.repo_url)
        candidates.push({
          id: row.id,
          name: row.name,
          owner: parsed.owner,
          repo: parsed.repo,
          url: `https://github.com/${parsed.owner}/${parsed.repo}`,
          qualityScore: row.quality_score ?? 0,
        })
      } catch {
        // Non-GitHub repo_url — skip candidate.
      }
    }
    const exact = candidates.filter((c) => c.name.toLowerCase() === name.toLowerCase())
    return exact.length > 0 ? exact : candidates
  }
}

/**
 * Build a `findRegistryIdByRepoUrl` {@link RecoveryDeps} dependency backed
 * by the CLI's local `skills.db` cache (SMI-5411 offline UUID enrichment).
 */
export function buildFindRegistryIdByRepoUrl(
  db: DatabaseType
): (repoUrl: string) => Promise<string | null> {
  return async (repoUrl: string): Promise<string | null> => {
    const row = db.prepare<{ id: string }>('SELECT id FROM skills WHERE repo_url = ?').get(repoUrl)
    return row?.id ?? null
  }
}
