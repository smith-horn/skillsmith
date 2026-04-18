/**
 * @fileoverview Tool dispatch function for the Skillsmith MCP server
 * @module @skillsmith/mcp-server/tool-dispatch
 *
 * Extracted from index.ts (SMI-skill-version-tracking Wave 2) to keep
 * index.ts under the 500-line file-size gate.
 *
 * Handles the switch-case dispatch for all registered MCP tools,
 * including license and quota enforcement for gated tools.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ToolContext } from './context.js'
import { executeSearch, type SearchInput } from './tools/search.js'
import { executeGetSkill, type GetSkillInput } from './tools/get-skill.js'
import { installSkill } from './tools/install.js'
import { uninstallSkill, uninstallInputSchema } from './tools/uninstall.js'
import { recommendInputSchema, executeRecommend } from './tools/recommend.js'
import { validateInputSchema, executeValidate } from './tools/validate.js'
import { compareInputSchema, executeCompare } from './tools/compare.js'
import { suggestInputSchema, executeSuggest } from './tools/suggest.js'
import { indexLocalInputSchema, executeIndexLocal } from './tools/index-local.js'
import { publishInputSchema, executePublish } from './tools/publish.js'
import { skillUpdatesInputSchema, executeSkillUpdates } from './tools/skill-updates.js'
import { skillDiffInputSchema, executeSkillDiff } from './tools/skill-diff.js'
import { skillAuditInputSchema, executeSkillAudit } from './tools/skill-audit.js'
import { skillPackAuditInputSchema, executeSkillPackAudit } from './tools/skill-pack-audit.js'
import { outdatedInputSchema, executeOutdated } from './tools/outdated.js'
import { skillRescanInputSchema, executeSkillRescan } from './tools/skill-rescan.js'
import {
  auditExportInputSchema,
  executeAuditExport,
  auditQueryInputSchema,
  executeAuditQuery,
  siemExportInputSchema,
  executeSiemExport,
} from './tools/audit-tools.js'
import {
  teamWorkspaceInputSchema,
  executeTeamWorkspace,
  shareSkillInputSchema,
  executeShareSkill,
} from './tools/team-workspace.js'
import { publishPrivateInputSchema, executePublishPrivate } from './tools/publish-private.js'
import {
  teamAnalyticsDashboardInputSchema,
  executeTeamAnalyticsDashboard,
  teamUsageReportInputSchema,
  executeTeamUsageReport,
  analyticsDashboardInputSchema,
  executeAnalyticsDashboard,
  usageReportInputSchema,
  executeUsageReport,
} from './tools/analytics.js'
import {
  configureSsoInputSchema,
  executeConfigureSso,
  ssoSettingsInputSchema,
  executeSsoSettings,
} from './tools/sso-tools.js'
import {
  privateRegistryPublishInputSchema,
  executePrivateRegistryPublish,
  privateRegistryManageInputSchema,
  executePrivateRegistryManage,
} from './tools/registry-tools.js'
import {
  rbacManageInputSchema,
  executeRbacManage,
  rbacAssignRoleInputSchema,
  executeRbacAssignRole,
  rbacCreatePolicyInputSchema,
  executeRbacCreatePolicy,
} from './tools/rbac-tools.js'
import {
  webhookConfigureInputSchema,
  executeWebhookConfigure,
  apiKeyManageInputSchema,
  executeApiKeyManage,
} from './tools/integration-tools.js'
import { complianceReportInputSchema, executeComplianceReport } from './tools/compliance-tools.js'
import {
  ok,
  errResponse,
  withLicenseAndQuota,
  TOOL_FEATURES,
  FEATURE_TIERS,
} from './middleware/license.js'
import type { LicenseMiddleware } from './middleware/license.js'
import type { QuotaMiddleware } from './middleware/quota.js'

/**
 * Dispatch a tool call to its handler, applying license and quota checks
 * for gated tools.
 *
 * @param name              MCP tool name
 * @param args              Raw tool arguments from the request
 * @param toolContext       Initialized database + repository context
 * @param licenseMiddleware License validation middleware instance
 * @param quotaMiddleware   Quota enforcement middleware instance
 * @returns MCP tool response
 */
