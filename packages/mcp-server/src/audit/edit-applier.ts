/**
 * @fileoverview Edit-applier — file-mutation path for `RecommendedEdit` (SMI-4589 Wave 3 Step 5).
 * @module @skillsmith/mcp-server/audit/edit-applier
 *
 * `applyRecommendedEdit` mutates a SKILL.md or CLAUDE.md file in-place
 * after the per-template gate has cleared. The mutation flow:
 *
 *   1. Registry guard — reject `pattern`s not in `APPLY_TEMPLATE_REGISTRY`.
 *   2. Stale-before guard — verify file content at `lineRange` matches
 *      the recorded `before` snippet byte-for-byte.
 *   3. Backup — `createProseBackup(filePath, 'prose-edit')`.
 *   4. Atomic write — write to `<filePath>.tmp` then `fs.rename`.
 *   5. Ledger append — `appendOverride` + `writeLedger` (Wave 2 PR #1).
 *   6. Return `EditApplyResult` with the inline revert summary
 *      (decision #10).
 *
 * Per-template gate (ratified 2026-05-01): `APPLY_TEMPLATE_REGISTRY` is
 * a literal allowlist containing only `'add_domain_qualifier'` in v1
 * (4.10/5 from GPT-5.4 reviewer-#2 scoring). Synthetic edits with
 * `pattern: 'narrow_scope'` or `'reword_trigger_verb'` are rejected with
 * `error: 'edit.template_not_in_apply_registry'` and mutate nothing —
 * the regression guard test asserts this. SMI-4593 reauthors the failing
 * templates; when their bodies clear the per-template gate, that issue
 * extends this allowlist.
 *
 * Plan: docs/internal/implementation/smi-4589-edit-suggester.md §5.
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'

import { appendOverride, readLedger, writeLedger } from './namespace-overrides.js'
import { createProseBackup } from '../tools/install.conflict-helpers.js'
import type { EditApplyResult } from './edit-applier.types.js'
import type { EditTemplatePattern, RecommendedEdit } from './edit-suggester.types.js'

/**
 * Allowlist of template patterns whose `apply_with_confirmation` mode is
 * registered for file mutation. Per the per-template gate ratified
 * 2026-05-01, only `add_domain_qualifier` (4.10/5) ships in v1.
 *
 * SMI-4593 extends this set when the failing templates clear the gate
 * post-reauthoring. Plan §6 mandates plan-review verifies this set
 * matches `goal_6.per_template_gate.verdicts` PASS templates exactly.
 *
 * Type-narrow: declared as `ReadonlySet<EditTemplatePattern>` so the
 * runtime check can't drift from the type union.
 */
export const APPLY_TEMPLATE_REGISTRY: ReadonlySet<EditTemplatePattern> =
  new Set<EditTemplatePattern>(['add_domain_qualifier'])

export interface ApplyRecommendedEditOptions {
  /**
   * FK into `~/.skillsmith/audits/<auditId>/result.json`. Persisted in
   * the ledger entry so revert can re-derive the original collision
   * context.
   */
  auditId: string
  /**
   * Apply mode. Only `'apply_with_confirmation'` triggers mutation; any
   * other value is rejected by registry guard ahead of mutation. The
   * argument is preserved for forward-compat with v2 LLM-driven mode.
   */
  mode: 'apply_with_confirmation'
}

/**
 * Apply a `RecommendedEdit` to disk. The agent calls this after
 * surfacing the edit + receiving user confirmation. Atomic — failure
 * before mutation leaves the file untouched; failure during mutation
 * leaves the original file in place via tmp-file + rename semantics.
 */
