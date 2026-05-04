/**
 * @fileoverview `apply_recommended_edit` MCP tool (SMI-4590 Wave 4 PR 4).
 * @module @skillsmith/mcp-server/tools/apply-recommended-edit
 *
 * Plan: docs/internal/implementation/smi-4590-cli-mcp-framework-adapter.md §3.
 *
 * Per-collision apply path for prose edits. Mirrors
 * `apply_namespace_rename` but dispatches to Wave 3's
 * `applyRecommendedEdit` instead of Wave 2's `applyRename`.
 *
 * Tool registration:
 *   - Registered iff `APPLY_TEMPLATE_REGISTRY.size > 0`
 *     (`audit-tool-dispatch.ts` adds the case + name to `AUDIT_TOOL_NAMES`
 *     conditionally at module load).
 *   - Live state: `APPLY_TEMPLATE_REGISTRY = new Set(['add_domain_qualifier'])`
 *     (Wave 3 PR #886, merged) — tool is registered.
 *
 * Failure modes:
 *   - `namespace.audit.invalid_input` — Zod rejection.
 *   - `namespace.audit.history_not_found` — `auditId` doesn't resolve.
 *   - `namespace.audit.collision_not_found` — `collisionId` not in
 *     persisted `RecommendedEdit[]`.
 *   - `edit.template_not_in_apply_registry` — Wave 3 registry guard
 *     rejected the persisted `pattern`.
 *   - `edit.subcall_failed` — any other Wave 3 failure (stale_before,
 *     backup_failed, fs_error). Inner kind preserved in `error` message.
 */

import { z } from 'zod'

import { readAuditSuggestions } from '../audit/audit-suggestions.js'
import { applyRecommendedEdit } from '../audit/edit-applier.js'

import type { ApplyRecommendedEditResponse } from './apply-recommended-edit.types.js'

/**
 * Zod input schema. `auditId` + `collisionId` are FKs into
 * `~/.skillsmith/audits/<auditId>/suggestions.json`.
 */
export const applyRecommendedEditInputSchema = z
  .object({
    auditId: z.string().min(1),
    collisionId: z.string().min(1),
  })
  .strict()

/**
 * Execute the `apply_recommended_edit` tool. Returns the response
 * envelope directly; the dispatcher wraps it for the MCP `CallToolResult`
 * shape.
 */
export async function applyRecommendedEditTool(
  input: unknown
): Promise<ApplyRecommendedEditResponse> {
  const parsed = applyRecommendedEditInputSchema.safeParse(input)
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
      error: `Invalid apply_recommended_edit input: ${message}`,
    }
  }
  const validInput = parsed.data

  const suggestions = await readAuditSuggestions(validInput.auditId)
  if (!suggestions) {
    return {
      success: false,
      collisionId: validInput.collisionId as ApplyRecommendedEditResponse['collisionId'],
      errorCode: 'namespace.audit.history_not_found',
      error: `Audit history not found for auditId ${validInput.auditId}. Run skill_inventory_audit first.`,
    }
  }

  const edit = suggestions.recommendedEdits.find((e) => e.collisionId === validInput.collisionId)
  if (!edit) {
    return {
      success: false,
      collisionId: validInput.collisionId as ApplyRecommendedEditResponse['collisionId'],
      errorCode: 'namespace.audit.collision_not_found',
      error: `Collision ${validInput.collisionId} not found in audit ${validInput.auditId}.`,
    }
  }

  const result = await applyRecommendedEdit(edit, {
    auditId: validInput.auditId,
    mode: 'apply_with_confirmation',
  })

  if (!result.success) {
    // Surface the registry guard explicitly — callers branch on it to
    // know that the persisted edit will never apply (vs a transient
    // failure they can retry).
    if (result.error?.kind === 'edit.template_not_in_apply_registry') {
      return {
        success: false,
        collisionId: result.collisionId,
        errorCode: 'edit.template_not_in_apply_registry',
        error: result.error.message,
        result,
      }
    }
    return {
      success: false,
      collisionId: result.collisionId,
      errorCode: 'edit.subcall_failed',
      error: `${result.error?.kind ?? 'edit.unknown'}: ${result.error?.message ?? 'unknown failure'}`,
      result,
    }
  }

  return {
    success: true,
    collisionId: result.collisionId,
    result,
  }
}
