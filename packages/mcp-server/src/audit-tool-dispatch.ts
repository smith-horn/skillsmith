/**
 * @fileoverview Audit-tool dispatch for the Skillsmith MCP server
 * @module @skillsmith/mcp-server/audit-tool-dispatch
 *
 * SMI-4590 Wave 4 Step 0b: extracted from `tool-dispatch.ts` to keep the
 * parent dispatcher under the 500-LOC file-size gate.
 *
 * Wave 4 PR 4 (this PR) adds three new tools:
 *   - `skill_inventory_audit`  — full inventory audit (always registered)
 *   - `apply_namespace_rename` — apply a Wave 2 rename (always registered)
 *   - `apply_recommended_edit` — apply a Wave 3 prose edit; **registered
 *     iff `APPLY_TEMPLATE_REGISTRY.size > 0`** (defense-in-depth — if the
 *     registry ever empties via rollback, the tool unregisters itself and
 *     the audit-report writer surfaces edits as `manual_review` only).
 *
 * Surface: handles dispatch for all audit-family tools. The parent
 * `tool-dispatch.ts` delegates by name match against {@link AUDIT_TOOL_NAMES};
 * this module owns the audit case bodies, license + quota wiring (for the
 * pre-existing `skill_audit` / `skill_pack_audit` cases), and Zod parse
 * error envelopes.
 *
 * Dispatch responses for the three new tools follow the
 * `safeParseOrError` pattern (see `validation.ts`) for protocol-level
 * shape errors, AND embed an application-level `success: false` envelope
 * inside `content[0].text` for domain-level failures (history not found,
 * subcall failed). MCP clients introspect both.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ToolContext } from './context.js'
import { skillAuditInputSchema, executeSkillAudit } from './tools/skill-audit.js'
import { skillPackAuditInputSchema, executeSkillPackAudit } from './tools/skill-pack-audit.js'
import { skillInventoryAudit } from './tools/skill-inventory-audit.js'
import { applyNamespaceRename } from './tools/apply-namespace-rename.js'
import { applyRecommendedEditTool } from './tools/apply-recommended-edit.js'
import { APPLY_TEMPLATE_REGISTRY } from './audit/edit-applier.js'
import { withLicenseAndQuota } from './middleware/license.js'
import type { LicenseMiddleware } from './middleware/license.js'
import type { QuotaMiddleware } from './middleware/quota.js'

/**
 * Tool names handled by this dispatcher. The parent `tool-dispatch.ts`
 * delegates iff the requested tool name is in this set.
 *
 * `apply_recommended_edit` is conditionally included based on
 * `APPLY_TEMPLATE_REGISTRY.size`. When the registry is empty (rollback
 * scenario), the name is omitted from this set AND
 * {@link dispatchAuditTool} returns the standard "Unknown audit tool"
 * error if the dispatcher is somehow reached for that name.
 */
export const AUDIT_TOOL_NAMES: ReadonlySet<string> = new Set<string>(buildAuditToolNames())

// SMI-4590 Wave 4 PR 5/6: the post-deploy smoke harness
// (`scripts/smoke-prod/mcp-server.sh`) greps the COMPILED JS of this file
// for the literal tool-name strings below. If you ever extract them into
// constants, named exports, or a JSON manifest, update those smoke checks
// in the same PR — otherwise the smoke continues to pass on a regression
// it was specifically built to catch.
function buildAuditToolNames(): string[] {
  const names = [
    'skill_audit',
    'skill_pack_audit',
    'skill_inventory_audit',
    'apply_namespace_rename',
  ]
  if (APPLY_TEMPLATE_REGISTRY.size > 0) {
    names.push('apply_recommended_edit')
  }
  return names
}

/**
 * Returns true if `name` is an audit-family tool dispatched by this module.
 * Parent dispatcher uses this to route — keeping the routing predicate
 * colocated with the case bodies prevents drift.
 */
export function isAuditToolName(name: string): boolean {
  return AUDIT_TOOL_NAMES.has(name)
}

/**
 * Wrap a Promise<T> as a successful MCP `CallToolResult` with a
 * JSON-serialised body (mirrors `tool-dispatch.ok`).
 */
function okBody(payload: unknown): CallToolResult {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    isError: false,
  }
}

/**
 * Dispatch an audit-family tool call. Caller must check {@link isAuditToolName}
 * before invoking; unrecognized names throw `Error('Unknown audit tool: <name>')`.
 *
 * @param name              MCP tool name (must be in {@link AUDIT_TOOL_NAMES}).
 * @param args              Raw tool arguments from the request.
 * @param toolContext       Initialized database + repository context.
 * @param licenseMiddleware License validation middleware instance.
 * @param quotaMiddleware   Quota enforcement middleware instance.
 * @returns MCP tool response.
 */
export async function dispatchAuditTool(
  name: string,
  args: Record<string, unknown> | undefined,
  toolContext: ToolContext,
  licenseMiddleware: LicenseMiddleware,
  quotaMiddleware: QuotaMiddleware
): Promise<CallToolResult> {
  switch (name) {
    case 'skill_audit':
      return withLicenseAndQuota(
        'skill_audit',
        args,
        skillAuditInputSchema,
        executeSkillAudit,
        toolContext,
        licenseMiddleware,
        quotaMiddleware
      )

    case 'skill_pack_audit':
      return withLicenseAndQuota(
        'skill_pack_audit',
        args,
        skillPackAuditInputSchema,
        executeSkillPackAudit,
        toolContext,
        licenseMiddleware,
        quotaMiddleware
      )

    case 'skill_inventory_audit':
      return okBody(await skillInventoryAudit(args))

    case 'apply_namespace_rename':
      return okBody(await applyNamespaceRename(args))

    case 'apply_recommended_edit':
      // Defense-in-depth: even if the parent dispatcher routes this name
      // when the registry is empty (e.g. tests that mock the set), the
      // tool body still calls Wave 3's applyRecommendedEdit which
      // re-checks `APPLY_TEMPLATE_REGISTRY` and returns the typed
      // `edit.template_not_in_apply_registry` error.
      return okBody(await applyRecommendedEditTool(args))

    default:
      throw new Error('Unknown audit tool: ' + name)
  }
}
