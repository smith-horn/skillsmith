/**
 * Unit tests for src/mcp/connectFailureUx.ts (SMI-5398).
 *
 * Pure DI-seam coverage — no VS Code test host required. Matches the
 * versionCheck.test.ts pattern: vi.mock vscode, then static imports.
 *
 * Key coverage (F1):
 *  - "Use detected Node" action: writes serverCommand + serverArgs + calls reconnect
 *  - Anti-nag: same cause shown at most once per session
 *  - resetConnectFailureNag: subsequent same cause is shown again
 *  - No-selfHeal branch: only Open Settings / Show Logs offered; no config write
 *  - "Open Settings" action: calls openSettings()
 *  - "Show Logs" action: calls revealLog()
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// vscode is a real runtime import in connectFailureUx.ts — mock ConfigurationTarget.
vi.mock('vscode', () => ({
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
}))

// revealMcpLog is imported at module level in connectFailureUx.ts.
vi.mock('../../mcp/mcpLog.js', () => ({ revealMcpLog: vi.fn() }))

import { handleConnectFailure, resetConnectFailureNag } from '../../mcp/connectFailureUx.js'
import { ServerCommandUnresolvedError } from '../../mcp/resolveServerCommand.js'

// ── DI deps builder ───────────────────────────────────────────────────────────
function makeDeps(overrides?: {
  choice?: string | undefined
  selfHealPair?: { serverCommand: string; serverArgs: string[] }
}) {
  const updateMock = vi.fn().mockResolvedValue(undefined)
  const cfgMock = { update: updateMock }
  // Typed as a Mock (not cast to plain function) so .mock.calls is accessible.
  const showErrorMessage = vi
    .fn<(message: string, ...items: string[]) => Promise<string | undefined>>()
    .mockResolvedValue(overrides?.choice ?? undefined)
  const getConfiguration = vi.fn().mockReturnValue(cfgMock)
  const reconnect = vi.fn().mockResolvedValue(undefined)
  const revealLog = vi.fn()
  const openSettings = vi.fn()

  return { showErrorMessage, getConfiguration, reconnect, revealLog, openSettings, cfgMock }
}

// Helper: make an unresolved error with a self-heal suggestion.
function makeUnresolvedError(
  cmd = 'npx',
  selfHeal?: { serverCommand: string; serverArgs: string[]; label: string }
) {
  return new ServerCommandUnresolvedError(cmd, selfHeal)
}

const SELF_HEAL = {
  serverCommand: '/usr/local/bin/node',
  serverArgs: ['/usr/local/lib/node_modules/@skillsmith/mcp-server/dist/index.js'],
  label: 'Use detected Node',
}

// ── reset anti-nag between tests ─────────────────────────────────────────────
beforeEach(() => {
  resetConnectFailureNag()
})

// ── "Use detected Node" action ────────────────────────────────────────────────
describe('handleConnectFailure — "Use detected Node" action', () => {
  it('writes serverCommand and serverArgs to Global config then calls reconnect', async () => {
    const { showErrorMessage, getConfiguration, reconnect, revealLog, openSettings, cfgMock } =
      makeDeps({ choice: SELF_HEAL.label })
    const error = makeUnresolvedError('npx', SELF_HEAL)

    await handleConnectFailure(error, {
      showErrorMessage,
      getConfiguration,
      reconnect,
      revealLog,
      openSettings,
    })

    // Both config writes must have been called with the self-heal values + Global target
    expect(cfgMock.update).toHaveBeenCalledWith(
      'mcp.serverCommand',
      SELF_HEAL.serverCommand,
      1 // vscode.ConfigurationTarget.Global = 1 (mocked)
    )
    expect(cfgMock.update).toHaveBeenCalledWith('mcp.serverArgs', SELF_HEAL.serverArgs, 1)
    expect(reconnect).toHaveBeenCalledOnce()
  })

  it('does NOT call openSettings or revealLog on the selfHeal action', async () => {
    const { showErrorMessage, getConfiguration, reconnect, revealLog, openSettings } = makeDeps({
      choice: SELF_HEAL.label,
    })
    const error = makeUnresolvedError('npx', SELF_HEAL)

    await handleConnectFailure(error, {
      showErrorMessage,
      getConfiguration,
      reconnect,
      revealLog,
      openSettings,
    })

    expect(openSettings).not.toHaveBeenCalled()
    expect(revealLog).not.toHaveBeenCalled()
  })
})

// ── anti-nag guard ────────────────────────────────────────────────────────────
describe('anti-nag guard', () => {
  it('shows the error message only once for the same cause in a session', async () => {
    const { showErrorMessage, getConfiguration, reconnect, revealLog, openSettings } = makeDeps({
      choice: undefined,
    }) // user dismisses
    const error = makeUnresolvedError('npx', SELF_HEAL)

    await handleConnectFailure(error, {
      showErrorMessage,
      getConfiguration,
      reconnect,
      revealLog,
      openSettings,
    })
    // Second call with the same cause — nag guard kicks in
    await handleConnectFailure(error, {
      showErrorMessage,
      getConfiguration,
      reconnect,
      revealLog,
      openSettings,
    })

    expect(showErrorMessage).toHaveBeenCalledTimes(1)
  })

  it('shows for a DIFFERENT cause even if the first has already been shown', async () => {
    const deps1 = makeDeps({ choice: undefined })
    const deps2 = makeDeps({ choice: undefined })
    const error1 = makeUnresolvedError('npx', SELF_HEAL)
    const error2 = new Error('Some other failure')

    await handleConnectFailure(error1, { ...deps1 })
    await handleConnectFailure(error2, { ...deps2 })

    expect(deps1.showErrorMessage).toHaveBeenCalledTimes(1)
    expect(deps2.showErrorMessage).toHaveBeenCalledTimes(1)
  })
})

// ── resetConnectFailureNag ────────────────────────────────────────────────────
describe('resetConnectFailureNag', () => {
  it('clears the nag guard so the same cause can be shown again', async () => {
    const deps1 = makeDeps({ choice: undefined })
    const error = makeUnresolvedError('npx', SELF_HEAL)

    // First invocation — shown
    await handleConnectFailure(error, { ...deps1 })
    expect(deps1.showErrorMessage).toHaveBeenCalledTimes(1)

    // Reset the guard (simulates a successful connection)
    resetConnectFailureNag()

    // Second invocation — shown again because guard was cleared
    const deps2 = makeDeps({ choice: undefined })
    await handleConnectFailure(error, { ...deps2 })
    expect(deps2.showErrorMessage).toHaveBeenCalledTimes(1)
  })
})

// ── no-selfHeal branch ────────────────────────────────────────────────────────
describe('no-selfHeal branch', () => {
  it('offers only "Open Settings" and "Show Logs" — no selfHeal action', async () => {
    const { showErrorMessage, getConfiguration, reconnect, revealLog, openSettings } = makeDeps({
      choice: undefined,
    })
    // Plain Error (not ServerCommandUnresolvedError) → no selfHeal
    const error = new Error('connection refused')

    await handleConnectFailure(error, {
      showErrorMessage,
      getConfiguration,
      reconnect,
      revealLog,
      openSettings,
    })

    const callArgs = showErrorMessage.mock.calls[0] as [string, ...string[]]
    // First arg is the message; subsequent args are the action labels
    const actionLabels = callArgs.slice(1)
    expect(actionLabels).not.toContain('Use detected Node')
    expect(actionLabels).toContain('Open Settings')
    expect(actionLabels).toContain('Show Logs')
  })

  it('does NOT write config or call reconnect when there is no selfHeal', async () => {
    const { showErrorMessage, getConfiguration, reconnect, revealLog, openSettings, cfgMock } =
      makeDeps({ choice: undefined })
    const error = new Error('ENOENT')

    await handleConnectFailure(error, {
      showErrorMessage,
      getConfiguration,
      reconnect,
      revealLog,
      openSettings,
    })

    expect(cfgMock.update).not.toHaveBeenCalled()
    expect(reconnect).not.toHaveBeenCalled()
  })
})

// ── "Open Settings" action ────────────────────────────────────────────────────
describe('"Open Settings" action', () => {
  it('calls openSettings() when user picks "Open Settings"', async () => {
    const { showErrorMessage, getConfiguration, reconnect, revealLog, openSettings } = makeDeps({
      choice: 'Open Settings',
    })
    await handleConnectFailure(new Error('oops'), {
      showErrorMessage,
      getConfiguration,
      reconnect,
      revealLog,
      openSettings,
    })
    expect(openSettings).toHaveBeenCalledOnce()
    expect(reconnect).not.toHaveBeenCalled()
  })
})

// ── "Show Logs" action ────────────────────────────────────────────────────────
describe('"Show Logs" action', () => {
  it('calls revealLog() when user picks "Show Logs"', async () => {
    const { showErrorMessage, getConfiguration, reconnect, revealLog, openSettings } = makeDeps({
      choice: 'Show Logs',
    })
    await handleConnectFailure(new Error('oops'), {
      showErrorMessage,
      getConfiguration,
      reconnect,
      revealLog,
      openSettings,
    })
    expect(revealLog).toHaveBeenCalledOnce()
    expect(reconnect).not.toHaveBeenCalled()
  })
})
