/**
 * @fileoverview Revert path for the rename engine (SMI-5671).
 * @module @skillsmith/mcp-server/audit/rename-engine.revert
 *
 * Split out of `rename-engine.ts` (SMI-5671, <500-line file-length gate) —
 * `revertRename` is the inverse of `applyRename`'s forward-rename paths and
 * has no dependency on them beyond shared helpers.
 *
 * Plan: docs/internal/implementation/smi-5671-apply-namespace-rename-revert-action.md
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { readLedger, writeLedger } from './namespace-overrides.js'
import {
  buildSummary,
  fsErr,
  pathExists,
  resolveRenameTarget,
} from './rename-engine.apply-paths.js'
import { rewriteFrontmatterName } from './rename-engine.helpers.js'
import type { ApplyRenameResult, RenameSuggestion } from './rename-engine.types.js'

/**
 * Inverse of `applyRename`. Looks up the ledger entry by
 * `(auditId, collisionId)`, renames the file back to `originalIdentifier`,
 * and removes the ledger entry. Backup is kept for forensics until the
 * 30-day GC sweep.
 *
 * Lookup disambiguation (SMI-5671 Change 0): a single audit run can resolve
 * 2+ collisions, appending 2+ ledger entries that all share one `auditId`,
 * so `auditId` alone is NOT sufficient to pick the entry to revert. The
 * lookup: (1) filter by `auditId`; (2) prefer an entry whose `collisionId`
 * matches exactly; (3) if none match by `collisionId` and exactly one
 * `auditId`-only entry exists (a legacy pre-fix entry with no `collisionId`),
 * fall back to it — safe, because it fires only when there's no ambiguity;
 * (4) if 2+ `auditId`-only entries exist and none carry the requested
 * `collisionId`, refuse with `namespace.rename.revert_ambiguous` rather than
 * silently revert the wrong one.
 *
 * Idempotency: calling revert twice on the same `(auditId, collisionId)`
 * returns success with `fromPath === toPath` on the second call (the entry
 * is gone, so we treat it as a no-op success).
 */
export async function revertRename(
  suggestion: RenameSuggestion,
  auditId: string,
  collisionId: string
): Promise<ApplyRenameResult> {
  const ledger = await readLedger()
  const matches = ledger.overrides.filter((o) => o.auditId === auditId)

  // Prefer an exact (auditId, collisionId) match. Fall back to a single
  // unambiguous auditId-only match (legacy pre-collisionId entries). Refuse
  // when 2+ candidates share the auditId and none carry the requested
  // collisionId — guessing which to revert is silent corruption.
  let entry = matches.find((o) => o.collisionId === collisionId)
  if (!entry) {
    if (matches.length >= 2) {
      return {
        success: false,
        collisionId: suggestion.collisionId,
        appliedAction: suggestion.applyAction,
        appliedRequest: 'revert',
        fromPath: resolveRenameTarget(suggestion),
        toPath: '',
        backupPath: '',
        ledgerEntryId: '',
        summary: '',
        error: {
          kind: 'namespace.rename.revert_ambiguous',
          auditId,
          collisionId,
          candidateCount: matches.length,
          message: `revert is ambiguous: ${matches.length} ledger entries share auditId ${auditId} and none match collisionId ${collisionId}; re-run skill_inventory_audit to obtain current collisionIds`,
        },
      }
    }
    // `matches.length` is 0 or 1 here: `matches[0]` is either the single
    // legacy entry (safe fallback) or `undefined` (no entry → no-op below).
    entry = matches[0]
  }

  if (!entry) {
    // Idempotent no-op — already reverted (no ledger entry for this auditId).
    return {
      success: true,
      collisionId: suggestion.collisionId,
      appliedAction: suggestion.applyAction,
      appliedRequest: 'revert',
      fromPath: resolveRenameTarget(suggestion),
      toPath: resolveRenameTarget(suggestion),
      backupPath: '',
      ledgerEntryId: '',
      summary: buildSummary(
        suggestion.currentName,
        suggestion.currentName,
        auditId,
        collisionId,
        'revert'
      ),
    }
  }

  const action = suggestion.applyAction
  const onDisk = entry.renamedPath
  const target = entry.originalPath

  if (!(await pathExists(onDisk))) {
    return {
      success: false,
      collisionId: suggestion.collisionId,
      appliedAction: action,
      appliedRequest: 'revert',
      fromPath: onDisk,
      toPath: target,
      backupPath: '',
      ledgerEntryId: entry.id,
      summary: '',
      error: {
        kind: 'namespace.ledger.disk_divergence',
        ledgerRenamedTo: entry.renamedTo,
        onDisk,
        message: `revert source missing on disk: ${onDisk}`,
        remediationHint:
          'restore from ~/.claude/skills/.backups or remove the ledger entry manually',
      },
    }
  }

  if (target !== onDisk && (await pathExists(target))) {
    return {
      success: false,
      collisionId: suggestion.collisionId,
      appliedAction: action,
      appliedRequest: 'revert',
      fromPath: onDisk,
      toPath: target,
      backupPath: '',
      ledgerEntryId: entry.id,
      summary: '',
      error: {
        kind: 'namespace.rename.target_exists',
        target,
        message: `revert target already exists: ${target}`,
      },
    }
  }

  // Inverse rename. For skills, also restore the SKILL.md frontmatter
  // `name:` field to the original identifier. Backup is kept (forensics);
  // no fresh backup is taken on revert — the apply backup covers this case.
  try {
    if (action === 'rename_skill_dir_and_frontmatter') {
      const skillMdPath = path.join(onDisk, 'SKILL.md')
      const current = await fs.readFile(skillMdPath, 'utf-8')
      const restored = rewriteFrontmatterName(current, entry.originalIdentifier)
      if (!restored.ok) {
        return {
          success: false,
          collisionId: suggestion.collisionId,
          appliedAction: action,
          appliedRequest: 'revert',
          fromPath: onDisk,
          toPath: target,
          backupPath: '',
          ledgerEntryId: entry.id,
          summary: '',
          error: {
            kind: 'namespace.rename.frontmatter_rewrite_failed',
            reason: restored.error.message,
            message: `revert frontmatter rewrite failed: ${restored.error.message}`,
          },
        }
      }
      await fs.writeFile(skillMdPath, restored.content, 'utf-8')
      await fs.rename(onDisk, target)
    } else {
      await fs.rename(onDisk, target)
    }
  } catch (err) {
    return {
      success: false,
      collisionId: suggestion.collisionId,
      appliedAction: action,
      appliedRequest: 'revert',
      fromPath: onDisk,
      toPath: target,
      backupPath: '',
      ledgerEntryId: entry.id,
      summary: '',
      error: fsErr((err as Error).message),
    }
  }

  // Remove the ledger entry.
  const filtered = {
    version: ledger.version,
    overrides: ledger.overrides.filter((o) => o.id !== entry.id),
  }
  await writeLedger(filtered)

  return {
    success: true,
    collisionId: suggestion.collisionId,
    appliedAction: action,
    appliedRequest: 'revert',
    fromPath: onDisk,
    toPath: target,
    backupPath: '',
    ledgerEntryId: entry.id,
    summary: buildSummary(
      entry.renamedTo,
      entry.originalIdentifier,
      auditId,
      collisionId,
      'revert'
    ),
  }
}
