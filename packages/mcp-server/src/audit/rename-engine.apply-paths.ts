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
 * Compute the destination path on disk for a rename. For command/agent
 * files, swap the basename (sans `.md`) with `newName.md`. For skill
 * directories, rename the directory itself.
 */
export function computeDestPath(suggestion: RenameSuggestion, newName: string): string {
  const src = suggestion.entry.source_path
  if (suggestion.applyAction === 'rename_skill_dir_and_frontmatter') {
    return path.join(path.dirname(src), newName)
  }
  return path.join(path.dirname(src), `${newName}.md`)
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
  const skillName = path.basename(suggestion.entry.source_path).replace(/\.md$/, '')
  const action = suggestion.applyAction
  if (action === 'rename_skill_dir_and_frontmatter') {
    return createSkillBackup(skillName, suggestion.entry.source_path, 'namespace-rename')
  }
  // Single-file path — stage, back up the staged dir, clean up.
  const staged = await stageSingleFileForBackup(suggestion.entry.source_path)
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
 * Build the inline revert summary (decision #10):
 *   `"Renamed /<OLD> → /<NEW>. To undo: sklx audit revert <auditId>"`
 *
 * For skill renames (no leading `/`), the summary still uses the `/`
 * prefix per the plan's literal text — agents render it as-is.
 */
export function buildSummary(
  oldIdentifier: string,
  newIdentifier: string,
  auditId: string,
  action: 'apply' | 'revert'
): string {
  if (action === 'revert') {
    return `Reverted /${oldIdentifier} → /${newIdentifier}. Audit: ${auditId}`
  }
  return `Renamed /${oldIdentifier} → /${newIdentifier}. To undo: sklx audit revert ${auditId}`
}