export async function applyRecommendedEdit(
  edit: RecommendedEdit,
  opts: ApplyRecommendedEditOptions
): Promise<EditApplyResult> {
  // 1. Registry guard. Synthetic edits constructed by tests with a
  //    failing-template pattern hit this first — no I/O before reject.
  if (!APPLY_TEMPLATE_REGISTRY.has(edit.pattern)) {
    return {
      success: false,
      collisionId: edit.collisionId,
      pattern: edit.pattern,
      filePath: edit.filePath,
      backupPath: '',
      ledgerEntryId: '',
      summary: '',
      error: {
        kind: 'edit.template_not_in_apply_registry',
        pattern: edit.pattern,
        message: `Template pattern "${edit.pattern}" is not in APPLY_TEMPLATE_REGISTRY; cannot apply. Render in 'manual_review' mode only.`,
      },
    }
  }

  // 2. Stale-before guard. Read the file and verify the snippet at
  //    lineRange matches byte-for-byte. Any drift → reject.
  let fileContent: string
  try {
    fileContent = await fs.readFile(edit.filePath, 'utf-8')
  } catch (err) {
    return failFsError(edit, `read failed: ${(err as Error).message}`)
  }

  const fileLines = fileContent.split('\n')
  const startIdx = edit.lineRange.start - 1
  const endIdx = edit.lineRange.end - 1
  if (startIdx < 0 || endIdx >= fileLines.length || startIdx > endIdx) {
    return staleBeforeError(edit, 'line range out of bounds')
  }
  const onDiskSnippet = fileLines.slice(startIdx, endIdx + 1).join('\n')
  if (onDiskSnippet !== edit.before) {
    return staleBeforeError(edit, 'before snippet mismatch')
  }

  // 3. Backup BEFORE any mutation. Failure here aborts — never mutate
  //    without a recoverable backup.
  let backupPath: string
  try {
    const backup = await createProseBackup(edit.filePath, 'prose-edit')
    backupPath = backup.backupPath
  } catch (err) {
    return {
      success: false,
      collisionId: edit.collisionId,
      pattern: edit.pattern,
      filePath: edit.filePath,
      backupPath: '',
      ledgerEntryId: '',
      summary: '',
      error: {
        kind: 'edit.backup_failed',
        reason: (err as Error).message,
        message: `Backup failed for ${edit.filePath}; file not mutated.`,
      },
    }
  }

  // 4. Atomic write — splice in the after-snippet at lineRange, write
  //    to <filePath>.<random>.tmp, fs.rename.
  const newLines = [
    ...fileLines.slice(0, startIdx),
    ...edit.after.split('\n'),
    ...fileLines.slice(endIdx + 1),
  ]
  const newContent = newLines.join('\n')
  const tmpSuffix = crypto.randomBytes(6).toString('hex')
  const tmpPath = `${edit.filePath}.${tmpSuffix}.tmp`

  try {
    await fs.writeFile(tmpPath, newContent, 'utf-8')
    await fs.rename(tmpPath, edit.filePath)
  } catch (err) {
    // Best-effort tmp cleanup; ENOENT is fine.
    try {
      await fs.rm(tmpPath, { force: true })
    } catch {
      /* swallow */
    }
    return {
      success: false,
      collisionId: edit.collisionId,
      pattern: edit.pattern,
      filePath: edit.filePath,
      backupPath,
      ledgerEntryId: '',
      summary: '',
      error: {
        kind: 'edit.fs_error',
        reason: (err as Error).message,
        message: `File mutation failed for ${edit.filePath}; backup retained at ${backupPath}.`,
      },
    }
  }

  // 5. Ledger append. We piggyback on the namespace-overrides ledger
  //    (Wave 2 PR #1) — same last-write-wins atomic semantics. The
  //    `kind` field accepts only `InventoryKind` values; we encode the
  //    prose-edit case via `originalIdentifier` = filename + lineRange
  //    marker so revert can locate the entry by `auditId`.
  const ledger = await readLedger()
  const lineMarker = `lines:${edit.lineRange.start}-${edit.lineRange.end}`
  const updated = appendOverride(ledger, {
    skillId: null,
    // SMI-4589 carve-out: prose edits target SKILL.md / CLAUDE.md, not
    // a renamed inventory artifact. We tag the kind by best-fit
    // inventory match — `claude_md_rule` for CLAUDE.md edits, `skill`
    // for SKILL.md edits — to keep the existing ledger union
    // unchanged. Wave 4 / SMI-4590 may extend the union with a
    // `'prose_edit'` discriminator if revert ergonomics demand it.
    kind: edit.category === 'claude_md_trigger_overlap' ? 'claude_md_rule' : 'skill',
    originalIdentifier: `${edit.filePath}:${lineMarker}`,
    renamedTo: `${edit.filePath}:${lineMarker}:prose-edit`,
    originalPath: edit.filePath,
    renamedPath: edit.filePath,
    auditId: opts.auditId,
    reason: edit.rationale,
  })
  if (updated !== ledger) {
    await writeLedger(updated)
  }
  const ledgerEntryId =
    updated === ledger ? '' : (updated.overrides[updated.overrides.length - 1]?.id ?? '')

  // 6. Return success with the inline revert summary literal.
  return {
    success: true,
    collisionId: edit.collisionId,
    pattern: edit.pattern,
    filePath: edit.filePath,
    backupPath,
    ledgerEntryId,
    summary: buildSummary(edit.filePath, edit.lineRange, opts.auditId),
  }
}

/**
 * Inline revert-summary literal (decision #10). Mirrors Wave 2's UX —
 * `sklx audit revert <auditId>` is a Wave 4 (SMI-4590) command surface;
 * if Wave 4 hasn't shipped at the time this fires, the summary remains
 * user-facing copy and the command is a no-op until SMI-4590 lands.
 */
function buildSummary(
  filePath: string,
  lineRange: { start: number; end: number },
  auditId: string
): string {
  // Always emit `start-end` form even on single-line ranges. The Wave 4
  // CLI surface (`sklx audit revert`) parses the range; a stable two-
  // number form simplifies the parser and matches the literal copy in
  // the plan §5: `"Edited <file> lines <range>. To undo: ..."`.
  const range = `${lineRange.start}-${lineRange.end}`
  return `Edited ${filePath} lines ${range}. To undo: sklx audit revert ${auditId}`
}

function staleBeforeError(edit: RecommendedEdit, reason: string): EditApplyResult {
  return {
    success: false,
    collisionId: edit.collisionId,
    pattern: edit.pattern,
    filePath: edit.filePath,
    backupPath: '',
    ledgerEntryId: '',
    summary: '',
    error: {
      kind: 'edit.stale_before',
      filePath: edit.filePath,
      message: `Before snippet mismatch for ${edit.filePath} at lines ${edit.lineRange.start}-${edit.lineRange.end} (${reason}). Re-run detection.`,
    },
  }
}

function failFsError(edit: RecommendedEdit, reason: string): EditApplyResult {
  return {
    success: false,
    collisionId: edit.collisionId,
    pattern: edit.pattern,
    filePath: edit.filePath,
    backupPath: '',
    ledgerEntryId: '',
    summary: '',
    error: {
      kind: 'edit.fs_error',
      reason,
      message: `File access failed for ${edit.filePath}: ${reason}`,
    },
  }
}
