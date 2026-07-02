/**
 * @fileoverview `apply_namespace_rename` MCP tool (SMI-4590 Wave 4 PR 4).
 * @module @skillsmith/mcp-server/tools/apply-namespace-rename
 *
 * Plan: docs/internal/implementation/smi-4590-cli-mcp-framework-adapter.md §2.
 *
 * Per-collision apply path. The agent calls `skill_inventory_audit` first
 * to populate `~/.skillsmith/audits/<auditId>/`, then calls this tool
 * once per accepted rename. Stateless: each call re-reads the persisted
 * suggestions file (via `readAuditSuggestions`) and dispatches to Wave 2's
 * `applyRename`.
 *
 * Input semantics:
 *   - `action: 'apply'`  — apply the suggested rename verbatim.
 *   - `action: 'custom'` — apply with `customName` (Zod refinement
 *     enforces non-empty `customName` on this branch).
 *   - `action: 'skip'`   — no-op; returns `{ success: true }` with no
 *     `result`. The agent records the decision; nothing on disk changes.
 *
 * Failure modes (typed via `errorCode`):
 *   - `namespace.audit.invalid_input` — Zod rejection.
 *   - `namespace.audit.history_not_found` — `auditId` doesn't resolve.
 *   - `namespace.audit.collision_not_found` — `collisionId` not in
 *     persisted `RenameSuggestion[]`.
 *   - `namespace.rename.subcall_failed` — Wave 2's `applyRename` errored
 *     (target_exists, backup_failed, frontmatter_rewrite_failed, etc.).
 *     The inner Wave 2 error kind is preserved in the `error` message.
 */

import * as path from 'node:path'

import { z } from 'zod'

import { readAuditSuggestions } from '../audit/audit-suggestions.js'
import { applyRename } from '../audit/rename-engine.js'
import type { ApplyRenameRequest } from '../audit/rename-engine.types.js'
import { withTelemetry } from '@skillsmith/core/telemetry'

import { journalApplyError, journalApplySuccess } from './apply-journal.helpers.js'
import type { ApplyNamespaceRenameResponse } from './apply-namespace-rename.types.js'

/**
 * SMI-5456 §7: the content-hashable file the journal + `undo_apply` track
 * for a completed rename. A whole directory has no single content hash, so
 * a skill-directory rename is tracked via its `SKILL.md` (the one file the
 * mutation actually rewrites) — see `apply-journal.helpers.ts`'s module
 * header for why directory-path reversal is deliberately out of scope here.
 */
function journalTargetPath(toPath: string, appliedAction: string): string {
  return appliedAction === 'rename_skill_dir_and_frontmatter'
    ? path.join(toPath, 'SKILL.md')
    : toPath
}

/**
 * Zod input schema with conditional refinement: `customName` is required
 * iff `action === 'custom'`; `customName` is forbidden otherwise (rejects
 * payloads that pass an unused field on apply / skip — keeps the surface
 * clean and helps catch caller-side bugs).
 *
 * SMI-5213: `confirmed` (default false) gates the file mutation. When
 * `confirmed !== true` (and `action !== 'skip'`), the tool returns a
 * non-mutating preview envelope describing the rename; the caller must
 * re-invoke with `confirmed: true` to actually rename the file.
 */
export const applyNamespaceRenameInputSchema = z
  .object({
    auditId: z.string().min(1),
    collisionId: z.string().min(1),
    action: z.enum(['apply', 'custom', 'skip']),
    customName: z.string().min(1).optional(),
    confirmed: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action === 'custom' && !value.customName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['customName'],
        message: 'customName is required when action === "custom"',
      })
    }
    if (value.action !== 'custom' && value.customName !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['customName'],
        message: 'customName is only valid when action === "custom"',
      })
    }
  })

/**
 * MCP tool schema for `apply_namespace_rename` (SMI-5213). Hand-written
 * JSON Schema mirroring {@link applyNamespaceRenameInputSchema} so the
 * tool is client-discoverable via ListTools. Keep in sync with the Zod
 * schema.
 */
export const applyNamespaceRenameToolSchema = {
  name: 'apply_namespace_rename',
  description:
    "[Skillsmith — Maintain stage] Apply a rename suggestion from a prior `skill_inventory_audit`. MUTATES `~/.claude` (renames a skill/command/agent file) — but ONLY when `confirmed: true`. Without `confirmed`, returns a non-mutating preview ({ preview: true, before, after, applied: false }) so the agent can show the change before committing. `action: 'apply'` uses the suggested name; `'custom'` uses `customName`; `'skip'` records a no-op.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      auditId: {
        type: 'string',
        description: 'auditId from a prior skill_inventory_audit response.',
      },
      collisionId: {
        type: 'string',
        description: 'collisionId of the RenameSuggestion to apply.',
      },
      action: {
        type: 'string',
        description:
          "'apply' uses the suggested name; 'custom' uses customName; 'skip' is a no-op.",
        enum: ['apply', 'custom', 'skip'],
      },
      customName: {
        type: 'string',
        description: "Required when action === 'custom'; forbidden otherwise.",
      },
      confirmed: {
        type: 'boolean',
        description:
          'When true, performs the file rename. When omitted/false, returns a non-mutating preview. Defaults to false.',
      },
    },
    required: ['auditId', 'collisionId', 'action'],
  },
}

