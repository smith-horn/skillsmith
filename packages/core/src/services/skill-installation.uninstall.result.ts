/**
 * @fileoverview `performUninstall`'s two results after the manifest drop: the
 *   drop failed after the folder moved, or the uninstall is done. Moved out of
 *   `skill-installation.uninstall.ts` (SMI-6531 A1 step 8-i-a-1) to keep that
 *   file under the 500-line standard; the done result also gained
 *   `claimedByAnotherInstall` (gate Major 2).
 * @module @skillsmith/core/services/skill-installation.uninstall.result
 */
import type { UninstallResult } from './skill-installation.types.js'
import { parkedWarnings } from './skill-installation.uninstall.helpers.js'
import type { ManifestDrop } from './skill-installation.uninstall.park.js'

/** What both results read. */
interface AfterDrop {
  skillName: string
  installPath: string
  /** Where the folder was set aside; undefined when nothing was on disk. */
  parkedPath: string | undefined
  /** The space warning and the hints from the park-result path. */
  extras: { usageWarning?: string; hints?: string[] }
  listenerProblems: string[]
}

/** Round 16: a manifest write that fails after the folder moved is reported as such. */
export async function failedDropResult(
  a: AfterDrop & { manifestPath: string; error: string }
): Promise<UninstallResult> {
  const { skillName, installPath, parkedPath } = a
  const parked = [...(await parkedWarnings(installPath)), ...a.listenerProblems]
  const gone =
    parkedPath === undefined ? `was removed from ${installPath}` : `was set aside at ${parkedPath}`
  return {
    success: false,
    skillName,
    removedPath: installPath,
    ...(parkedPath === undefined ? {} : { parkedPath }),
    message:
      `Skill "${skillName}" ${gone}, but its record in ${a.manifestPath} could not be updated ` +
      `(${a.error}). Its folder is no longer at ${installPath}; run the same remove again ` +
      'once that file is writable, which acts on whatever that record names at the time.',
    ...a.extras,
    ...(parked.length > 0 && { warning: parked.join(' ') }),
  }
}

/** The done result: the parked line (or the plain one), and every warning. */
export async function doneResult(
  a: AfterDrop & {
    drop: Exclude<ManifestDrop, { kind: 'failed' }>
    doneLine: string | null
    adopted: boolean
  }
): Promise<UninstallResult> {
  const { skillName, installPath, parkedPath, drop } = a
  // Round 16 (both reviewers): away from a fan-out destination nothing swept
  // what a failed removal parked, so it was named once and never again.
  const warnings = [
    ...(a.adopted
      ? [
          'This skill had no manifest entry (untracked) — it was adopted from disk state before removal.',
        ]
      : []),
    ...(drop.kind === 'claimed'
      ? [
          'Another install claimed this name while this one was being removed, so that record was left alone.',
        ]
      : []),
    ...(await parkedWarnings(installPath)),
    ...a.listenerProblems,
  ]
  return {
    success: true,
    skillName,
    message: a.doneLine ?? 'Skill "' + skillName + '" has been uninstalled successfully.',
    removedPath: installPath,
    ...(parkedPath === undefined ? {} : { parkedPath }),
    ...(drop.kind === 'claimed' ? { claimedByAnotherInstall: true as const } : {}),
    ...a.extras,
    ...(warnings.length > 0 && { warning: warnings.join(' ') }),
  }
}
