/**
 * @fileoverview Rename engine — applies confirmed namespace renames
 *               (SMI-4588 Wave 2 Step 4, PR #2).
 * @module @skillsmith/mcp-server/audit/rename-engine
 *
 * Three apply paths, gated on `RenameAction`:
 *
 * - `rename_command_file` — `~/.claude/commands/foo.md` → `<author>-foo.md`
 * - `rename_agent_file` — `~/.claude/agents/foo.md` → `<author>-foo.md`
 * - `rename_skill_dir_and_frontmatter` — rename the directory AND rewrite
 *   the SKILL.md `name:` frontmatter field.
 *
 * Plus `action: 'revert'` semantics: looks up the ledger entry by
 * `auditId`, performs the inverse rename (back to `originalIdentifier`),
 * removes the ledger entry, and restores the SKILL.md frontmatter.
 *
 * Backups are owned by the canonical `createSkillBackup` helper at
 * `tools/install.conflict-helpers.ts:87` (plan §1 Edit 4). Single-file
 * renames stage the file under a tmp directory so the helper (which
 * expects a source dir) backs up only the relevant file. Backups land in
 * `~/.claude/skills/.backups/<name>/<timestamp>_namespace-rename/`.
 *
 * Idempotency: before mutating, the engine consults the namespace-overrides
 * ledger. When the same `(skillId, originalIdentifier)` pair is already
 * in the ledger AND the on-disk filename matches the recorded
 * `renamedTo`, the call is a no-op (returns success with
 * `fromPath === toPath` and `backupPath === ''`).
 *
 * Disk-vs-ledger divergence: when the ledger has an entry but the on-disk
 * filename does NOT match `renamedTo`, the engine returns
 * `namespace.ledger.disk_divergence` rather than silently re-applying.
 *
 * Plan: docs/internal/implementation/smi-4588-rename-engine-ledger-install.md §1.
 */

import * as fs from 'node:fs/promises'

import { getBackupsDir } from '../tools/install.conflict-helpers.js'
import { appendOverride, findOverride, readLedger, writeLedger } from './namespace-overrides.js'
import {
  actionToKind,
  buildSummary,
  computeDestPath,
  deriveSkillId,
  fsErr,
  pathExists,
  resolveRenameTarget,
  runBackup,
} from './rename-engine.apply-paths.js'
import { rewriteFrontmatterName } from './rename-engine.helpers.js'
import { revertRename } from './rename-engine.revert.js'
import type { ApplyRenameRequest, ApplyRenameResult } from './rename-engine.types.js'

export { generateSuggestionChain } from './suggestion-chain.js'

/**
 * Public summary prefix used by the agent / CLI to detect inline revert
 * messages. Matches plan §1 decision #10 verbatim.
 */
export const REVERT_SUMMARY_PREFIX = 'Renamed'

/**
 * Apply (or revert) a rename. Single entrypoint for Wave 4's MCP tool.
 * Each apply path runs: idempotency check → backup → mutate → ledger
 * append → result. Revert: ledger lookup → inverse rename → ledger
 * remove → result.
 *
 * Idempotency contract: re-applying the same suggestion when the ledger
 * already records it AND on-disk state matches → returns success with
 * `fromPath === toPath` and `backupPath === ''` (no second backup).
 *
 * Disk-vs-ledger divergence: ledger entry exists but on-disk path does
 * NOT match `renamedTo` → `namespace.ledger.disk_divergence` error;
 * caller decides whether to `customName` over the divergence.
 */
