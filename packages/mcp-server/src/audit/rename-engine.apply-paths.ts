/**
 * @fileoverview Apply-path helpers for the rename engine
 *               (SMI-4588 Wave 2 Step 4, PR #2).
 * @module @skillsmith/mcp-server/audit/rename-engine.apply-paths
 *
 * Path computation, backup orchestration, and summary formatting helpers
 * extracted from `rename-engine.ts` to keep the main file <500 LOC per
 * CLAUDE.md file-size enforcement (Edit 4 / SMI-1865 governance).
 *
 * **No backup writer here either** — the canonical `createSkillBackup`
 * lives in `tools/install.conflict-helpers.ts`; this file orchestrates
 * single-file staging so that helper can copy a directory worth of one
 * file. Plan §1 Edit 4 still applies.
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { createSkillBackup } from '../tools/install.conflict-helpers.js'
import type { OverrideRecord } from './namespace-overrides.types.js'
import type { RenameAction, RenameError, RenameSuggestion } from './rename-engine.types.js'

/**
 * Map a `RenameAction` to the `OverrideRecord.kind` field. `command` /
 * `agent` are 1:1; `rename_skill_dir_and_frontmatter` maps to `skill`.
 */
export function actionToKind(action: RenameAction): OverrideRecord['kind'] {
  switch (action) {
    case 'rename_command_file':
      return 'command'
    case 'rename_agent_file':
      return 'agent'
    case 'rename_skill_dir_and_frontmatter':
      return 'skill'
  }
}

/**
 * `InventoryEntry.source_path` differs by kind (see local-inventory.ts):
 * for `skill` entries it is the `SKILL.md` FILE path, not the skill
 * directory; for `command`/`agent` entries it already is the target file.
 * Every rename/backup operation needs the actual on-disk thing being
 * renamed — resolve that once here instead of re-deriving it ad hoc at
 * each call site (that duplication is exactly how this bug happened:
 * multiple sites assumed `source_path` was already the skill directory).
 */
export function resolveRenameTarget(suggestion: RenameSuggestion): string {
  const src = suggestion.entry.source_path
  return suggestion.applyAction === 'rename_skill_dir_and_frontmatter' ? path.dirname(src) : src
}

/**
 * Compute the destination path on disk for a rename. For command/agent
 * files, swap the basename (sans `.md`) with `newName.md`. For skill
 * directories, rename the directory itself (a sibling of the current one).
 */
export function computeDestPath(suggestion: RenameSuggestion, newName: string): string {
  const target = resolveRenameTarget(suggestion)
  if (suggestion.applyAction === 'rename_skill_dir_and_frontmatter') {
    return path.join(path.dirname(target), newName)
  }
  return path.join(path.dirname(target), `${newName}.md`)
}

/**
 * `entry.meta?.author` may carry a slug like `anthropic` or a Skillsmith
 * manifest skillId like `anthropic/code-helper`. The latter is what the
 * ledger persists as `skillId`; the former is `null`. Heuristic: contains
 * `/` ⇒ skillId.
 */
export function deriveSkillId(suggestion: RenameSuggestion): string | null {
  const author = suggestion.entry.meta?.author
  if (typeof author !== 'string' || author.length === 0) return null
  return author.includes('/') ? author : null
}

export function fsErr(reason: string): RenameError {
  return {
    kind: 'namespace.rename.fs_error',
    reason,
    message: `filesystem error during rename: ${reason}`,
  }
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/**
 * Stage a single command/agent file under a tmp directory so
 * `createSkillBackup` (which copies a directory) backs up only that file.
 * Returns the tmp-dir path; the caller removes it after the helper runs.
 */
async function stageSingleFileForBackup(srcFile: string): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'skillsmith-rename-stage-'))
  await fs.copyFile(srcFile, path.join(tmp, path.basename(srcFile)))
  return tmp
}

/**
 * Run a backup before any on-disk mutation. Returns the backup directory
 * path on success; throws on failure. The error path is wrapped in a
 * typed `RenameError` by the caller.
 *
 * Backup naming: `<getBackupsDir()>/<skillName>/<timestamp>_namespace-rename/`
 * via the canonical helper (plan §1 Edit 4).
 */
export async function runBackup(suggestion: RenameSuggestion): Promise<string> {
  const action = suggestion.applyAction
  const target = resolveRenameTarget(suggestion)
  if (action === 'rename_skill_dir_and_frontmatter') {
    // `target` is the skill directory itself here — back it up directly.
    const skillName = path.basename(target)
    return createSkillBackup(skillName, target, 'namespace-rename')
  }
  // Single-file path — stage, back up the staged dir, clean up.
  const skillName = path.basename(target).replace(/\.md$/, '')
  const staged = await stageSingleFileForBackup(target)
  try {
    return await createSkillBackup(skillName, staged, 'namespace-rename')
  } finally {
    try {
      await fs.rm(staged, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
}

/**
 * Build the inline revert summary (decision #10, corrected by SMI-5671
 * Change 2):
 *   `"Renamed /<OLD> → /<NEW>. To undo: call apply_namespace_rename with
 *   auditId: '<auditId>', collisionId: '<collisionId>', action: 'revert'."`
 *
 * The undo hint names the real mechanism (`apply_namespace_rename`'s
 * `action: 'revert'` — SMI-5671; the CLI's `sklx audit revert` was never
 * implemented) and interpolates BOTH literal identifiers a caller in a
 * genuinely fresh session needs to invoke it: `auditId` alone is not
 * sufficient once Change 0's `(auditId, collisionId)` disambiguation is
 * load-bearing for a correct revert.
 *
 * For skill renames (no leading `/`), the summary still uses the `/`
 * prefix per the plan's literal text — agents render it as-is.
 */
export function buildSummary(
  oldIdentifier: string,
  newIdentifier: string,
  auditId: string,
  collisionId: string,
  action: 'apply' | 'revert'
): string {
  if (action === 'revert') {
    return `Reverted /${oldIdentifier} → /${newIdentifier}. Audit: ${auditId}`
  }
  return `Renamed /${oldIdentifier} → /${newIdentifier}. To undo: call apply_namespace_rename with auditId: '${auditId}', collisionId: '${collisionId}', action: 'revert'.`
}
