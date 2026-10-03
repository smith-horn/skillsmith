/**
 * SMI-5895 (Wave 2 Step 1): confidence-gated `SourceRecoveryService` fallback
 * + claimed-author reads for `manage.update.helpers.ts`'s `getSkillDiff`.
 *
 * Split out of manage.update.helpers.ts (SMI-6529 Wave A0, file-length gate —
 * this file was pushed to exactly 500 lines by the local/untracked-skip
 * fix) — pure move, no behavior change.
 */

import { readFile } from 'fs/promises'
import { join } from 'path'
import {
  SkillParser,
  SourceRecoveryService,
  hashContent,
  type DatabaseType,
  type RecoveryConfidence,
  type SkillRecoveryResult,
} from '@skillsmith/core'
import type { InstalledSkill } from '../utils/skills-directory.js'
import {
  buildFindCandidatesByName,
  buildFindRegistryIdByRepoUrl,
} from '../utils/source-recovery-deps.js'

/**
 * SMI-5895 (Wave 2 Step 1): confidence tiers that {@link recoverConfidentSourceId}
 * auto-applies without asking the user to confirm — matches the same
 * "exact/high/user-specified auto-backfill, medium/low review-only" floor
 * `backfillManifest`'s own default `minConfidence: 'high'` already encodes
 * (`provenance/backfill.ts`, `commands/audit-sources.ts --min-confidence`
 * default). A medium/low match is a *speculative* name lookup — silently
 * trusting it here could overwrite a local skill with the wrong upstream
 * version, so `update` fails safely instead (plan-review correction).
 */
export const AUTO_APPLY_RECOVERY_CONFIDENCES = new Set<RecoveryConfidence>([
  'exact',
  'high',
  'user-specified',
])

/**
 * SMI-5895 (Wave 2 Step 1): fall back to `SourceRecoveryService` (SMI-5407,
 * already exposed via `sklx audit sources` / `skill_recover_source`) ONLY
 * when the manifest has no entry for this skill at all. Gated on confidence
 * — see {@link AUTO_APPLY_RECOVERY_CONFIDENCES}. Returns null (never
 * throws) when recovery is unavailable, unresolved/ambiguous, or below the
 * auto-apply confidence floor; the caller directs the user to
 * `sklx audit sources` for manual review in that case.
 *
 * SMI-6529 Wave A0: `getSkillDiff` no longer calls this for a
 * `source: 'unknown'`/`provenance: 'local'` manifest entry — those rows now
 * short-circuit to `'skipped-local'` before any resolution runs. This
 * function stays reachable only when a manifest entry has a non-'unknown'
 * source but no usable id.
 */
export async function recoverConfidentSourceId(
  skillName: string,
  installed: InstalledSkill,
  db: DatabaseType
): Promise<string | null> {
  let skillMd: string | null
  try {
    skillMd = await readFile(join(installed.path, 'SKILL.md'), 'utf-8')
  } catch {
    skillMd = null
  }
  const service = new SourceRecoveryService({
    hashContent,
    findCandidatesByName: buildFindCandidatesByName(db),
    findRegistryIdByRepoUrl: buildFindRegistryIdByRepoUrl(db),
  })
  let result: SkillRecoveryResult
  try {
    result = await service.recoverOne(installed.path, skillName, skillMd)
  } catch {
    // The injected deps hit the local `skills` cache directly, so a missing/
    // corrupt table throws rather than returning zero candidates. Recovery is
    // a best-effort fallback — degrade to "unresolvable" (whose message points
    // at `sklx audit sources`) instead of failing the whole update command.
    return null
  }
  if (result.status !== 'recovered' || !AUTO_APPLY_RECOVERY_CONFIDENCES.has(result.confidence)) {
    return null
  }
  // SMI-5895 review (D-1): prefer the skill-specific recoveredSource.url over
  // registryId. registryId comes from findRegistryIdByRepoUrl's `repo_url`-only
  // lookup (source-recovery-deps.ts), which has no per-skill disambiguation --
  // a multi-skill plugin/monorepo shares one repo_url across every skill in it,
  // so it can resolve to a DIFFERENT skill's registry row than the one being
  // recovered. recoveredSource is always populated alongside registryId for
  // both auto-apply-eligible tiers (SourceRecoveryService.recoverOne's
  // git-remote/plugin-json branches), so this never loses real recovery
  // coverage -- registryId only remains as a defensive fallback for a future
  // confidence tier that might populate one without the other.
  return result.recoveredSource?.url ?? result.registryId ?? null
}

/**
 * SMI-6103: the installed skill's own claimed author, read directly from its
 * SKILL.md front-matter (never null-defaulted to a directory/display name —
 * an unclaimed "Local" skill, the website's own term, genuinely has none).
 * Returns null on any read/parse failure or an absent `author` field.
 */
export async function readClaimedAuthor(installedPath: string): Promise<string | null> {
  try {
    const skillMd = await readFile(join(installedPath, 'SKILL.md'), 'utf-8')
    const parsed = new SkillParser().parse(skillMd)
    const author = (parsed as unknown as Record<string, unknown> | undefined)?.['author']
    return typeof author === 'string' && author.trim().length > 0 ? author.trim() : null
  } catch {
    return null
  }
}
