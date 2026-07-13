/**
 * @fileoverview Shared journal-write + session-apply-registration path for
 *               the apply-family tools (SMI-5456 Wave 1 Step 3 / SMI-5470).
 * @module @skillsmith/mcp-server/tools/apply-journal.helpers
 *
 * `apply_namespace_rename` and `apply_recommended_edit` both call
 * `journalApplySuccess` / `journalApplyError` at their mutation boundary
 * instead of talking to `@skillsmith/core/journal` directly — this keeps
 * the hashing + backup-file-resolution logic in one place instead of
 * duplicated across two tool files.
 *
 * `target_path` scope decision (also documented on
 * `JournalRecordFields.target_path` in `@skillsmith/core/journal`): for a
 * skill-DIRECTORY rename (`rename_skill_dir_and_frontmatter`), the journal
 * records `<newSkillDir>/SKILL.md`, not the directory. A directory has no
 * single "content hash", and the directory-path-reversal half of that
 * mutation already has a dedicated, ledger-backed mechanism
 * (`rename-engine.ts`'s `action: 'revert'`, surfaced today via
 * `apply_namespace_rename`'s `action: 'revert'` — SMI-5671; the CLI's
 * `sklx audit revert` this comment previously cited was never
 * implemented). Duplicating path-reversal here — driven only by
 * this record's fixed `target_path` field, with no companion "restore to"
 * field in the schema — would create two independent undo mechanisms for
 * the same mutation with no shared source of truth, which is precisely the
 * kind of coordination hazard the P-5 single-writer invariant exists to
 * avoid. `undo_apply` therefore restores SKILL.md's CONTENT (reverting the
 * frontmatter rewrite) but does not rename the directory back; full-path
 * reversal for a skill-dir rename remains `apply_namespace_rename`'s
 * `action: 'revert'`'s job.
 *
 * Fail-soft by design: the file mutation the user asked for has already
 * succeeded (or definitively failed) by the time these helpers run. A
 * journal I/O hiccup must never turn a successful apply into a failed tool
 * response — every call here swallows its own errors and logs to stderr.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  appendJournalRecord,
  getJournalSessionId,
  sha256Hex,
  JOURNAL_SCHEMA_VERSION,
} from '@skillsmith/core/journal'
import { recordSessionApply, resolveBackupFileName } from './apply-session.helpers.js'

async function hashFileSafe(path: string): Promise<string | null> {
  try {
    return sha256Hex(await readFile(path))
  } catch {
    return null
  }
}

export interface JournalApplySuccessInput {
  /** `'apply_namespace_rename'` | `'apply_recommended_edit'`. */
  tool: string
  suggestionId: string
  /** The content-hashable file the mutation changed (see module header). */
  targetPath: string
  /** The apply tool's pre-mutation backup dir, or `''` for an idempotent
   * re-apply OR a revert — reverts never take a fresh backup (SMI-5671:
   * the original apply's backup already covers this), so `backupRef`
   * alone can't distinguish "nothing changed" from "reverted, no fresh
   * backup needed". Use `isNoOp` for that. */
  backupRef: string
  /** Caller-supplied approval mode, e.g. `'apply'` / `'custom'` /
   * `'apply_with_confirmation'`. */
  approval: string
  /** SMI-5671: which direction this mutation ran — `apply_namespace_rename`'s
   * `action: 'revert'` calls this same success-journaling path as
   * `apply`/`custom`, so the journal record's `action` field can no longer
   * be hardcoded to `'apply'`. */
  action: 'apply' | 'revert'
  /** SMI-5671: the engine's own idempotency signal (`fromPath === toPath`).
   * NOT the same thing as `backupRef === ''` — a genuine (non-no-op)
   * revert also has `backupRef === ''` by design, so branching on
   * `backupRef` alone would mislabel every real revert as
   * `idempotent_no_op` in the audit trail. */
  isNoOp: boolean
}

/**
 * Journal a successful mutation and, when a restorable backup exists,
 * register it on the session-apply stack so `undo_apply` can reach it.
 */
