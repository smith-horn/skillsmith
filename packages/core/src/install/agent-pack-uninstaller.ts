/**
 * `sklx agent uninstall` core orchestration (SMI-5456 Wave 1 Step 5).
 *
 * Reverses EXACTLY what `installAgentPack` wrote by replaying the manifest
 * it saved — never by re-deriving "what the generator would currently
 * produce" (which could have drifted across a version bump between install
 * and uninstall). Per manifest entry:
 *   - `backupPath !== null` (a shared config file we merged a key into):
 *     restore the file to the FULL pre-merge content captured in the
 *     backup — this removes exactly our `skillsmith` key/hook entry while
 *     leaving every other key in the file untouched, because the backup was
 *     taken of the whole file immediately before the merge.
 *   - `backupPath === null` (a file we created outright — skill pack copy,
 *     shim, hook script): delete it. There is nothing to restore to.
 *   - A path already missing on disk (user deleted it manually) is a no-op,
 *     not an error.
 *
 * SECURITY (governance follow-up, 2026-07-01): before touching the
 * filesystem, every entry's `path` is checked against
 * {@link isAllowedManifestEntryPath} (must structurally match one of the
 * installer's known per-harness target locations) and, when `backupPath` is
 * set, {@link isAllowedManifestBackupPath} (must resolve under this run's
 * manifest backups directory). The manifest is an ordinary user-writable
 * JSON file, not a signed record — a corrupted or tampered manifest must
 * never become an arbitrary-file-delete/overwrite primitive. An entry
 * failing either check is skipped entirely (added to `result.rejected`,
 * counted toward neither `removed` nor `restored`) rather than acted on.
 *
 * After removing all installer-created files, now-empty directories we
 * likely created (the parents of removed paths) are cleaned up bottom-up —
 * a non-empty directory is left alone (`rmdirSync` only removes empty ones).
 *
 * Known limitation: a hook script's original executable bit is not
 * separately tracked, so restoring a backup writes default file
 * permissions. This only matters for the vanishingly rare case of a
 * pre-existing FOREIGN executable file that happened to already occupy our
 * namespaced hook-script path — documented, not defended against.
 *
 * @module @skillsmith/core/install/agent-pack-uninstaller
 */

import { dirname } from 'node:path'
import { existsSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'

import { loadAgentManifest, saveAgentManifest } from './agent-manifest.js'
import {
  isAllowedManifestBackupPath,
  isAllowedManifestEntryPath,
} from './agent-manifest-path-guard.js'
import type { AgentUninstallOptions, AgentUninstallResult } from './agent-pack-installer.types.js'

export function uninstallAgentPack(_opts: AgentUninstallOptions = {}): AgentUninstallResult {
  const manifest = loadAgentManifest()
  const removed: string[] = []
  const restored: string[] = []
  const alreadyGone: string[] = []
  const rejected: string[] = []
  const touchedDirs = new Set<string>()

  for (const entry of manifest.entries) {
    if (!isAllowedManifestEntryPath(entry.path)) {
      rejected.push(entry.path)
      continue
    }
    if (entry.backupPath && !isAllowedManifestBackupPath(entry.backupPath)) {
      // A validated destination path but an untrusted backup SOURCE — never
      // restore from it (that would be an attacker-controlled read into a
      // safe write target) and never fall through to delete either (the
      // entry's true install-time shape can't be determined). Skip it whole.
      rejected.push(entry.path)
      continue
    }
    if (!existsSync(entry.path)) {
      alreadyGone.push(entry.path)
      continue
    }
    touchedDirs.add(dirname(entry.path))

    if (entry.backupPath && existsSync(entry.backupPath)) {
      const content = readFileSync(entry.backupPath, 'utf-8')
      writeFileSync(entry.path, content, 'utf-8')
      restored.push(entry.path)
    } else {
      unlinkSync(entry.path)
      removed.push(entry.path)
    }
  }

  cleanupEmptyDirs(touchedDirs)

  // Uninstall clears the manifest — a subsequent install starts fresh
  // (P-5 idempotency: install → uninstall → install produces the same
  // filesystem state as a first-ever install, not accumulated entries).
  saveAgentManifest({
    schemaVersion: 1,
    installedAt: new Date(0).toISOString(),
    packSchemaVersion: 0,
    entries: [],
  })

  return { removed, restored, alreadyGone, rejected }
}

/** Remove now-empty directories, deepest first, stopping at the first non-empty one per branch. */
function cleanupEmptyDirs(dirs: ReadonlySet<string>): void {
  const sorted = [...dirs].sort((a, b) => b.length - a.length)
  for (const dir of sorted) {
    let current = dir
    // Walk upward while each level is empty; stop at the first non-empty
    // (or missing/root) directory. Bounded by path length, never infinite.
    for (let i = 0; i < 32; i++) {
      try {
        rmdirSync(current)
      } catch {
        break // non-empty, missing, or permission-denied — stop this branch.
      }
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  }
}
