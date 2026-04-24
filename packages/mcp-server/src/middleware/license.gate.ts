// SMI-3911: Unified license + quota gate helpers extracted from license.ts (500-line limit).
// SMI-4402: profile_incomplete detection and JSON-RPC -32001 response.
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ZodType, ZodTypeDef } from 'zod'
import type { ToolContext } from '../context.types.js'
import type { QuotaMiddleware } from './quota-types.js'
import { safeParseOrError } from '../validation.js'
import { ApiClientError } from '@skillsmith/core'
import type { LicenseMiddleware } from './license.js'
import { createLicenseErrorResponse } from './license.js'

const COMPLETE_PROFILE_URL = 'https://skillsmith.app/complete-profile'

export function ok(result: unknown): CallToolResult {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  }
}

export function errResponse(response: {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
  _meta?: Record<string, unknown>
}): CallToolResult {
  return response as unknown as CallToolResult
}

// SMI-4402: returns -32001 JSON-RPC error code so Claude Code can surface the
// profile_incomplete state without silently 500ing the MCP subprocess.
export function createProfileIncompleteResponse(): {
  content: Array<{ type: 'text'; text: string }>
  isError: true
} {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            code: -32001,
            error: 'profile_incomplete',
            complete_url: COMPLETE_PROFILE_URL,
            message: `Almost there! Add your first & last name (30 seconds): ${COMPLETE_PROFILE_URL}`,
            data: { profile_incomplete: true },
          },
          null,
          2
        ),
      },
    ],
    isError: true,
  }
}

// SMI-4402: H9 — profile_incomplete 403s are caught and translated to a user-facing
// response. Note: checkAndTrack runs before the handler (quota IS decremented even
// for profile_incomplete errors, because the QuotaMiddleware has no split check/track
// API). A future improvement (SMI-4403) could add a checkOnly + track-on-success path.
export async function withLicenseAndQuota<T>(
  toolName: string,
  args: Record<string, unknown> | undefined,
  schema: ZodType<T, ZodTypeDef, unknown>,
  handler: (input: T, ctx: ToolContext) => Promise<unknown>,
  toolContext: ToolContext,
  licenseMiddleware: LicenseMiddleware,
  quotaMiddleware: QuotaMiddleware
): Promise<CallToolResult> {
  const parsed = safeParseOrError(schema, args, toolName)
  if (!parsed.ok) return parsed.response
  const licenseResult = await licenseMiddleware.checkTool(toolName)
  if (!licenseResult.valid) return errResponse(createLicenseErrorResponse(licenseResult))
  const licenseInfo = await licenseMiddleware.getLicenseInfo()
  const quotaResult = await quotaMiddleware.checkAndTrack(toolName, licenseInfo)
  if (!quotaResult.allowed) return errResponse(quotaMiddleware.buildExceededResponse(quotaResult))
  try {
    return ok(await handler(parsed.data, toolContext))
  } catch (err) {
    if (
      err instanceof ApiClientError &&
      err.statusCode === 403 &&
      err.message === 'profile_incomplete'
    ) {
      return errResponse(createProfileIncompleteResponse())
    }
    throw err
  }
}