export async function journalApplySuccess(input: JournalApplySuccessInput): Promise<void> {
  try {
    const afterHash = await hashFileSafe(input.targetPath)

    if (input.backupRef === '') {
      if (input.isNoOp) {
        // Idempotent no-op (apply re-apply, or revert with no matching
        // ledger entry): nothing changed, so there is no fresh backup to
        // undo TO. Journal the event for the evidence trail but don't add
        // a session-apply entry — there is nothing for undo_apply to
        // restore.
        await appendJournalRecord({
          schema: JOURNAL_SCHEMA_VERSION,
          ts: Date.now(),
          session_id: getJournalSessionId(),
          tool: input.tool,
          action: input.action,
          suggestion_id: input.suggestionId,
          target_path: input.targetPath,
          before_hash: afterHash,
          after_hash: afterHash,
          approval: input.approval,
          backup_ref: null,
          detail: 'idempotent_no_op',
        })
        return
      }

      // A genuine revert (SMI-5671): the mutation already happened (per
      // the module's fail-soft contract, by the time this runs) and
      // reverts never take a fresh backup, so there's no `backupRef` to
      // resolve a `before_hash` from. Record what's actually verifiable —
      // the post-revert content — rather than fabricate a `before_hash`
      // this call site has no way to obtain.
      await appendJournalRecord({
        schema: JOURNAL_SCHEMA_VERSION,
        ts: Date.now(),
        session_id: getJournalSessionId(),
        tool: input.tool,
        action: input.action,
        suggestion_id: input.suggestionId,
        target_path: input.targetPath,
        before_hash: null,
        after_hash: afterHash,
        approval: input.approval,
        backup_ref: null,
        detail: null,
      })
      return
    }

    const backupFileName = await resolveBackupFileName(input.backupRef, input.targetPath)
    const beforeHash =
      backupFileName !== null ? await hashFileSafe(join(input.backupRef, backupFileName)) : null

    await appendJournalRecord({
      schema: JOURNAL_SCHEMA_VERSION,
      ts: Date.now(),
      session_id: getJournalSessionId(),
      tool: input.tool,
      action: input.action,
      suggestion_id: input.suggestionId,
      target_path: input.targetPath,
      before_hash: beforeHash,
      after_hash: afterHash,
      approval: input.approval,
      backup_ref: input.backupRef,
      detail: backupFileName === null ? 'backup_file_unresolved' : null,
    })

    if (backupFileName !== null && beforeHash !== null && afterHash !== null) {
      recordSessionApply({
        tool: input.tool,
        suggestionId: input.suggestionId,
        targetPath: input.targetPath,
        beforeHash,
        afterHash,
        backupRef: input.backupRef,
        backupFileName,
        ts: Date.now(),
      })
    }
  } catch (err) {
    console.error(
      `[apply-journal] failed to journal successful apply (tool=${input.tool}, suggestion=${input.suggestionId}): ${(err as Error).message}`
    )
  }
}

export interface JournalApplyErrorInput {
  tool: string
  suggestionId: string
  targetPath: string | null
  approval: string | null
  /** Typed error kind from the apply engine, e.g.
   * `'namespace.rename.backup_failed'`. */
  errorKind: string
}

/** Journal a failed mutation attempt. */
export async function journalApplyError(input: JournalApplyErrorInput): Promise<void> {
  try {
    await appendJournalRecord({
      schema: JOURNAL_SCHEMA_VERSION,
      ts: Date.now(),
      session_id: getJournalSessionId(),
      tool: input.tool,
      action: 'error',
      suggestion_id: input.suggestionId,
      target_path: input.targetPath,
      before_hash: null,
      after_hash: null,
      approval: input.approval,
      backup_ref: null,
      detail: input.errorKind,
    })
  } catch (err) {
    console.error(
      `[apply-journal] failed to journal apply error (tool=${input.tool}, suggestion=${input.suggestionId}): ${(err as Error).message}`
    )
  }
}

export interface JournalUndoInput {
  tool: string
  suggestionId: string
  targetPath: string
  /** File content hash immediately before the undo restore ran (i.e. the
   * applied state — should equal the original apply's `after_hash`). */
  beforeHash: string
  /** File content hash immediately after the undo restore ran (i.e. the
   * restored state — should equal the original apply's `before_hash`). */
  afterHash: string
}

/** Journal a successful undo restore. */
export async function journalUndo(input: JournalUndoInput): Promise<void> {
  try {
    await appendJournalRecord({
      schema: JOURNAL_SCHEMA_VERSION,
      ts: Date.now(),
      session_id: getJournalSessionId(),
      tool: input.tool,
      action: 'undo',
      suggestion_id: input.suggestionId,
      target_path: input.targetPath,
      before_hash: input.beforeHash,
      after_hash: input.afterHash,
      approval: 'undo',
      backup_ref: null,
      detail: null,
    })
  } catch (err) {
    console.error(
      `[apply-journal] failed to journal undo (tool=${input.tool}, suggestion=${input.suggestionId}): ${(err as Error).message}`
    )
  }
}
