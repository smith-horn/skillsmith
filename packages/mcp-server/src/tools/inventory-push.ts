/**
 * @fileoverview `inventory_push` MCP tool (SMI-5392, umbrella SMI-5382).
 * @module @skillsmith/mcp-server/tools/inventory-push
 *
 * Pushes this machine's installed-skill inventory (per harness) to the user's
 * Skillsmith account so it appears on the web dashboard. Read-only/monitoring
 * from the perspective of the local harness — no skill files are modified.
 * Requires the user to be logged in via `skillsmith login`. Respects both the
 * local opt-out flag (`SKILLSMITH_INVENTORY_DISABLE`) and the server-side
 * consent setting.
 *
 * Dispatch: registered in `tool-dispatch.ts` (no tier gate — any authenticated
 * user). Advertised via `index.ts` `toolDefinitions` array.
 *
 * Error map (all typed; none allowed to escape as unhandled rejections):
 *   - {@link InventoryAuthError}       → login prompt
 *   - {@link InventoryConflictError}   → forget-device prompt
 *   - {@link InventoryValidationError} → server validation message
 *   - {@link InventoryUploadError}     → transport failure detail
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import {
  pushInventory,
  InventoryAuthError,
  InventoryConflictError,
  InventoryValidationError,
  InventoryUploadError,
} from '@skillsmith/core'
import { withTelemetry } from '@skillsmith/core/telemetry'

/**
 * MCP tool schema for `inventory_push` (SMI-5392). Accepted by all
 * authenticated users — no tier gating. The tool takes no required
 * arguments; the permissive empty-object shape allows future extension
 * without a breaking schema change.
 */
export const inventoryPushToolSchema = {
  name: 'inventory_push',
  description:
    "[Skillsmith — Sync stage] Push this machine's installed-skill inventory to your Skillsmith account so it appears on the web dashboard. Read-only monitoring — no local skill files are modified. Requires `skillsmith login`; respects the local SKILLSMITH_INVENTORY_DISABLE flag and your account's server-side consent setting.",
  inputSchema: {
    type: 'object' as const,
    properties: {} as Record<string, never>,
    required: [] as string[],
  },
}

/**
 * Execute the `inventory_push` tool.
 *
 * Calls {@link pushInventory} and maps every result and typed error to an MCP
 * `CallToolResult`. No unhandled rejections escape this function — unknown
 * errors are converted to error content with a generic detail string.
 *
 * Success responses (`isError: false`):
 *   - `reason === 'disabled_locally'` → local opt-out message.
 *   - `applied === false && reason === 'consent_disabled'` → account consent message.
 *   - `applied === true` → device id + skill counts.
 *
 * Error responses (`isError: true`):
 *   - {@link InventoryAuthError} → login instruction.
 *   - {@link InventoryConflictError} → forget-device instruction.
 *   - {@link InventoryValidationError} → server validation message.
 *   - {@link InventoryUploadError} → transport failure detail.
 *
 * @see SMI-5392
 */
async function inventoryPushImpl(_input: unknown): Promise<CallToolResult> {
  try {
    const result = await pushInventory()

    let text: string
    if (result.reason === 'disabled_locally') {
      text = 'Inventory sync is disabled locally (SKILLSMITH_INVENTORY_DISABLE); nothing sent.'
    } else if (!result.applied && result.reason === 'consent_disabled') {
      text =
        'Inventory sync is off for your account; enable it in account settings. Nothing was stored.'
    } else if (result.applied) {
      text = `Pushed inventory for device ${result.device_id}: ${result.skills_present} present, ${result.skills_absent} marked absent.`
    } else {
      // Defensive: a non-applied result without a known reason is an edge-contract
      // violation — report it as a non-success rather than rendering `undefined`s.
      text = `Inventory was not applied${result.reason ? ` (${result.reason})` : ''}; nothing was stored.`
    }

    return { content: [{ type: 'text' as const, text }], isError: false }
  } catch (error) {
    return { content: [{ type: 'text' as const, text: buildErrorMessage(error) }], isError: true }
  }
}

/**
 * Map a caught error to a human-readable, actionable message. Typed errors
 * (from {@link InventoryAuthError} etc.) produce precise recovery instructions.
 * Unknown errors emit a generic detail string so nothing is silently swallowed.
 */
function buildErrorMessage(error: unknown): string {
  if (error instanceof InventoryAuthError) {
    return 'Not authenticated. Run `skillsmith login` in a terminal, then retry.'
  }
  if (error instanceof InventoryConflictError) {
    return 'This device is registered to another account; run `skillsmith inventory forget-device` and retry.'
  }
  if (error instanceof InventoryValidationError) {
    return error.message
  }
  if (error instanceof InventoryUploadError) {
    return 'Inventory upload failed: ' + error.message
  }
  const detail = error instanceof Error ? error.message : String(error)
  return 'Inventory push failed unexpectedly: ' + detail
}

// SMI-5392: wrap at export boundary (SMI-5017 W2.S2 pattern) so
// telemetry-coverage.test.ts picks this up via isTelemetered().
export const inventoryPush = withTelemetry(inventoryPushImpl, {
  source: 'mcp-tool',
  extractSkillId: () => 'inventory_push',
  extractFramework: () => 'unknown',
})
