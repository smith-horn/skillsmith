/**
 * @fileoverview Helpers for `performUninstall`: what it found before removing,
 *   progress reporting that cannot change the outcome, record comparison, and
 *   the parked-leftover warnings.
 * @module @skillsmith/core/services/skill-installation.uninstall.helpers
 *
 * Split out of `skill-installation.uninstall.ts` in SMI-6529 round 25, when
 * that file reached 504 lines against the 500-line standard — the same
 * sibling-split convention as `skill-installation.io.ts`. These are the pieces
 * `performUninstall` calls but does not itself define; nothing here is part of
 * `@skillsmith/core`'s public export surface.
 */

import type { Stats } from 'fs'
import * as fs from 'fs/promises'

import { checkGitAtRoot } from '../install/fan-out.overwrite.js'
import { listParkedLeftovers, parkedLeftoverWarning } from '../install/remove-if-same.js'
import type { ProgressCallback, SkillManifestEntry } from './skill-installation.types.js'

/**
 * SMI-6529 round 15 (cross-model review, Critical): what uninstall found at
 * `installPath` before removing it. A folder with `.git` at its root is a git
 * working tree, which git owns (ADR-155), so it is refused with or without
 * `force`: deleting it would take unpushed commits and uncommitted edits with
 * it. A symlink or a file needs no such check, since removing it leaves what
 * it points at alone. Returns the entry's identity (null when nothing is
 * there), so the delete can confirm it is still the same entry.
 */
export async function inspectForRemoval(
  installPath: string
): Promise<{ stat: Stats | null } | { refusal: string }> {
  let stat: Stats
  try {
    stat = await fs.lstat(installPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { stat: null }
    return {
      refusal:
        'Could not check ' +
        installPath +
        ' (' +
        (code ?? String(error)) +
        '); nothing was removed.',
    }
  }
  if (!stat.isSymbolicLink() && !stat.isFile()) {
    const git = await checkGitAtRoot(installPath)
    if (git.kind === 'present') {
      return {
        refusal:
          installPath +
          ' is a git working tree (it has .git at its root), so Skillsmith will not delete it, ' +
          'even with force. Check `git -C ' +
          installPath +
          ' status`, then remove the folder yourself.',
      }
    }
    if (git.kind === 'unknown') {
      return {
        refusal:
          'Could not check ' +
          installPath +
          ' for a .git directory (' +
          git.reason +
          '); nothing was removed.',
      }
    }
  }
  return { stat }
}

/**
 * Report progress without letting a caller's listener change the outcome.
 * Round 18 (cross-model review): a listener that threw after the folder was
 * already removed reached the generic catch, which reported neither what had
 * been removed nor what was left parked.
 *
 * Round 28 (pre-merge gate, PR-07): the failure is still swallowed as far as
 * the uninstall's outcome goes — that part was deliberate and stays — but it
 * is no longer swallowed as far as the USER goes. It is pushed onto
 * `problems`, which the caller surfaces alongside its other warnings. An empty
 * catch here was the same "could not tell" silence this wave removed
 * everywhere else, in the one place that reports to the user for a living.
 */
export function notify(
  onProgress: ProgressCallback,
  problems: string[],
  ...args: Parameters<ProgressCallback>
): void {
  try {
    onProgress(...args)
  } catch (err) {
    const stage = String(args[0] ?? 'unknown')
    problems.push(
      `the progress listener threw while reporting the "${stage}" step ` +
        `(${err instanceof Error ? err.message : String(err)}); the uninstall itself was not ` +
        `affected.`
    )
  }
}

/**
 * Whether `entry` is still, field for field, the record this uninstall
 * loaded. Round 18 (cross-model review): timestamps alone are not a unique
 * generation token — two installs can share a millisecond, an older writer
 * can omit them, and a copied record keeps them — so every field has to
 * match. An install that claims the same name writes its own values, so any
 * difference means a different generation. A durable generation id belongs
 * with A1's manifest work (SMI-6531).
 */
export function sameRecord(entry: SkillManifestEntry, loaded: SkillManifestEntry): boolean {
  return stableJson(entry) === stableJson(loaded)
}

/**
 * JSON with every object's keys in a fixed order, so two records compare by
 * value. Round 19 (Opus): comparing field by field with `!==` was correct only
 * while every field is a string — one array or object field, written by a
 * newer version or another tool, would never compare equal, and the record
 * would be kept forever with a warning that says an install claimed the name.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) =>
    nested !== null && typeof nested === 'object' && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0
          )
        )
      : nested
  )
}

/**
 * Warnings naming anything an earlier removal left parked next to
 * `installPath`. Round 17 (cross-model review): every exit after the removal
 * reports these, not only the successful one.
 */
export async function parkedWarnings(installPath: string): Promise<string[]> {
  const scan = await listParkedLeftovers(installPath)
  const warnings = scan.parked.map(parkedLeftoverWarning)
  // Round 25 (cross-model review): say when the scan could not look at all.
  return scan.unreadable ? [...warnings, scan.unreadable] : warnings
}
