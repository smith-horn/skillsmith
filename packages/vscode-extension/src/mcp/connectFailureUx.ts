/**
 * Actionable, self-healing failure UX for an INITIAL MCP connect (SMI-5398).
 *
 * Centralizes the error toast + its actions so the two initial-connect catch
 * sites (auto-connect on activation, and connectWithProgress) share one anti-nag
 * guard and one self-heal write. The handler is pure-by-DI (mirrors
 * versionCheck.ts): every side effect is injected, so it is unit-testable
 * without the VS Code test host. `defaultConnectFailureDeps` supplies the real
 * vscode wiring at the call sites.
 */
import * as vscode from 'vscode'
import { ServerCommandUnresolvedError, type SelfHealSuggestion } from './resolveServerCommand.js'
import { revealMcpLog } from './mcpLog.js'

const OPEN_SETTINGS = 'Open Settings'
const SHOW_LOGS = 'Show Logs'

/** A subset of vscode.WorkspaceConfiguration so the writer can be faked in tests. */
export interface ConfigWriter {
  update(section: string, value: unknown, target: vscode.ConfigurationTarget): Thenable<void>
}

/** Injected side effects — every vscode.* touch the handler needs (DI seams). */
export interface ConnectFailureDeps {
  showErrorMessage: (message: string, ...items: string[]) => Thenable<string | undefined>
  getConfiguration: () => ConfigWriter
  reconnect: () => Promise<unknown>
  revealLog: () => void
  openSettings: () => void
}

/**
 * Session anti-nag guard. Tracks the distinct unresolved causes already shown so
 * the actionable error appears at most once per cause per session. Cleared on a
 * successful `connected` status via resetConnectFailureNag().
 */
let offeredCauses = new Set<string>()

/**
 * Terminal-failure handler. Call ONLY from (a) auto-connect initial catch and
 * (b) connectWithProgress catch — NOT from handleDisconnect's retry loop (which
 * swallows failures via void this.connect()). If retry-exhaustion UX is added,
 * wire McpClientConfig.onRetriesExhausted instead.
 */
export async function handleConnectFailure(
  error: unknown,
  deps: ConnectFailureDeps
): Promise<void> {
  const selfHeal = error instanceof ServerCommandUnresolvedError ? error.selfHeal : undefined
  const cause = describeCause(error, selfHeal)

  // Anti-nag: show at most once per session per distinct unresolved cause.
  if (offeredCauses.has(cause)) return
  offeredCauses.add(cause)

  const actions: string[] = []
  if (selfHeal) actions.push(selfHeal.label)
  actions.push(OPEN_SETTINGS, SHOW_LOGS)

  const choice = await deps.showErrorMessage(buildMessage(error, selfHeal), ...actions)
  if (choice === undefined) return

  if (selfHeal && choice === selfHeal.label) {
    const cfg = deps.getConfiguration()
    // Global (machine-wide): the PATH gap is per-machine, not per-project.
    await cfg.update('mcp.serverCommand', selfHeal.serverCommand, vscode.ConfigurationTarget.Global)
    await cfg.update('mcp.serverArgs', selfHeal.serverArgs, vscode.ConfigurationTarget.Global)
    await deps.reconnect()
  } else if (choice === OPEN_SETTINGS) {
    deps.openSettings()
  } else if (choice === SHOW_LOGS) {
    deps.revealLog()
  }
}

/** Clear the anti-nag guard — call when the client reaches `connected`. */
export function resetConnectFailureNag(): void {
  offeredCauses = new Set<string>()
}

function describeCause(error: unknown, selfHeal: SelfHealSuggestion | undefined): string {
  if (error instanceof ServerCommandUnresolvedError) {
    return `unresolved:${error.message}:${selfHeal?.label ?? 'none'}`
  }
  return `error:${error instanceof Error ? error.message : String(error)}`
}

function buildMessage(error: unknown, selfHeal: SelfHealSuggestion | undefined): string {
  const base =
    error instanceof ServerCommandUnresolvedError
      ? 'Skillsmith could not find the MCP server command on your PATH.'
      : `Skillsmith could not start the MCP server: ${
          error instanceof Error ? error.message : String(error)
        }.`
  return selfHeal
    ? `${base} Skillsmith found a working Node toolchain and can configure it for you.`
    : `${base} Install it with \`npm install -g @skillsmith/mcp-server\`, then reconnect.`
}

/**
 * Real vscode wiring for {@link handleConnectFailure}. `reconnect` is injected
 * because it lives in McpStatusBar (importing it here would create a cycle).
 */
export function defaultConnectFailureDeps(reconnect: () => Promise<unknown>): ConnectFailureDeps {
  return {
    showErrorMessage: (message, ...items) => vscode.window.showErrorMessage(message, ...items),
    getConfiguration: () => vscode.workspace.getConfiguration('skillsmith'),
    reconnect,
    revealLog: () => revealMcpLog(),
    openSettings: () => {
      void vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'skillsmith.mcp.serverCommand'
      )
    },
  }
}
