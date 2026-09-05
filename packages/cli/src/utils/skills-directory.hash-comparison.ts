/**
 * @fileoverview `sklx list --outdated` hash-comparison + classification
 * @module @skillsmith/cli/utils/skills-directory.hash-comparison
 * @see SMI-6343 Wave 2 (C2) / Wave 3
 *
 * Split out of `skills-directory.ts` (SMI-6343 Wave 3, 500-line file gate)
 * — re-exported from there so existing call sites (`manage.action.ts`,
 * `getSkillsFromDirectory()`, tests) keep importing from that module
 * unmodified, matching this codebase's established split convention (see
 * `local-skills-dir.ts` / `skills-directory.per-harness.ts`).
 */

import { createHash } from 'crypto'
import {
  compareSkillContentHashes,
  firstNonBlankHash,
  detectOwnerMismatch,
  detectPathUnresolved,
  hasRecordedLocalEdit,
  type SkillManifestEntry,
  type SkillVersionRow,
} from '@skillsmith/core'

/**
 * SMI-6343 (C2): compute whether a newer registry version exists for an
 * installed skill, given (in order of preference) the manifest's recorded
 * install/update-time content hash, else a freshly-computed on-disk SHA-256
 * of the current SKILL.md content — compared against the most-recently
 * synced registry content hash via the shared comparator so this can't
 * silently drift from the other two SMI-6343 consumers (the mcp-server's
 * skill_outdated / skill_updates tools).
 *
 * SMI-6343 (Wave 3): a hash mismatch alone is no longer sufficient to
 * report `true` — `sklx list --outdated` must not surface a `local-drift`
 * or `identity-mismatch` row as an ordinary "update available," matching
 * `skill_outdated`'s own five-state classification. This scan is offline by
 * design (`list` has never had a network dependency), so only the two
 * DETERMINISTIC signals (owner-mismatch, path-unresolved) plus local-edit
 * detection are checked here — the network-dependent front-matter-
 * contradiction signal is deliberately NOT evaluated in this surface (H6:
 * `list --outdated` "does not share code with" `skill_outdated`, which
 * remains the full three-signal surface for a signal-2-only corruption).
 *
 * Exported for direct unit testing — this is the exact logic that fixes the
 * pre-fix defect (comparing skill_versions' metadata-proxy hash against
 * either a nonexistent `parsed.contentHash` field or a real on-disk hash,
 * which meant it always fell into the "real hash vs. proxy hash" branch and
 * could essentially never report `hasUpdates: true` correctly).
 *
 * @param expectedRootDir The directory this scan target's entries are
 *   expected to resolve inside — the caller's own `skillsDir` already IS
 *   this (global native path or workspace directory, whichever this scan
 *   target represents), so no separate resolution is needed here.
 */
export function computeHasUpdates(
  manifestEntry: SkillManifestEntry | undefined,
  content: string,
  latestVersion: SkillVersionRow | null,
  expectedRootDir: string
): boolean {
  if (!latestVersion) return false
  const freshHash = createHash('sha256').update(content, 'utf8').digest('hex')
  // SMI-6343 (adversarial-review fix): firstNonBlankHash(), not a raw `??`
  // chain — a blank-but-present contentHash/originalContentHash (`??` only
  // falls through on null/undefined) must not block falling all the way
  // through to a freshly-computed on-disk hash.
  const recordedHash = firstNonBlankHash(
    manifestEntry?.contentHash,
    manifestEntry?.originalContentHash
  )
  const installedHash = recordedHash ?? freshHash
  const outdated =
    compareSkillContentHashes(installedHash, latestVersion.content_hash).outcome === 'outdated'
  if (!outdated) return false
  if (!manifestEntry) return true // untracked skill — nothing recorded to contradict
  if (
    detectOwnerMismatch(manifestEntry) ||
    detectPathUnresolved(manifestEntry.installPath, expectedRootDir)
  ) {
    return false
  }
  // A recorded hash that disagrees with the current on-disk content is a
  // local edit (local-drift) — also excluded from "update available". Routed
  // through the SAME shared `hasRecordedLocalEdit()` the core classification
  // module uses (rather than re-deriving this boolean inline) so this file
  // cannot drift into exactly the "sibling implementation" bug class this
  // effort exists to prevent (see `skill-identity-classification.ts`).
  return !hasRecordedLocalEdit(manifestEntry, freshHash)
}