/**
 * Execute the `apply_namespace_rename` tool.
 *
 * Returns the response envelope directly — the dispatcher wraps it for
 * the MCP `CallToolResult` shape. The application-level success/failure
 * lives inside the response payload.
 */
async function applyNamespaceRenameImpl(input: unknown): Promise<ApplyNamespaceRenameResponse> {
  const parsed = applyNamespaceRenameInputSchema.safeParse(input)
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => {
        const issuePath = issue.path.length > 0 ? issue.path.join('.') : '<root>'
        return `${issuePath}: ${issue.message}`
      })
      .join('; ')
    return {
      success: false,
      collisionId: '',
      errorCode: 'namespace.audit.invalid_input',
      error: `Invalid apply_namespace_rename input: ${message}`,
    }
  }
  const validInput = parsed.data

  // Skip is a recorded no-op — return success without side effects.
  if (validInput.action === 'skip') {
    return {
      success: true,
      collisionId: validInput.collisionId as ApplyNamespaceRenameResponse['collisionId'],
    }
  }

  // Look up the persisted suggestions. Plan §177: history-not-found
  // returns a typed error pointing at `skill_inventory_audit`.
  const suggestions = await readAuditSuggestions(validInput.auditId)
  if (!suggestions) {
    return {
      success: false,
      collisionId: validInput.collisionId as ApplyNamespaceRenameResponse['collisionId'],
      errorCode: 'namespace.audit.history_not_found',
      error: `Audit history not found for auditId ${validInput.auditId}. Run skill_inventory_audit first.`,
    }
  }

  const suggestion = suggestions.renameSuggestions.find(
    (s) => s.collisionId === validInput.collisionId
  )
  if (!suggestion) {
    return {
      success: false,
      collisionId: validInput.collisionId as ApplyNamespaceRenameResponse['collisionId'],
      errorCode: 'namespace.audit.collision_not_found',
      error: `Collision ${validInput.collisionId} not found in audit ${validInput.auditId}.`,
    }
  }

  // SMI-5213: confirmation gate. Without `confirmed: true`, return a
  // non-mutating preview describing the rename. The agent surfaces this
  // to the user and re-invokes with `confirmed: true` to apply.
  const targetName = validInput.action === 'custom' ? validInput.customName! : suggestion.suggested
  if (validInput.confirmed !== true) {
    return {
      success: true,
      preview: true,
      collisionId: suggestion.collisionId,
      action: suggestion.applyAction,
      target: suggestion.entry.source_path,
      before: suggestion.currentName,
      after: targetName,
      applied: false,
    }
  }

  // Translate to Wave 2's apply request shape. `'custom'` carries
  // `customName` through; `'apply'` uses the suggested name verbatim.
  const renameRequest: ApplyRenameRequest = {
    suggestion,
    request:
      validInput.action === 'custom'
        ? { action: 'apply', auditId: validInput.auditId, customName: validInput.customName! }
        : { action: 'apply', auditId: validInput.auditId },
  }
  const result = await applyRename(renameRequest)

  // SMI-5456 §7: journal every real mutation attempt (apply already ran
  // above the confirmation gate) on both the success and failure paths.
  // Fail-soft — `journalApplySuccess` / `journalApplyError` never throw.
  if (!result.success) {
    await journalApplyError({
      tool: 'apply_namespace_rename',
      suggestionId: result.collisionId,
      targetPath: result.toPath || result.fromPath || null,
      approval: validInput.action,
      errorKind: result.error?.kind ?? 'namespace.rename.unknown',
    })
    return {
      success: false,
      collisionId: result.collisionId,
      errorCode: 'namespace.rename.subcall_failed',
      error: `${result.error?.kind ?? 'namespace.rename.unknown'}: ${result.error?.message ?? 'unknown failure'}`,
      result,
    }
  }

  await journalApplySuccess({
    tool: 'apply_namespace_rename',
    suggestionId: result.collisionId,
    targetPath: journalTargetPath(result.toPath, result.appliedAction),
    backupRef: result.backupPath,
    approval: validInput.action,
  })

  return {
    success: true,
    collisionId: result.collisionId,
    result,
  }
}

// SMI-5017 W2.S2: wrap at export boundary
export const applyNamespaceRename = withTelemetry(applyNamespaceRenameImpl, {
  source: 'mcp-tool',
  extractSkillId: () => 'apply_namespace_rename',
  extractFramework: () => 'unknown',
})
