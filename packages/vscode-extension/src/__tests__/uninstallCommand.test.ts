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
    env: { openExternal: vi.fn() },
    Uri: { parse: (s: string) => ({ toString: () => s }) },
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

const track = vi.fn()
vi.mock('../services/Telemetry.js', () => ({
  track,
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
    track.mockReset()
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
    // MCP is connected but deliberately refuses (server-side validation).
    // The extension must NOT bypass this by deleting via fs.rm.
    showQuickPick.mockResolvedValue({ skillId: 'example-skill', skillPath })
    showWarningMessage.mockResolvedValue('Uninstall')
    mcpUninstall.mockResolvedValue({ success: false, error: 'Skill is locked by policy' })

    await handler()

    expect(showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Skill is locked by policy')
    )
    // Skill directory must still exist — fs.rm was NOT called.
    await expect(fs.access(skillPath)).resolves.toBeUndefined()
    expect(showInformationMessage).not.toHaveBeenCalledWith(expect.stringContaining('Uninstalled'))
  })

  it('routes a TierDenied refusal to the upgrade UX and does NOT fall back to fs.rm', async () => {
    // SMI-5288: a TierDenied {success:false} payload must show the tier-denied
    // warning (not the generic error) and must not delete via fs.rm.
    showQuickPick.mockResolvedValue({ skillId: 'example-skill', skillPath })
    // First showWarningMessage call = the confirm dialog; second = tierDenied warning.
    showWarningMessage.mockResolvedValueOnce('Uninstall').mockResolvedValueOnce(undefined)
    mcpUninstall.mockResolvedValue({ success: false, error: 'TierDenied: requires the Team plan' })

    await handler()

    // The tier-denied warning was shown with the upgrade actions.
    expect(showWarningMessage).toHaveBeenCalledWith(
      'TierDenied: requires the Team plan',
      'Open Billing',
      'Learn more'
    )
    // Generic refusal error must NOT be shown.
    expect(showErrorMessage).not.toHaveBeenCalled()
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

describe('uninstallByTarget core (SMI-5308 / detail-panel)', () => {
  let tempRoot: string
  let skillPath: string
  let uninstallByTarget: typeof import('../commands/uninstallCommand.js')['uninstallByTarget']
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let provider: any

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'uninstall-core-'))
    globalThis.__TEMP_ROOT__ = tempRoot
    skillPath = path.join(tempRoot, 'example-skill')
    await fs.mkdir(skillPath)

    showWarningMessage.mockReset()
    showErrorMessage.mockReset()
    showInformationMessage.mockReset()
    mcpConnected.mockReset().mockReturnValue(true)
    mcpUninstall.mockReset()
    track.mockReset()
    refreshAndWait.mockReset().mockResolvedValue(undefined)

    vi.resetModules()
    const mod = await import('../commands/uninstallCommand.js')
    uninstallByTarget = mod.uninstallByTarget
    const { SkillTreeDataProvider } = await import('../sidebar/SkillTreeDataProvider.js')
    provider = new SkillTreeDataProvider()
  })

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true })
  })

  it('returns true and emits detail-panel telemetry on MCP success', async () => {
    showWarningMessage.mockResolvedValue('Uninstall')
    mcpUninstall.mockResolvedValue({ success: true, skillId: 'example-skill' })

    const ok = await uninstallByTarget(
      { skillId: 'example-skill', skillPath },
      { treeProvider: provider },
      'detail-panel'
    )

    expect(ok).toBe(true)
    expect(mcpUninstall).toHaveBeenCalledWith('example-skill')
    expect(track).toHaveBeenCalledWith('vscode_uninstall_start', { via: 'detail-panel' })
    expect(track).toHaveBeenCalledWith('vscode_uninstall_complete', { via: 'detail-panel' })
    expect(showInformationMessage).toHaveBeenCalledWith('Uninstalled "example-skill".')
  })

  it('returns false on confirm cancel', async () => {
    showWarningMessage.mockResolvedValue(undefined)

    const ok = await uninstallByTarget(
      { skillId: 'example-skill', skillPath },
      { treeProvider: provider },
      'detail-panel'
    )

    expect(ok).toBe(false)
    expect(mcpUninstall).not.toHaveBeenCalled()
    expect(track).toHaveBeenCalledWith('vscode_uninstall_cancelled', {
      via: 'detail-panel',
      stage: 'confirm',
    })
  })

  it('returns false and refuses when the path is outside the root', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'uninstall-core-outside-'))
    try {
      const evilLink = path.join(tempRoot, 'evil')
      await fs.symlink(outside, evilLink)
      showWarningMessage.mockResolvedValue('Uninstall')

      const ok = await uninstallByTarget(
        { skillId: 'evil', skillPath: evilLink },
        { treeProvider: provider },
        'detail-panel'
      )

      expect(ok).toBe(false)
      expect(mcpUninstall).not.toHaveBeenCalled()
      expect(track).toHaveBeenCalledWith('vscode_uninstall_failed', {
        via: 'detail-panel',
        reason: 'path_outside_root',
      })
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('routes TierDenied to the upgrade UX and returns false', async () => {
    showWarningMessage.mockResolvedValueOnce('Uninstall').mockResolvedValueOnce(undefined)
    mcpUninstall.mockResolvedValue({ success: false, error: 'TierDenied: requires the Team plan' })

    const ok = await uninstallByTarget(
      { skillId: 'example-skill', skillPath },
      { treeProvider: provider },
      'detail-panel'
    )

    expect(ok).toBe(false)
    expect(track).toHaveBeenCalledWith('vscode_uninstall_failed', {
      via: 'detail-panel',
      reason: 'tier_denied',
    })
    await expect(fs.access(skillPath)).resolves.toBeUndefined()
  })

  it('falls back to fs.rm on transport throw and returns true', async () => {
    showWarningMessage.mockResolvedValue('Uninstall')
    mcpUninstall.mockRejectedValue(new Error('ECONNRESET'))

    const ok = await uninstallByTarget(
      { skillId: 'example-skill', skillPath },
      { treeProvider: provider },
      'detail-panel'
    )

    expect(ok).toBe(true)
    await expect(fs.access(skillPath)).rejects.toThrow()
    expect(track).toHaveBeenCalledWith('vscode_uninstall_complete', { via: 'detail-panel' })
  })
})
