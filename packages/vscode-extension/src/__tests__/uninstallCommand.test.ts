import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

const showWarningMessage = vi.fn()
const showErrorMessage = vi.fn()
const showInformationMessage = vi.fn()
const showQuickPick = vi.fn()
const registerCommand = vi.fn()

vi.mock('vscode', () => {
  const subscriptions: unknown[] = []
  return {
    window: { showWarningMessage, showErrorMessage, showInformationMessage, showQuickPick },
    commands: { registerCommand },
    workspace: {
      getConfiguration: vi.fn(() => ({ get: vi.fn(() => undefined) })),
    },
    Disposable: class {
      dispose = vi.fn()
    },
    ExtensionContext: class {
      subscriptions = subscriptions
    },
  }
})

const mcpConnected = vi.fn(() => true)
const mcpUninstall = vi.fn()
vi.mock('../mcp/McpClient.js', () => ({
  getMcpClient: () => ({
    isConnected: mcpConnected,
    uninstallSkill: mcpUninstall,
  }),
}))

const refreshAndWait = vi.fn(async () => {})
const getInstalledSkills = vi.fn<() => readonly unknown[]>(() => [])
vi.mock('../sidebar/SkillTreeDataProvider.js', () => ({
  SkillTreeDataProvider: class {
    refreshAndWait = refreshAndWait
    getInstalledSkills = getInstalledSkills
  },
}))

vi.mock('../services/installUtils.js', () => ({
  getSkillsDirectory: vi.fn(() => globalThis.__TEMP_ROOT__ as string),
}))

declare global {
  var __TEMP_ROOT__: string
}

describe('uninstallCommand (SMI-4195)', () => {
  let tempRoot: string
  let skillPath: string
  let handler: (arg?: unknown) => Promise<void>
  let context: { subscriptions: unknown[] }

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'uninstall-test-'))
    globalThis.__TEMP_ROOT__ = tempRoot
    skillPath = path.join(tempRoot, 'example-skill')
    await fs.mkdir(skillPath)
    await fs.writeFile(path.join(skillPath, 'SKILL.md'), 'stub')

    showWarningMessage.mockReset()
    showErrorMessage.mockReset()
    showInformationMessage.mockReset()
    showQuickPick.mockReset()
    registerCommand.mockReset()
    mcpConnected.mockReset().mockReturnValue(true)
    mcpUninstall.mockReset()
    refreshAndWait.mockReset().mockResolvedValue(undefined)
    getInstalledSkills.mockReset().mockReturnValue([
      {
        id: 'example-skill',
        name: 'Example Skill',
        description: 'Example',
        trustTier: 'local',
        path: skillPath,
        isInstalled: true,
      },
    ])

    vi.resetModules()
    const { registerUninstallCommand } = await import('../commands/uninstallCommand.js')
    const { SkillTreeDataProvider } = await import('../sidebar/SkillTreeDataProvider.js')
    const provider = new SkillTreeDataProvider()
    context = { subscriptions: [] }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerUninstallCommand(context as any, provider as any)
    const call = registerCommand.mock.calls[0]
    if (!call) throw new Error('uninstall command not registered')
    handler = call[1] as (arg?: unknown) => Promise<void>
  })

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true })
  })

  it('uninstalls via MCP and removes skill directory from tree cache', async () => {
    showQuickPick.mockResolvedValue({ skillId: 'example-skill', skillPath })
    showWarningMessage.mockResolvedValue('Uninstall')
    mcpUninstall.mockResolvedValue({ success: true, skillId: 'example-skill' })

    await handler()

    expect(mcpUninstall).toHaveBeenCalledWith('example-skill')
    expect(refreshAndWait).toHaveBeenCalledTimes(2) // once in resolveTarget, once after success
    expect(showInformationMessage).toHaveBeenCalledWith('Uninstalled "example-skill".')
  })

  it('falls back to fs.rm when MCP is disconnected', async () => {
    mcpConnected.mockReturnValue(false)
    showQuickPick.mockResolvedValue({ skillId: 'example-skill', skillPath })
    showWarningMessage.mockResolvedValue('Uninstall')

    await handler()

    expect(mcpUninstall).not.toHaveBeenCalled()
    await expect(fs.access(skillPath)).rejects.toThrow()
    expect(showInformationMessage).toHaveBeenCalled()
  })

  it('cancels when user dismisses confirmation', async () => {
    showQuickPick.mockResolvedValue({ skillId: 'example-skill', skillPath })
    showWarningMessage.mockResolvedValue(undefined) // user cancelled

    await handler()

    expect(mcpUninstall).not.toHaveBeenCalled()
    await fs.access(skillPath) // still exists
  })

  it('refuses when resolved path is outside skillsDirectory (symlink escape)', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'uninstall-outside-'))
    try {
      const evilLink = path.join(tempRoot, 'evil')
      await fs.symlink(outside, evilLink)
      showQuickPick.mockResolvedValue({ skillId: 'evil', skillPath: evilLink })
      showWarningMessage.mockResolvedValue('Uninstall')

      await handler()

      expect(mcpUninstall).not.toHaveBeenCalled()
      expect(showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('resolves outside the configured skills directory')
      )
      await fs.access(outside) // outside dir untouched
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('shows "no skills" when none installed and no arg', async () => {
    getInstalledSkills.mockReturnValue([])

    await handler()

    expect(showQuickPick).not.toHaveBeenCalled()
    expect(showInformationMessage).toHaveBeenCalledWith('No installed skills to uninstall.')
  })

  it('uses arg skillData when invoked from tree context menu', async () => {
    showWarningMessage.mockResolvedValue('Uninstall')
    mcpUninstall.mockResolvedValue({ success: true, skillId: 'example-skill' })

    await handler({
      skillData: { id: 'example-skill', isInstalled: true, path: skillPath },
    })

    expect(showQuickPick).not.toHaveBeenCalled()
    expect(mcpUninstall).toHaveBeenCalledWith('example-skill')
  })

  it('surfaces MCP refusal and does NOT fall back to fs.rm', async () => {
    // MCP is connected but deliberately refuses (e.g. TierDenied, server-side validation).
    // The extension must NOT bypass this by deleting via fs.rm.
    showQuickPick.mockResolvedValue({ skillId: 'example-skill', skillPath })
    showWarningMessage.mockResolvedValue('Uninstall')
    mcpUninstall.mockResolvedValue({ success: false, error: 'TierDenied: requires Team plan' })

    await handler()

    expect(showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('TierDenied: requires Team plan')
    )
    // Skill directory must still exist — fs.rm was NOT called.
    await expect(fs.access(skillPath)).resolves.toBeUndefined()
    expect(showInformationMessage).not.toHaveBeenCalledWith(expect.stringContaining('Uninstalled'))
  })

  it('falls back to fs.rm on MCP transport error (throw)', async () => {
    // Transport-level failure is different from a deliberate server refusal.
    // A disconnected-mid-call scenario should fall back to direct deletion.
    showQuickPick.mockResolvedValue({ skillId: 'example-skill', skillPath })
    showWarningMessage.mockResolvedValue('Uninstall')
    mcpUninstall.mockRejectedValue(new Error('ECONNRESET'))

    await handler()

    await expect(fs.access(skillPath)).rejects.toThrow()
    expect(showInformationMessage).toHaveBeenCalledWith('Uninstalled "example-skill".')
  })
})
