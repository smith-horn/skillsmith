/**
 * @fileoverview `undo_apply` MCP tool (SMI-5456 Wave 1 Step 3 / SMI-5470).
 * @module @skillsmith/mcp-server/tools/undo-apply
 *
 * Session-scoped undo for the apply-family tools (PRD §7 trust loop /
 * §10 exclusion 9 — the one new tool the "no agent-only MCP tools" rule
 * deliberately excepts). "Session-scoped" means: only applies made by THIS
 * running MCP server process are undoable — see `apply-session.helpers.ts`
 * for the in-process stack this tool reads from and mutates.
 *
 * Restore procedure per changeset, most-recent-first:
 *   1. Scope fence — the target must resolve (post-symlink) under the
 *      user's home directory, reusing the SMI-4287 root-confinement helper
 *      (`resolveSafeRealpath`). Test isolation is an explicit opt-in seam
 *      (`UNDO_SCOPE_TEST_ROOT_ENV_VAR`, unset in every real deployment) —
 *      NOT a blanket `os.tmpdir()` carve-out on the production fence. See
 *      that constant's doc comment for the SMI-4691 precedent this mirrors.
 *   2. Never-clobber guard — the target's CURRENT content hash must match
 *      the journaled `after_hash`. A mismatch means the file changed since
 *      the apply (a user edit, or something else entirely) and undo refuses
 *      rather than overwriting it.
 *   3. Backup-integrity guard — the backup file's content hash must match
 *      the journaled `before_hash` BEFORE anything is written, so a
 *      corrupt/mismatched backup is caught before it can clobber the
 *      target (not just after).
 *   4. Atomic write — `<target>.<random>.undo-tmp` + `fs.rename`.
 *   5. Journal an `'undo'` record and drop the changeset from the session
 *      stack (only on success — a refused undo leaves the stack untouched
 *      so a retry after e.g. restoring the backup file can still work).
 */

import { randomBytes } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { z } from 'zod'

import { resolveSafeRealpath } from '@skillsmith/core'
import { sha256Hex } from '@skillsmith/core/journal'
import { withTelemetry } from '@skillsmith/core/telemetry'

import { journalUndo } from './apply-journal.helpers.js'
import {
  removeSessionApply,
  selectUndoTargets,
  type SessionAppliedChangeset,
} from './apply-session.helpers.js'
import type { UndoApplyResponse, UndoneChangeset } from './undo-apply.types.js'

export const undoApplyInputSchema = z
  .object({
    count: z.number().int().positive().optional(),
    suggestion_id: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.count !== undefined && value.suggestion_id !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['suggestion_id'],
        message: 'count and suggestion_id are mutually exclusive',
      })
    }
  })

/**
 * MCP tool schema for `undo_apply`. Hand-written JSON Schema mirroring
 * {@link undoApplyInputSchema} so the tool is client-discoverable via
 * ListTools. Keep in sync with the Zod schema.
 */
export const undoApplyToolSchema = {
  name: 'undo_apply',
  description:
    "[Skillsmith — Maintain stage] Undo the most recent apply_namespace_rename / apply_recommended_edit changeset(s) made in THIS server session. Session-scoped: restarting the MCP server clears the undo history. Restores from the apply tool's own pre-mutation backup and refuses (never throws) if the target was modified since the apply, the backup is missing, or the restore target falls outside the confined skill roots. Pass `count` to undo the N most-recent changesets (default 1), or `suggestion_id` to undo one specific changeset — mutually exclusive.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      count: {
        type: 'number',
        description:
          'Number of most-recent session applies to undo, most-recent-first. Defaults to 1. Mutually exclusive with suggestion_id.',
      },
      suggestion_id: {
        type: 'string',
        description:
          'Undo one specific changeset by its collisionId. Mutually exclusive with count.',
      },
    },
    required: [],
  },
}

type RestoreOutcome =
  | { ok: true; restoredHash: string }
  | {
      ok: false
      code:
        | 'undo.scope_violation'
        | 'undo.content_changed'
        | 'undo.backup_missing'
        | 'undo.restore_failed'
      message: string
    }

/**
 * Test-only additional confinement root, honored ONLY when explicitly set.
 * Mirrors `SKILLSMITH_CACHE_DIR_OVERRIDE` (SMI-4691, `@skillsmith/core`'s
 * `config/index.ts`) and this same commit's `SKILLSMITH_JOURNAL_DIR`
 * (`@skillsmith/core/journal/path.ts`): an explicit opt-in env-var test
 * seam, not a blanket `os.tmpdir()` carve-out baked into the production
 * scope fence. `os.tmpdir()` (e.g. `/tmp`) is a shared, often
 * world-writable directory on multi-user systems — accepting it
 * unconditionally as a valid undo-restore root would have widened the
 * SMI-4287 fence for every real deployment, not just tests, for a
 * marginal test-isolation gain that `process.env.HOME` mutation already
 * covers on every platform this tool actually ships on (Docker/Linux —
 * see `getConfigDir()`'s doc comment for the macOS `os.homedir()` caveat
 * this constant exists to route around on the rare host-side run).
 * Unset (and therefore inert) in every real deployment.
 */
