/**
 * @fileoverview Provenance-tool dispatch for the Skillsmith MCP server (SMI-5407).
 * @module @skillsmith/mcp-server/provenance-tool-dispatch
 *
 * Mirrors the pattern of `audit-tool-dispatch.ts`: extracted from
 * `tool-dispatch.ts` to keep the parent dispatcher under the 500-LOC gate.
 *
 * Currently handles:
 *   - `skill_recover_source` — read-only source recovery (Community, no
 *     withLicenseAndQuota; direct call pattern per audit-tool-dispatch.ts
 *     lines 178-179).
 *
 * Cut for v1: `apply_source_backfill` mutation tool (fast-follow, SMI-5407 DoD).
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ToolContext } from './context.js'
import {
  executeSkillRecoverSource,
  skillRecoverSourceToolSchema,
} from './tools/skill-recover-source.js'

// ============================================================================
// Tool name set
// ============================================================================

/**
 * Tool names handled by this dispatcher. `tool-dispatch.ts` delegates
 * iff the requested tool name is in this set.
 */
export const PROVENANCE_TOOL_NAMES: ReadonlySet<string> = new Set<string>(['skill_recover_source'])

/**
 * Returns true if `name` is a provenance-family tool dispatched by this module.
 */
export function isProvenanceToolName(name: string): boolean {
  return PROVENANCE_TOOL_NAMES.has(name)
}

// ============================================================================
// ListTools definitions
// ============================================================================

export interface ProvenanceToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required: string[]
  }
}

/**
 * ListTools definitions for provenance-family tools. `index.ts` spreads this
 * into `toolDefinitions` so the tools become client-discoverable.
 */
export function provenanceToolDefinitions(): ProvenanceToolDefinition[] {
  return [skillRecoverSourceToolSchema]
}

// ============================================================================
// Dispatch helpers
// ============================================================================

/** Wrap a payload as a successful MCP `CallToolResult` (mirrors audit-dispatch). */
function okBody(payload: unknown): CallToolResult {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    isError: false,
  }
}

// ============================================================================
// Main dispatcher
// ============================================================================

/**
 * Dispatch a provenance-family tool call. Caller must check
 * {@link isProvenanceToolName} before invoking.
 *
 * Community tools are called directly (no `withLicenseAndQuota` wrapper),
 * mirroring the `skill_inventory_audit` / `apply_namespace_rename` pattern in
 * `audit-tool-dispatch.ts`.
 */
export async function dispatchProvenanceTool(
  name: string,
  args: Record<string, unknown> | undefined,
  toolContext: ToolContext
): Promise<CallToolResult> {
  switch (name) {
    case 'skill_recover_source':
      return okBody(await executeSkillRecoverSource(args, toolContext))

    default:
      throw new Error('Unknown provenance tool: ' + name)
  }
}
