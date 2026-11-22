/**
 * @fileoverview writeInstallFiles' companion-file write and its rollback body.
 * @module @skillsmith/core/services/skill-installation.io.companion
 * @see SMI-6531 (A1 step 8-i-a-3a, design § 1.3): moved out of
 *   skill-installation.io.write.ts (496 lines) before the staged mode was
 *   added; for the in-place (non-staged) mode a pure move, with the state the
 *   closures shared now on one {@link WriteTracker}. The staged mode's
 *   rollback skips every action on a path under the staged folder.
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { bindIdentity, sameIdentity } from '../install/park-tree.identity.js'
import type { BoundIdentity } from '../install/park-tree.identity.js'
import {
  getCompanionAgentTarget,
  resolveCompanionAgentPath,
  type ClientId,
} from '../install/paths.js'
import {
  classifyPreWrite,
  cleanupStep,
  removeCreatedDirectory,
  restoreSnapshots,
  type EntryIdentity,
  type FileSnapshot,
} from './skill-installation.io.rollback.js'

/** Errors a non-recursive rmdir in rollback can ignore: already gone, or holding content this call didn't create. */
const DIR_GONE_OR_NOT_OURS = ['ENOENT', 'ENOTEMPTY', 'EEXIST'] as const

/** A file this call created: its path, its (dev, ino), and (staged mode) its full bound identity. */
export interface CreatedFile {
  path: string
  identity?: { dev: number; ino: number }
  /** Staged mode only: bigint (dev, ino, birthtime, type), bound right after the exclusive create. */
  bound?: BoundIdentity
}

/** What one writeInstallFiles call has done so far: the state its write steps and its rollback share. */
export interface WriteTracker {
  /** Files this call OVERWROTE (snapshotted, restorable). */
  overwritten: FileSnapshot[]
  /** Files this call CREATED FRESH (safe to unlink when still the same file). */
  createdFresh: CreatedFile[]
  /** Nested sub-skill directories this call created fresh. */
  freshDirs: Set<string>
  subagentPath: string | undefined
  companionSkipped: boolean
  /** Whether the directory-package per-skill agent directory existed before this call. */
  agentDirPreExisted: boolean
  /** Whether installPath existed before this call (staged mode: false, the folder is the caller's). */
  preExisted: boolean
  /** True once installPath is proven inside skillsDir (lexical and realpath). */
  pathValidated: boolean
  /** The identity of the directory this call created, if it did. */
  installDirIdentity: EntryIdentity | undefined
  /**
   * Staged mode (8-i-a-3a): the resolved folder the caller made and owns.
   * Rollback never restores, unlinks or removes anything under it. Null: the
   * in-place mode.
   */
  stagedDir: string | null
}

/** A fresh tracker for one call. */
export function newWriteTracker(stagedDir: string | null): WriteTracker {
  return {
    overwritten: [],
    createdFresh: [],
    freshDirs: new Set<string>(),
    subagentPath: undefined,
    companionSkipped: false,
    agentDirPreExisted: true,
    preExisted: false,
    pathValidated: false,
    installDirIdentity: undefined,
    stagedDir,
  }
}

/** True when `p` is the staged folder or under it (always false in the in-place mode). */
export function underStaged(t: Pick<WriteTracker, 'stagedDir'>, p: string): boolean {
  if (t.stagedDir === null) return false
  const r = path.resolve(p)
  return r === t.stagedDir || r.startsWith(t.stagedDir + path.sep)
}

/** Whether the file at `entry.path` is still the one this call created; null when it is gone. */
async function stillCreated(
  entry: CreatedFile,
  cleanupFailures: string[]
): Promise<boolean | null> {
  // Staged mode: the full identity, birthtime and type included.
  if (entry.bound !== undefined) {
    const now = bindIdentity(entry.path)
    if (!now.ok) {
      if (now.errno !== 'ENOENT') cleanupFailures.push(`${entry.path} (${now.errno ?? 'unknown'})`)
      return null
    }
    return sameIdentity(entry.bound, now)
  }
  if (!entry.identity) return true
  // R5: skip a path that no longer names the file this call created.
  let current
  try {
    current = await fs.lstat(entry.path)
  } catch (err) {
    // Round 25 (cross-model review): only absence means "already gone".
    // Any other failure means this call could not tell what is at the
    // path, so it is reported rather than counted as a clean rollback.
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      cleanupFailures.push(
        `${entry.path} (${code ?? (err instanceof Error ? err.message : String(err))})`
      )
    }
    return null
  }
  return current.dev === entry.identity.dev && current.ino === entry.identity.ino
}

/**
 * SMI-6529 M7: shared cleanup — restores every overwritten file and removes
 * everything created fresh. Staged mode (8-i-a-3a, design § 1.3): every
 * action on a path under the staged folder is skipped (no snapshot restore,
 * no unlink, no `rmdir`, no folder removal); what remains is the companion
 * file's identity-checked unlink and the directory-package agent dir's
 * non-recursive `rmdir` (D4).
 */
