/**
 * Tier-denied UX handler (SMI-5288) implementing vscode-mcp-parity Design
 * Principle 3: when an MCP tool refuses an action because the caller's plan is
 * too low, surface a warning with a path to upgrade rather than silently
 * failing or falling back to mock data.
 */
import * as vscode from 'vscode'
import type { McpToolError } from './McpToolError.js'
import { track } from '../services/Telemetry.js'

/**
 * Parse a tier name out of a tier-denied error message, e.g.
 * "requires the Team plan" → "Team". Returns `undefined` when no tier token is
 * present.
 */
export function parseRequiredTier(message: string | undefined): string | undefined {
  if (!message) return undefined
  const match = /requires (?:the )?(\w+) (?:plan|tier)/i.exec(message)
  return match ? match[1] : undefined
}

/**
 * Show the tier-denied warning and route the user to billing or pricing.
 * Always emits the `vscode_tier_denied` telemetry event.
 */
export async function handleTierDenied(command: string, err: McpToolError): Promise<void> {
  const requiredTier = parseRequiredTier(err.message)
  track('vscode_tier_denied', { cmd: command, required_tier: requiredTier })

  const choice = await vscode.window.showWarningMessage(
    err.message || 'This feature requires a higher plan.',
    'Open Billing',
    'Learn more'
  )

  if (choice === 'Open Billing') {
    await vscode.env.openExternal(
      vscode.Uri.parse(
        'https://skillsmith.app/billing?src=vscode&cmd=' + encodeURIComponent(command)
      )
    )
  } else if (choice === 'Learn more') {
    // `packages/website/src/pages/pricing.astro` exists → use /pricing.
    await vscode.env.openExternal(vscode.Uri.parse('https://skillsmith.app/pricing'))
  }
}