export const UNDO_SCOPE_TEST_ROOT_ENV_VAR = 'SKILLSMITH_UNDO_SCOPE_TEST_ROOT'

/** SMI-4287 scope fence: confine the restore target to the user's home
 * directory tree. See `UNDO_SCOPE_TEST_ROOT_ENV_VAR` for the test-only
 * escape hatch. */
async function checkUndoScopeFence(
  targetPath: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  const home = await resolveSafeRealpath(targetPath, homedir())
  if (home.ok) return { ok: true }

  const testRoot = process.env[UNDO_SCOPE_TEST_ROOT_ENV_VAR]
  if (testRoot !== undefined && testRoot.length > 0) {
    const test = await resolveSafeRealpath(targetPath, testRoot)
    if (test.ok) return { ok: true }
  }

  return { ok: false, message: home.error.message }
}

async function restoreChangeset(entry: SessionAppliedChangeset): Promise<RestoreOutcome> {
  const fence = await checkUndoScopeFence(entry.targetPath)
  if (!fence.ok) {
    return {
      ok: false,
      code: 'undo.scope_violation',
      message: `Refusing to restore ${entry.targetPath}: ${fence.message}`,
    }
  }

  let currentContent: Buffer
  try {
    currentContent = await readFile(entry.targetPath)
  } catch (err) {
    return {
      ok: false,
      code: 'undo.content_changed',
      message: `Target file no longer exists at ${entry.targetPath}: ${(err as Error).message}`,
    }
  }
  const currentHash = sha256Hex(currentContent)
  if (currentHash !== entry.afterHash) {
    return {
      ok: false,
      code: 'undo.content_changed',
      message: `${entry.targetPath} was modified since the apply; refusing to undo (would clobber the change).`,
    }
  }

  const backupFilePath = join(entry.backupRef, entry.backupFileName)
  let backupContent: Buffer
  try {
    backupContent = await readFile(backupFilePath)
  } catch (err) {
    return {
      ok: false,
      code: 'undo.backup_missing',
      message: `Backup file missing at ${backupFilePath}: ${(err as Error).message}`,
    }
  }

  // Verify BEFORE writing — a mismatched/corrupt backup must never reach
  // the target file.
  const restoredHash = sha256Hex(backupContent)
  if (restoredHash !== entry.beforeHash) {
    return {
      ok: false,
      code: 'undo.restore_failed',
      message: `Backup content at ${backupFilePath} does not match the recorded pre-apply hash; refusing to restore a mismatched backup.`,
    }
  }

  const tmpPath = `${entry.targetPath}.${randomBytes(6).toString('hex')}.undo-tmp`
  try {
    await writeFile(tmpPath, backupContent)
    await rename(tmpPath, entry.targetPath)
  } catch (err) {
    try {
      await rm(tmpPath, { force: true })
    } catch {
      // best-effort cleanup
    }
    return {
      ok: false,
      code: 'undo.restore_failed',
      message: `Restore write failed for ${entry.targetPath}: ${(err as Error).message}`,
    }
  }

  await journalUndo({
    tool: entry.tool,
    suggestionId: entry.suggestionId,
    targetPath: entry.targetPath,
    beforeHash: currentHash,
    afterHash: restoredHash,
  })

  return { ok: true, restoredHash }
}

async function undoApplyImpl(input: unknown): Promise<UndoApplyResponse> {
  const parsed = undoApplyInputSchema.safeParse(input)
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => {
        const issuePath = issue.path.length > 0 ? issue.path.join('.') : '<root>'
        return `${issuePath}: ${issue.message}`
      })
      .join('; ')
    return {
      success: false,
      undone: [],
      errorCode: 'undo.invalid_input',
      error: `Invalid undo_apply input: ${message}`,
    }
  }
  const validInput = parsed.data

  const targets = selectUndoTargets({
    count: validInput.count,
    suggestionId: validInput.suggestion_id,
  })
  if (targets.length === 0) {
    return {
      success: false,
      undone: [],
      errorCode: 'undo.no_session_applies',
      error:
        validInput.suggestion_id !== undefined
          ? `No session-tracked apply found for suggestion_id ${validInput.suggestion_id}.`
          : 'No applies were made in this server session; nothing to undo.',
    }
  }

  const undone: UndoneChangeset[] = []
  for (const entry of targets) {
    const outcome = await restoreChangeset(entry)
    if (!outcome.ok) {
      return { success: false, undone, errorCode: outcome.code, error: outcome.message }
    }
    removeSessionApply(entry)
    undone.push({
      tool: entry.tool,
      suggestionId: entry.suggestionId,
      targetPath: entry.targetPath,
      restoredHash: outcome.restoredHash,
    })
  }

  return { success: true, undone }
}

// SMI-5017 W2.S2: wrap at export boundary
export const undoApply = withTelemetry(undoApplyImpl, {
  source: 'mcp-tool',
  extractSkillId: () => 'undo_apply',
  extractFramework: () => 'unknown',
})