export async function applyRename(input: ApplyRenameRequest): Promise<ApplyRenameResult> {
  const { suggestion, request } = input
  const auditId = request.auditId

  if (request.action === 'revert') {
    return revertRename(suggestion, auditId, request.collisionId)
  }

  const newName = request.customName ?? suggestion.suggested
  const skillId = deriveSkillId(suggestion)
  const action = suggestion.applyAction
  const kind = actionToKind(action)
  const ledger = await readLedger()

  // Idempotency / divergence check: do we already have a ledger entry for
  // this `(skillId, kind, originalIdentifier)`?
  const existing = findOverride(ledger, {
    skillId,
    kind,
    originalIdentifier: suggestion.currentName,
  })
  if (existing) {
    const onDiskMatches = await pathExists(existing.renamedPath)
    if (onDiskMatches) {
      // Idempotent no-op. Return success without touching disk or ledger.
      return {
        success: true,
        collisionId: suggestion.collisionId,
        appliedAction: action,
        appliedRequest: 'apply',
        fromPath: existing.renamedPath,
        toPath: existing.renamedPath,
        backupPath: '',
        ledgerEntryId: existing.id,
        summary: buildSummary(
          suggestion.currentName,
          existing.renamedTo,
          auditId,
          suggestion.collisionId,
          'apply'
        ),
      }
    }
    // Divergence — ledger says renamedTo, but it's not on disk. Refuse.
    return {
      success: false,
      collisionId: suggestion.collisionId,
      appliedAction: action,
      appliedRequest: 'apply',
      fromPath: resolveRenameTarget(suggestion),
      toPath: '',
      backupPath: '',
      ledgerEntryId: '',
      summary: '',
      error: {
        kind: 'namespace.ledger.disk_divergence',
        ledgerRenamedTo: existing.renamedTo,
        onDisk: resolveRenameTarget(suggestion),
        message: `ledger records rename to ${existing.renamedTo} but no file at ${existing.renamedPath}`,
        remediationHint:
          're-run skill_inventory_audit and reapply, or call apply_namespace_rename with customName to overwrite the ledger entry',
      },
    }
  }

  // Compute destination + verify it doesn't already exist (other than as
  // the source for an idempotent no-op handled above).
  const renameTarget = resolveRenameTarget(suggestion)
  const destPath = computeDestPath(suggestion, newName)
  if (destPath !== renameTarget && (await pathExists(destPath))) {
    return {
      success: false,
      collisionId: suggestion.collisionId,
      appliedAction: action,
      appliedRequest: 'apply',
      fromPath: renameTarget,
      toPath: destPath,
      backupPath: '',
      ledgerEntryId: '',
      summary: '',
      error: {
        kind: 'namespace.rename.target_exists',
        target: destPath,
        message: `rename target already exists: ${destPath}`,
      },
    }
  }

  // Backup before any mutation.
  let backupPath: string
  try {
    backupPath = await runBackup(suggestion)
  } catch (err) {
    return {
      success: false,
      collisionId: suggestion.collisionId,
      appliedAction: action,
      appliedRequest: 'apply',
      fromPath: renameTarget,
      toPath: destPath,
      backupPath: '',
      ledgerEntryId: '',
      summary: '',
      error: {
        kind: 'namespace.rename.backup_failed',
        reason: (err as Error).message,
        message: `backup failed: ${(err as Error).message}`,
      },
    }
  }

  // Mutate. For skill dirs: rewrite SKILL.md frontmatter, then rename the
  // directory. For command/agent: just rename.
  try {
    if (action === 'rename_skill_dir_and_frontmatter') {
      // `entry.source_path` IS the SKILL.md file for skill-kind entries
      // (see local-inventory.ts) — no path.join needed. `renameTarget` is
      // its parent, the actual skill directory to rename.
      const skillMdPath = suggestion.entry.source_path
      let original: string
      try {
        original = await fs.readFile(skillMdPath, 'utf-8')
      } catch (err) {
        return {
          success: false,
          collisionId: suggestion.collisionId,
          appliedAction: action,
          appliedRequest: 'apply',
          fromPath: renameTarget,
          toPath: destPath,
          backupPath,
          ledgerEntryId: '',
          summary: '',
          error: fsErr(`reading SKILL.md: ${(err as Error).message}`),
        }
      }
      const rewriteResult = rewriteFrontmatterName(original, newName)
      if (!rewriteResult.ok) {
        return {
          success: false,
          collisionId: suggestion.collisionId,
          appliedAction: action,
          appliedRequest: 'apply',
          fromPath: renameTarget,
          toPath: destPath,
          backupPath,
          ledgerEntryId: '',
          summary: '',
          error: {
            kind: 'namespace.rename.frontmatter_rewrite_failed',
            reason: rewriteResult.error.message,
            message: `frontmatter rewrite failed: ${rewriteResult.error.message}`,
          },
        }
      }
      await fs.writeFile(skillMdPath, rewriteResult.content, 'utf-8')
      await fs.rename(renameTarget, destPath)
    } else {
      await fs.rename(renameTarget, destPath)
    }
  } catch (err) {
    return {
      success: false,
      collisionId: suggestion.collisionId,
      appliedAction: action,
      appliedRequest: 'apply',
      fromPath: renameTarget,
      toPath: destPath,
      backupPath,
      ledgerEntryId: '',
      summary: '',
      error: fsErr((err as Error).message),
    }
  }

  // Append ledger entry + persist.
  const updated = appendOverride(ledger, {
    skillId,
    kind,
    originalIdentifier: suggestion.currentName,
    renamedTo: newName,
    originalPath: renameTarget,
    renamedPath: destPath,
    auditId,
    collisionId: suggestion.collisionId,
    reason: suggestion.reason,
  })
  // `appendOverride` returns reference-equal ledger when a duplicate
  // exists. Fresh appends produce a non-equal copy. Either way, persist
  // the updated state.
  if (updated !== ledger) {
    await writeLedger(updated)
  }
  const newEntry =
    updated === ledger
      ? findOverride(updated, {
          skillId,
          kind,
          originalIdentifier: suggestion.currentName,
        })
      : updated.overrides[updated.overrides.length - 1]

  return {
    success: true,
    collisionId: suggestion.collisionId,
    appliedAction: action,
    appliedRequest: 'apply',
    fromPath: renameTarget,
    toPath: destPath,
    backupPath,
    ledgerEntryId: newEntry?.id ?? '',
    summary: buildSummary(
      suggestion.currentName,
      newName,
      auditId,
      suggestion.collisionId,
      'apply'
    ),
  }
}

// Re-export `getBackupsDir` so downstream tooling (Wave 4) can resolve the
// backup directory without reaching into `tools/install.conflict-helpers.js`.
export { getBackupsDir }
