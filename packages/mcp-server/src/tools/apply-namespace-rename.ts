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

import { z } from 'zod'

import { readAuditSuggestions } from '../audit/audit-suggestions.js'
import { applyRename } from '../audit/rename-engine.js'
import type { ApplyRenameRequest } from '../audit/rename-engine.types.js'

import type { ApplyNamespaceRenameResponse } from './apply-namespace-rename.types.js'

/**
 * Zod input schema with conditional refinement: `customName` is required
 * iff `action === 'custom'`; `customName` is forbidden otherwise (rejects
 * payloads that pass an unused field on apply / skip — keeps the surface
 * clean and helps catch caller-side bugs).
 */
export const applyNamespaceRenameInputSchema = z
  .object({
    auditId: z.string().min(1),
    collisionId: z.string().min(1),
    action: z.enum(['apply', 'custom', 'skip']),
    customName: z.string().min(1).optional(),
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
 * Execute the `apply_namespace_rename` tool.
 *
 * Returns the response envelope directly — the dispatcher wraps it for
 * the MCP `CallToolResult` shape. The application-level success/failure
 * lives inside the response payload.
 */
export async function applyNamespaceRename(input: unknown): Promise<ApplyNamespaceRenameResponse> {
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

  if (!result.success) {
    return {
      success: false,
      collisionId: result.collisionId,
      errorCode: 'namespace.rename.subcall_failed',
      error: `${result.error?.kind ?? 'namespace.rename.unknown'}: ${result.error?.message ?? 'unknown failure'}`,
      result,
    }
  }

  return {
    success: true,
    collisionId: result.collisionId,
    result,
  }
}
