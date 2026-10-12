/**
 * SMI-7056: the quick-install command answers core's CONFIRMATION_REQUIRED
 * result (a registry skill outside the reviewed trust tiers) with a modal
 * warning and a single confirmed retry. It never sets skipScan.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const showWarningMessage = vi.fn()
const showErrorMessage = vi.fn()
const showInformationMessage = vi.fn()
const registerCommand = vi.fn()
const executeCommand = vi.fn()

let acceptHandler: (() => Promise<void>) | undefined
const quickPick = {
  title: '',
  placeholder: '',
  matchOnDescription: false,
  matchOnDetail: false,
  busy: false,
  items: [] as unknown[],
  selectedItems: [] as unknown[],
  onDidChangeValue: vi.fn(),
  onDidAccept: vi.fn((cb: () => Promise<void>) => {
    acceptHandler = cb
  }),
  onDidHide: vi.fn(),
  hide: vi.fn(),
  show: vi.fn(),
  dispose: vi.fn(),
}

vi.mock('vscode', () => ({
  window: {
    showWarningMessage,
    showErrorMessage,
    showInformationMessage,
    createQuickPick: () => quickPick,
    withProgress: async (_opts: unknown, task: (p: { report: () => void }) => Promise<void>) =>
      task({ report: vi.fn() }),
  },
  commands: { registerCommand, executeCommand },
  ProgressLocation: { Notification: 15 },
  Uri: { file: (s: string) => ({ fsPath: s }) },
  workspace: { getConfiguration: vi.fn(() => ({ get: vi.fn(() => false) })) },
}))

const installSkill = vi.fn()
vi.mock('../mcp/McpClient.js', () => ({
  getMcpClient: () => ({ isConnected: () => true, installSkill }),
}))

vi.mock('../mcp/tierDenied.js', () => ({ handleTierDenied: vi.fn() }))
vi.mock('../services/telemetry-wrap.js', () => ({
  withTelemetry: <T>(fn: T) => fn,
}))
vi.mock('../services/installUtils.js', () => ({
  getSkillPath: vi.fn(() => '/tmp/skill'),
  installSkillLocally: vi.fn(),
}))

const skill = {
  id: 'example-skill',
  name: 'example-skill',
  author: 'someone',
  description: 'd',
  trustTier: 'unverified',
}

const confirmationRequired = {
  success: false,
  skillId: skill.id,
  installPath: '',
  errorCode: 'CONFIRMATION_REQUIRED',
  requiresConfirmation: true,
  trustTier: 'unverified',
  confirmationReason:
    'This is an unverified tier skill. unverified tier skills have not been reviewed. Re-run with confirmed=true to proceed.',
}

async function runInstall(): Promise<void> {
  const { registerQuickInstallCommand } = await import('../commands/installCommand.js')
  registerQuickInstallCommand({ subscriptions: [] } as never, {} as never)
  const handler = registerCommand.mock.calls[0]?.[1] as () => Promise<void>
  await handler()
  quickPick.selectedItems = [{ skill }]
  await acceptHandler!()
}

describe('installCommand trust-tier confirmation (SMI-7056)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    installSkill.mockReset()
    showWarningMessage.mockReset()
    showInformationMessage.mockReset()
    acceptHandler = undefined
    // First prompt is the generic "Install" dialog; always accept it.
    showInformationMessage.mockResolvedValueOnce('Install')
    showInformationMessage.mockResolvedValue(undefined)
  })

  it('retries once with confirmed: true after "Install anyway"', async () => {
    installSkill
      .mockResolvedValueOnce(confirmationRequired)
      .mockResolvedValueOnce({ success: true, skillId: skill.id, installPath: '/tmp/skill' })
    showWarningMessage.mockResolvedValueOnce('Install anyway')

    await runInstall()

    expect(installSkill).toHaveBeenCalledTimes(2)
    expect(installSkill.mock.calls[0]).toEqual([skill.id])
    expect(installSkill.mock.calls[1]).toEqual([skill.id, { confirmed: true }])
    const [message, options, button] = showWarningMessage.mock.calls[0] ?? []
    expect(message).toContain('unverified')
    expect(options.modal).toBe(true)
    expect(options.detail).toContain('have not been reviewed')
    expect(options.detail).not.toContain('confirmed=true')
    expect(button).toBe('Install anyway')
    expect(showErrorMessage).not.toHaveBeenCalled()
  })

  it('never passes skipScan on either call', async () => {
    installSkill
      .mockResolvedValueOnce(confirmationRequired)
      .mockResolvedValueOnce({ success: true, skillId: skill.id, installPath: '/tmp/skill' })
    showWarningMessage.mockResolvedValueOnce('Install anyway')

    await runInstall()

    for (const call of installSkill.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('skipScan')
    }
  })

  it('does not retry when the warning is dismissed, and reports a cancellation', async () => {
    installSkill.mockResolvedValueOnce(confirmationRequired)
    showWarningMessage.mockResolvedValueOnce(undefined)

    await runInstall()

    expect(showWarningMessage).toHaveBeenCalledTimes(1)
    expect(installSkill).toHaveBeenCalledTimes(1)
    expect(showErrorMessage).not.toHaveBeenCalled()
    const cancelled = showInformationMessage.mock.calls.some((c) => /cancelled/.test(String(c[0])))
    expect(cancelled).toBe(true)
  })

  it('makes one call with no confirmed option and no warning on a normal success', async () => {
    installSkill.mockResolvedValueOnce({
      success: true,
      skillId: skill.id,
      installPath: '/tmp/skill',
    })

    await runInstall()

    expect(installSkill).toHaveBeenCalledTimes(1)
    expect(installSkill.mock.calls[0]).toEqual([skill.id])
    expect(showWarningMessage).not.toHaveBeenCalled()
  })
})
