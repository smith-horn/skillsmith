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
import { installSkill, installInputSchema } from './tools/install.js'
import { uninstallSkill, uninstallInputSchema } from './tools/uninstall.js'
import { recommendInputSchema, executeRecommend } from './tools/recommend.js'
import { validateInputSchema, executeValidate } from './tools/validate.js'
import { compareInputSchema, executeCompare } from './tools/compare.js'
import { suggestInputSchema, executeSuggest } from './tools/suggest.js'
import { indexLocalInputSchema, executeIndexLocal } from './tools/index-local.js'
import { publishInputSchema, executePublish } from './tools/publish.js'
import { skillUpdatesInputSchema, executeSkillUpdates } from './tools/skill-updates.js'
import { skillDiffInputSchema, executeSkillDiff } from './tools/skill-diff.js'
import { createLicenseErrorResponse } from './middleware/license.js'
import type { LicenseMiddleware } from './middleware/license.js'
import type { QuotaMiddleware } from './middleware/quota.js'

/**
 * Build a standard tool success response wrapping a JSON-serialisable result.
 */
function ok(result: unknown): CallToolResult {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  }
}

/**
 * Cast a middleware error response (MCPErrorResponse) to CallToolResult.
 * MCPErrorResponse is structurally compatible but lacks the index signature
 * that Zod's $loose schema infers on CallToolResult.
 */
function errResponse(response: {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
  _meta?: Record<string, unknown>
}): CallToolResult {
  return response as unknown as CallToolResult
}

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
      return ok(await installSkill(installInputSchema.parse(args), toolContext))

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

    case 'skill_publish':
      return ok(await executePublish(publishInputSchema.parse(args), toolContext))

    case 'skill_updates': {
      const input = skillUpdatesInputSchema.parse(args)
      const license = await licenseMiddleware.checkTool('skill_updates')
      if (!license.valid) return errResponse(createLicenseErrorResponse(license))
      const licenseInfo = await licenseMiddleware.getLicenseInfo()
      const quotaResult = await quotaMiddleware.checkAndTrack('skill_updates', licenseInfo)
      if (!quotaResult.allowed)
        return errResponse(quotaMiddleware.buildExceededResponse(quotaResult))
      return ok(await executeSkillUpdates(input, toolContext))
    }

    case 'skill_diff': {
      const input = skillDiffInputSchema.parse(args)
      const licenseResult = await licenseMiddleware.checkTool('skill_diff')
      if (!licenseResult.valid) return errResponse(createLicenseErrorResponse(licenseResult))
      const licenseInfo = await licenseMiddleware.getLicenseInfo()
      const quotaResult = await quotaMiddleware.checkAndTrack('skill_diff', licenseInfo)
      if (!quotaResult.allowed)
        return errResponse(quotaMiddleware.buildExceededResponse(quotaResult))
      return ok(await executeSkillDiff(input, toolContext))
    }

    default:
      throw new Error('Unknown tool: ' + name)
  }
}
