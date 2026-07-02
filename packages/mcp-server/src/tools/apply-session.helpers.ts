/**
 * @fileoverview In-process session-apply stack for `undo_apply`
 *               (SMI-5456 Wave 1 Step 3 / SMI-5470).
 * @module @skillsmith/mcp-server/tools/apply-session.helpers
 *
 * "Session-scoped undo" (PRD §7 trust loop) means: only applies made by
 * THIS running MCP server process are undoable. There is no persistence —
 * the stack lives in a module-scoped array and is gone on restart, matching
 * the plan's P-5 table ("Undo tool ... Session-scoped (in-process only)").
 *
 * This module is intentionally separate from the journal
 * (`@skillsmith/core/journal`): the journal is a durable, cross-session
 * audit trail written for every apply/error/undo; this stack is a transient
 * index over the SUBSET of journal-worthy events (successful applies) that
 * `undo_apply` needs fast, in-memory access to. Losing this stack (process
 * restart) does not lose the journal.
 */

import { basename } from 'node:path'
import { readdir } from 'node:fs/promises'

/** One successfully-applied changeset, tracked for the life of this
 * server process. */
export interface SessionAppliedChangeset {
  /** The apply-family tool that made this change (`apply_namespace_rename` /
   * `apply_recommended_edit`). */
  tool: string
  /** The `collisionId` the mutation was applied for. */
  suggestionId: string
  /** The single content-hashable file this changeset mutated — see
   * `JournalRecordFields.target_path` for the skill-directory-rename
   * carve-out (this is always `<dir>/SKILL.md` in that case, never the
   * directory itself). */
  targetPath: string
  /** sha256 of `targetPath`'s content before the mutation. */
  beforeHash: string
  /** sha256 of `targetPath`'s content after the mutation (i.e. right now,
   * until something else touches the file). */
  afterHash: string
  /** The apply tool's own pre-mutation backup directory
   * (`createSkillBackup` / `createProseBackup`). */
  backupRef: string
  /** Basename of the one file inside `backupRef` that holds `targetPath`'s
   * pre-mutation bytes. Resolved once at apply-time (see
   * `resolveBackupFileName` below) so `undo_apply` never has to re-derive
   * "which file in this backup dir corresponds to my target" from scratch. */
  backupFileName: string
  ts: number
}

// Most-recent-last array; undo consumes from the end.
const sessionApplies: SessionAppliedChangeset[] = []

/** Record a successful apply. Called by the apply-family tools after a
 * mutation + journal write both succeed. */
export function recordSessionApply(entry: SessionAppliedChangeset): void {
  sessionApplies.push(entry)
}

/** Read-only snapshot, most-recent-last (matches internal storage order). */
export function listSessionApplies(): readonly SessionAppliedChangeset[] {
  return sessionApplies
}

/** Remove one entry by reference identity. No-op if not present (e.g.
 * already removed by a prior undo). */
export function removeSessionApply(entry: SessionAppliedChangeset): void {
  const idx = sessionApplies.indexOf(entry)
  if (idx !== -1) sessionApplies.splice(idx, 1)
}

/** Test-only reset — mirrors `resetJournalSessionIdForTests` in
 * `@skillsmith/core/journal`. */
export function resetSessionAppliesForTests(): void {
  sessionApplies.length = 0
}

/**
 * Select the target changesets for an `undo_apply` call:
 *   - `suggestionId` given: the single entry with that id, searched from
 *     most-recent, or `[]` if none match.
 *   - otherwise: the `count` (default 1) most-recent entries, most-recent
 *     first.
 *
 * Pure selection — does not mutate `sessionApplies`. `undo-apply.ts` removes
 * entries only after a successful restore.
 */
export function selectUndoTargets(opts: {
  count?: number
  suggestionId?: string
}): SessionAppliedChangeset[] {
  if (opts.suggestionId !== undefined) {
    for (let i = sessionApplies.length - 1; i >= 0; i--) {
      if (sessionApplies[i]!.suggestionId === opts.suggestionId) return [sessionApplies[i]!]
    }
    return []
  }
  const count = opts.count ?? 1
  const mostRecentFirst = [...sessionApplies].reverse()
  return mostRecentFirst.slice(0, count)
}

/**
 * Resolve which file inside an apply tool's backup directory holds the
 * pre-mutation bytes for `targetBasename`.
 *
 * The backup helpers (`createSkillBackup` / `createProseBackup`, in
 * `tools/install.conflict-helpers.ts`) always produce EITHER a single-file
 * backup dir (prose edit; command/agent rename, via the staged-tmp-dir
 * path) OR a whole-skill-directory backup dir (skill-dir rename) that
 * still contains exactly one `SKILL.md` at its top level. Either way there
 * is exactly one unambiguous candidate:
 *   - if the backup dir has exactly one entry, use it (covers both
 *     single-file cases; the entry's name need not match `targetBasename`
 *     because a rename backup is filed under the file's ORIGINAL name);
 *   - otherwise (a multi-file skill-directory backup) use `SKILL.md`,
 *     which is the only file `apply_namespace_rename` / journal ever
 *     mutate inside that tree.
 */
export async function resolveBackupFileName(
  backupRef: string,
  targetPath: string
): Promise<string | null> {
  let entries: string[]
  try {
    entries = await readdir(backupRef)
  } catch {
    return null
  }
  if (entries.length === 1) return entries[0]!
  const targetBase = basename(targetPath)
  if (entries.includes(targetBase)) return targetBase
  if (entries.includes('SKILL.md')) return 'SKILL.md'
  return null
}
