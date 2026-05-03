/**
 * @fileoverview Audit-tool dispatch for the Skillsmith MCP server
 * @module @skillsmith/mcp-server/audit-tool-dispatch
 *
 * SMI-4590 Wave 4 Step 0b: extracted from `tool-dispatch.ts` to keep the
 * parent dispatcher under the 500-LOC file-size gate. Wave 4 PRs 3–4 will
 * add `skill_inventory_audit`, `apply_namespace_rename`, and
 * `apply_recommended_edit` cases to this module.
 *
 * Surface: handles dispatch for all audit-family tools. The parent
 * `tool-dispatch.ts` delegates by name match; this module owns the audit
 * case bodies, license + quota wiring, and Zod parse error envelopes.
 *
 * No new functionality vs pre-extraction state — bodies for `skill_audit`
 * and `skill_pack_audit` are identical to their previous parent-dispatch
 * incarnations. Backwards-compat regression test:
 * `tests/unit/audit-tool-dispatch.test.ts`.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ToolContext } from './context.js'
import { skillAuditInputSchema, executeSkillAudit } from './tools/skill-audit.js'
import { skillPackAuditInputSchema, executeSkillPackAudit } from './tools/skill-pack-audit.js'
import { withLicenseAndQuota } from './middleware/license.js'
import type { LicenseMiddleware } from './middleware/license.js'
import type { QuotaMiddleware } from './middleware/quota.js'

/**
 * Tool names handled by this dispatcher. The parent `tool-dispatch.ts`
 * delegates iff the requested tool name is in this set.
 *
 * Wave 4 PR 3/6 adds: `skill_inventory_audit`.
 * Wave 4 PR 4/6 adds: `apply_namespace_rename`, `apply_recommended_edit`
 * (the latter conditional on `APPLY_TEMPLATE_REGISTRY.size > 0`).
 */
export const AUDIT_TOOL_NAMES: ReadonlySet<string> = new Set(['skill_audit', 'skill_pack_audit'])

/**
 * Returns true if `name` is an audit-family tool dispatched by this module.
 * Parent dispatcher uses this to route — keeping the routing predicate
 * colocated with the case bodies prevents drift.
 */
export function isAuditToolName(name: string): boolean {
  return AUDIT_TOOL_NAMES.has(name)
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

    default:
      throw new Error('Unknown audit tool: ' + name)
  }
}