export async function dispatchToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
  toolContext: ToolContext,
  licenseMiddleware: LicenseMiddleware,
  quotaMiddleware: QuotaMiddleware
): Promise<CallToolResult> {
  switch (name) {
    case 'search': {
      const input = (args ?? {}) as unknown as SearchInput
      return ok(await executeSearch(input, toolContext))
    }

    case 'get_skill': {
      const input = (args ?? {}) as unknown as GetSkillInput
      return ok(await executeGetSkill(input, toolContext))
    }

    case 'install_skill':
      // SMI-4288 / #599: forward raw args; installSkill() performs Zod
      // validation at its boundary and returns a structured error envelope
      // on failure instead of throwing. See install.ts buildValidationError.
      return ok(await installSkill(args, toolContext))

    case 'uninstall_skill':
      return ok(await uninstallSkill(uninstallInputSchema.parse(args), toolContext))

    case 'skill_recommend':
      return ok(await executeRecommend(recommendInputSchema.parse(args), toolContext))

    case 'skill_validate':
      return ok(await executeValidate(validateInputSchema.parse(args), toolContext))

    case 'skill_compare':
      return ok(await executeCompare(compareInputSchema.parse(args), toolContext))

    case 'skill_suggest': {
      const input = suggestInputSchema.parse(args)
      let licenseInfo = null
      try {
        licenseInfo = await licenseMiddleware.getLicenseInfo()
      } catch {
        // Enterprise package absent or network error — degrade to community tier.
      }
      const quotaResult = await quotaMiddleware.checkAndTrack('skill_suggest', licenseInfo)
      if (!quotaResult.allowed)
        return errResponse(quotaMiddleware.buildExceededResponse(quotaResult))
      return ok(await executeSuggest(input, toolContext))
    }

    case 'index_local':
      return ok(await executeIndexLocal(indexLocalInputSchema.parse(args), toolContext))

    case 'skill_outdated':
      return ok(await executeOutdated(outdatedInputSchema.parse(args), toolContext))

    case 'skill_publish':
      return ok(await executePublish(publishInputSchema.parse(args), toolContext))

    case 'skill_updates':
      return withLicenseAndQuota(
        'skill_updates',
        args,
        skillUpdatesInputSchema,
        executeSkillUpdates,
        toolContext,
        licenseMiddleware,
        quotaMiddleware
      )

    case 'skill_diff':
      return withLicenseAndQuota(
        'skill_diff',
        args,
        skillDiffInputSchema,
        executeSkillDiff,
        toolContext,
        licenseMiddleware,
        quotaMiddleware
      )

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

    case 'skill_rescan':
      return ok(await executeSkillRescan(skillRescanInputSchema.parse(args)))

    case 'audit_export':
      return withLicenseAndQuota(
        'audit_export',
        args,
        auditExportInputSchema,
        executeAuditExport,
        toolContext,
        licenseMiddleware,
        quotaMiddleware
      )

    case 'audit_query':
      return withLicenseAndQuota(
        'audit_query',
        args,
        auditQueryInputSchema,
        executeAuditQuery,
        toolContext,
        licenseMiddleware,
        quotaMiddleware
      )

    case 'siem_export':
      return withLicenseAndQuota(
        'siem_export',
        args,
        siemExportInputSchema,
        executeSiemExport,
        toolContext,
        licenseMiddleware,
        quotaMiddleware
      )

    case 'team_workspace':
      return withLicenseAndQuota(
        'team_workspace',
        args,
        teamWorkspaceInputSchema,
        executeTeamWorkspace,
        toolContext,
        licenseMiddleware,
        quotaMiddleware
      )

    case 'share_skill':
      return withLicenseAndQuota(
        'share_skill',
        args,
        shareSkillInputSchema,
        executeShareSkill,
        toolContext,
        licenseMiddleware,
        quotaMiddleware
      )

    case 'publish_private':
      return withLicenseAndQuota(
        'publish_private',
        args,
        publishPrivateInputSchema,
        executePublishPrivate,
        toolContext,
        licenseMiddleware,
        quotaMiddleware
      )

    case 'team_analytics_dashboard':
      return withLicenseAndQuota(
        'team_analytics_dashboard',
        args,
        teamAnalyticsDashboardInputSchema,
        executeTeamAnalyticsDashboard,
        toolContext,
        licenseMiddleware,
        quotaMiddleware
      )

    case 'team_usage_report':
      return withLicenseAndQuota(
        'team_usage_report',
        args,
        teamUsageReportInputSchema,
        executeTeamUsageReport,
        toolContext,
        licenseMiddleware,
        quotaMiddleware
      )

    case 'analytics_dashboard':
      return withLicenseAndQuota(
        'analytics_dashboard',
        args,
        analyticsDashboardInputSchema,
        executeAnalyticsDashboard,
        toolContext,
        licenseMiddleware,
        quotaMiddleware
      )

    case 'usage_report':
      return withLicenseAndQuota(
        'usage_report',
        args,
        usageReportInputSchema,
        executeUsageReport,
        toolContext,
        licenseMiddleware,
        quotaMiddleware
      )

    case 'configure_sso':
      return withLicenseAndQuota(
        'configure_sso',
        args,
        configureSsoInputSchema,
        executeConfigureSso,
        toolContext,
        licenseMiddleware,
        quotaMiddleware
      )

    case 'sso_settings':
      return withLicenseAndQuota(
        'sso_settings',
        args,
        ssoSettingsInputSchema,
        executeSsoSettings,
        toolContext,
        licenseMiddleware,
        quotaMiddleware
      )

    case 'private_registry_publish':
      return withLicenseAndQuota(
        'private_registry_publish',
        args,
        privateRegistryPublishInputSchema,
        executePrivateRegistryPublish,
        toolContext,
        licenseMiddleware,
        quotaMiddleware
      )

    case 'private_registry_manage':
      return withLicenseAndQuota(
        'private_registry_manage',
        args,
        privateRegistryManageInputSchema,
        executePrivateRegistryManage,
        toolContext,
        licenseMiddleware,
        quotaMiddleware
      )

    case 'rbac_manage':
      return withLicenseAndQuota(
        'rbac_manage',
        args,
        rbacManageInputSchema,
        executeRbacManage,
        toolContext,
        licenseMiddleware,
        quotaMiddleware
      )

    case 'rbac_assign_role':
      return withLicenseAndQuota(
        'rbac_assign_role',
        args,
        rbacAssignRoleInputSchema,
        executeRbacAssignRole,
        toolContext,
        licenseMiddleware,
        quotaMiddleware
      )

    case 'rbac_create_policy':
      return withLicenseAndQuota(
        'rbac_create_policy',
        args,
        rbacCreatePolicyInputSchema,
        executeRbacCreatePolicy,
        toolContext,
        licenseMiddleware,
        quotaMiddleware
      )

    case 'webhook_configure':
      return withLicenseAndQuota(
        'webhook_configure',
        args,
        webhookConfigureInputSchema,
        executeWebhookConfigure,
        toolContext,
        licenseMiddleware,
        quotaMiddleware
      )

    case 'api_key_manage':
      return withLicenseAndQuota(
        'api_key_manage',
        args,
        apiKeyManageInputSchema,
        executeApiKeyManage,
        toolContext,
        licenseMiddleware,
        quotaMiddleware
      )

    case 'compliance_report':
      return withLicenseAndQuota(
        'compliance_report',
        args,
        complianceReportInputSchema,
        executeComplianceReport,
        toolContext,
        licenseMiddleware,
        quotaMiddleware
      )

    default: {
      // SMI-3913: Return comingSoon response for tools in TOOL_FEATURES that
      // don't have a dispatch handler yet, instead of throwing Unknown tool.
      // null = community tool (handled above), non-null = gated tool on roadmap.
      if (name in TOOL_FEATURES && TOOL_FEATURES[name] !== null) {
        return ok({
          status: 'coming_soon',
          message: `The ${name} tool is on our roadmap. Visit https://skillsmith.app/pricing#roadmap for details.`,
          requiredTier: FEATURE_TIERS[TOOL_FEATURES[name]!] ?? 'enterprise',
          feature: TOOL_FEATURES[name],
        })
      }
      throw new Error('Unknown tool: ' + name)
    }
  }
}
