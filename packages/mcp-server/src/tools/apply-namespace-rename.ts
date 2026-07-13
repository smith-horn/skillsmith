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
 *   - `action: 'revert'` — undo a previously applied `apply`/`custom`
 *     rename (SMI-5671). `suggestions.json` is a static snapshot from
 *     audit time, so the same `(auditId, collisionId)` lookup still
 *     resolves after the forward rename already happened. Ledger-backed
 *     via `applyRename({ request: { action: 'revert', collisionId } })` —
 *     this is the only durable, cross-session undo path (the CLI's
 *     `sklx audit revert` was never implemented, and the `undo_apply` tool
 *     only tracks same-process session state). `collisionId` disambiguates
 *     when a single audit run resolved 2+ collisions under one `auditId`.
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
 *
 * SMI-5671: `action: 'revert'` takes no `customName` — same as `apply`/
 * `skip` — so the existing refinement (`action !== 'custom' &&
 * customName !== undefined` → reject) already covers it with no change.
 */
export const applyNamespaceRenameInputSchema = z
  .object({
    auditId: z.string().min(1),
    collisionId: z.string().min(1),
    action: z.enum(['apply', 'custom', 'skip', 'revert']),
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
    "[Skillsmith — Maintain stage] Apply a rename suggestion from a prior `skill_inventory_audit`, or revert one already applied. MUTATES `~/.claude` (renames a skill/command/agent file) — but ONLY when `confirmed: true`. Without `confirmed`, returns a non-mutating preview ({ preview: true, before, after, applied: false, direction }) so the agent can show the change before committing. `action: 'apply'` uses the suggested name; `'custom'` uses `customName`; `'skip'` records a no-op; `'revert'` undoes a previously applied rename for the same auditId + collisionId — this is the durable, cross-session undo path (a fresh MCP server process, e.g. a new session, can still revert a rename applied by an earlier process, since the ledger persists to disk).",
  inputSchema: {
    type: 'object' as const,
    properties: {
      auditId: {
        type: 'string',
        description: 'auditId from a prior skill_inventory_audit response.',
      },
      collisionId: {
        type: 'string',
        description: 'collisionId of the RenameSuggestion to apply or revert.',
      },
      action: {
        type: 'string',
        description:
          "'apply' uses the suggested name; 'custom' uses customName; 'skip' is a no-op; 'revert' undoes a previously applied apply/custom rename for the same auditId + collisionId.",
        enum: ['apply', 'custom', 'skip', 'revert'],
      },
      customName: {
        type: 'string',
        description: "Required when action === 'custom'; forbidden otherwise (including revert).",
      },
      confirmed: {
        type: 'boolean',
        description:
          'When true, performs the file rename (or revert). When omitted/false, returns a non-mutating preview. Defaults to false.',
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

  // SMI-5671: `revert` is the inverse of apply/custom — same confirmation
  // gate, same suggestion lookup, but no `customName` and no dependency
  // on `suggestion.suggested` for the mutation itself (only for the
  // preview's swapped-direction text below).
  const isRevert = validInput.action === 'revert'

  // SMI-5213: confirmation gate. Without `confirmed: true`, return a
  // non-mutating preview describing the rename (or revert). The agent
  // surfaces this to the user and re-invokes with `confirmed: true` to
  // apply.
  const targetName = validInput.action === 'custom' ? validInput.customName! : suggestion.suggested
  if (validInput.confirmed !== true) {
    return {
      success: true,
      preview: true,
      collisionId: suggestion.collisionId,
      action: suggestion.applyAction,
      target: suggestion.entry.source_path,
      // Revert reverses the direction shown for apply/custom: "before" is
      // the currently-renamed name, "after" is the original identifier
      // being restored.
      before: isRevert ? targetName : suggestion.currentName,
      after: isRevert ? suggestion.currentName : targetName,
      applied: false,
      direction: isRevert ? 'revert' : 'apply',
    }
  }

  // Translate to Wave 2's apply request shape. `'custom'` carries
  // `customName` through; `'apply'` uses the suggested name verbatim;
  // `'revert'` looks up the ledger entry by `(auditId, collisionId)` and
  // undoes it (Change 0 — `collisionId` is required to disambiguate when
  // 2+ renames share one `auditId`).
  const renameRequest: ApplyRenameRequest = {
    suggestion,
    request: isRevert
      ? { action: 'revert', auditId: validInput.auditId, collisionId: validInput.collisionId }
      : validInput.action === 'custom'
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

  // SMI-5671: surface the engine's existing idempotency signal explicitly
  // rather than requiring callers to infer it from `result` themselves.
  // For `revert` this is the "no matching ledger entry" no-op case; for
  // `apply`/`custom` it mirrors the pre-existing idempotent-re-apply case.
  // Computed before the journal call: `isNoOp` (not `backupRef === ''`
  // alone) is what tells `journalApplySuccess` whether a genuine revert
  // mutation happened, since reverts always have `backupRef === ''`.
  const noOp = result.fromPath === result.toPath && result.backupPath === ''

  await journalApplySuccess({
    tool: 'apply_namespace_rename',
    suggestionId: result.collisionId,
    targetPath: journalTargetPath(result.toPath, result.appliedAction),
    backupRef: result.backupPath,
    approval: validInput.action,
    action: isRevert ? 'revert' : 'apply',
    isNoOp: noOp,
  })

  return {
    success: true,
    collisionId: result.collisionId,
    result,
    noOp,
  }
}

// SMI-5017 W2.S2: wrap at export boundary
export const applyNamespaceRename = withTelemetry(applyNamespaceRenameImpl, {
  source: 'mcp-tool',
  extractSkillId: () => 'apply_namespace_rename',
  extractFramework: () => 'unknown',
})
