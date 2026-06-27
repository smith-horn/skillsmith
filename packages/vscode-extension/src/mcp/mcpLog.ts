/**
 * Tiny shared logger for the "Skillsmith MCP" OutputChannel (SMI-5398).
 *
 * The channel is created once at activation (extension.ts) and registered via
 * setMcpOutputChannel. logMcp / revealMcpLog are no-ops when the channel is
 * unset (fail-soft) so unit tests and pre-activation calls never throw.
 * Importers (McpClient, resolveServerCommand, connectFailureUx) call logMcp
 * without threading a channel through their signatures.
 *
 * Security: callers log the dirs added to PATH and the resolved command — never
 * the full secret-bearing env (which carries SKILLSMITH_API_KEY etc.).
 */
import type * as vscode from 'vscode'

let channel: vscode.OutputChannel | undefined

/** Register the OutputChannel (called once from extension.ts activation). */
export function setMcpOutputChannel(output: vscode.OutputChannel): void {
  channel = output
}

/** Append a timestamped line. No-op when the channel is unset. */
export function logMcp(line: string): void {
  if (!channel) return
  channel.appendLine(`[${new Date().toISOString()}] ${line}`)
}

/** Reveal the MCP OutputChannel. No-op when the channel is unset. */
export function revealMcpLog(): void {
  channel?.show(true)
}