export async function performRollback(
  t: WriteTracker,
  installPath: string,
  client: ClientId
): Promise<{ restoreFailures: string[]; cleanupFailures: string[] }> {
  const restoreFailures = await restoreSnapshots(
    t.stagedDir === null ? t.overwritten : t.overwritten.filter((s) => !underStaged(t, s.path))
  )
  // Round 13 (cross-model review): every cleanup failure is collected and
  // reported through InstallRestoreError instead of swallowed.
  const cleanupFailures: string[] = []
  for (const entry of t.createdFresh) {
    if (underStaged(t, entry.path)) continue
    const same = await stillCreated(entry, cleanupFailures)
    if (same !== true) continue
    await cleanupStep(entry.path, () => fs.unlink(entry.path), ['ENOENT'], cleanupFailures)
  }
  // F4 (review round 1): remove nested sub-skill directories THIS call created
  // fresh (e.g. "scripts/") — files must be gone first (done above), and a
  // non-recursive rmdir requires children removed before parents, hence the
  // deepest-first ordering (sorted by path-separator count, not string length —
  // a short deep path must still sort before a long shallow one). ENOENT
  // (already removed by a sibling's identical cleanup) and non-empty
  // (content this call didn't create) mean nothing of ours is left.
  const deepestFirst = [...t.freshDirs]
    .filter((d) => !underStaged(t, d))
    .sort((a, b) => b.split(path.sep).length - a.split(path.sep).length)
  for (const dir of deepestFirst) {
    await cleanupStep(dir, () => fs.rmdir(dir), DIR_GONE_OR_NOT_OURS, cleanupFailures)
  }
  // SMI-5982 (Wave 6) / SMI-6529 L15: 'directory-package' mode (Antigravity)
  // creates a skill-named subdirectory OUTSIDE installPath
  // (<agentsDir>/<skillName>/agent.md) that 'flat' mode never needed —
  // every other client's agents dir is a shared, pre-existing directory,
  // never created per-skill. Only rmdir it when THIS call created it
  // (`!agentDirPreExisted`) — a forced reinstall's per-skill directory that
  // pre-existed must never be removed just because this rollback ran; the
  // rmdir is non-recursive regardless (a safe no-op on non-empty content).
  if (
    t.subagentPath &&
    !t.agentDirPreExisted &&
    getCompanionAgentTarget(client).fileMode === 'directory-package'
  ) {
    const agentDir = path.dirname(t.subagentPath)
    await cleanupStep(agentDir, () => fs.rmdir(agentDir), DIR_GONE_OR_NOT_OURS, cleanupFailures)
  }
  // SMI-6529: NEVER remove installPath once it is known to have preExisted — the
  // caller (or a prior install) owned that directory before this call started.
  // Only a directory THIS call created may ever be removed, and only once it has
  // been PROVEN inside skillsDir (pathValidated) — so an untracked orphan from a
  // mid-batch Promise.all write can't survive. If mkdir or the realpath escape
  // guard threw, installPath was never validated; fall back to a non-recursive
  // rmdir, a safe no-op on a non-empty or out-of-bounds directory (NEVER a
  // recursive force-delete of an unvalidated path). Round 13: and the
  // recursive delete runs only while installPath is still the directory
  // this call created; anything put there since is left and reported.
  // Staged mode: the folder is the caller's; it is never removed here.
  if (!t.preExisted && t.stagedDir === null) {
    if (t.pathValidated) {
      await removeCreatedDirectory(installPath, t.installDirIdentity, cleanupFailures)
    } else {
      await cleanupStep(
        installPath,
        () => fs.rmdir(installPath),
        DIR_GONE_OR_NOT_OURS,
        cleanupFailures
      )
    }
  }
  return { restoreFailures, cleanupFailures }
}

/** What the companion write needs from its call. */
export interface CompanionWrite {
  skillName: string
  subagentContent: string
  client: ClientId
  companionBaseDir: string | undefined
  /** writeInstallFiles' queued, classified write. */
  writeTracked: (filePath: string, content: string) => Promise<void>
  /** Staged mode: runs before each create outside the staged folder too. */
  beforeCreate: (() => void) | undefined
}

/** Writes the companion subagent file (outside installPath), recording what it did on `t`. */
export async function writeCompanion(t: WriteTracker, c: CompanionWrite): Promise<void> {
  t.subagentPath = resolveCompanionAgentPath(c.skillName, c.client, c.companionBaseDir)
  const agentsDir = path.dirname(t.subagentPath)
  if (getCompanionAgentTarget(c.client).fileMode === 'directory-package') {
    // Round 27 (cross-model review): only absence means "this call created
    // it". Any other lstat failure used to record `false`, and rollback
    // rmdirs this directory precisely when that is false — so one
    // unreadable moment could cost the user a directory that was already
    // there. Fail closed instead: nothing has been written yet, so
    // throwing here leaves nothing behind.
    try {
      await fs.lstat(agentsDir)
      t.agentDirPreExisted = true
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw err
      t.agentDirPreExisted = false
    }
  }
  c.beforeCreate?.()
  await fs.mkdir(agentsDir, { recursive: true })
  // SMI-6529 M10: a FRESH install must never silently overwrite an
  // existing companion agent file — it could belong to an unrelated
  // skill/agent the user created by hand. A forced reinstall of an
  // already-tracked skill (`preExisted`) still overwrites it, tracked
  // and restorable like everything else. Staged mode is always fresh.
  if (!t.preExisted) {
    const companionClassification = await classifyPreWrite(t.subagentPath)
    // SMI-6529 N11 (round 4): treat ANY existing non-absent entry the
    // same way — not just a 'regular' file. The old check only skipped a
    // 'regular' file, so a SYMLINKED companion path (a stale/planted
    // link) fell to the `else` branch and went through `writeTracked()`,
    // whose `safeWriteFile()` throws `SymlinkError` on it — rolling back
    // the ENTIRE install (SKILL.md, every sub-skill) over an unrelated
    // pre-existing symlink at a completely different path. A fresh
    // install must skip ('other' or 'regular') exactly the same way.
    if (companionClassification.kind !== 'absent') {
      t.companionSkipped = true
      t.subagentPath = undefined
    } else {
      await c.writeTracked(t.subagentPath, c.subagentContent)
    }
  } else {
    await c.writeTracked(t.subagentPath, c.subagentContent)
  }
}
