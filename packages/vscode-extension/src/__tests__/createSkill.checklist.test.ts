/**
 * Tests for showPostCreateChecklist (relocated from createSkillCommand.test.ts,
 * SMI-5313 / GH #1454). Import from utils/createSkill.helpers.js — the function
 * moved there when the helpers were extracted for shared use by CreateSkillPanel.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const showInformationMessage = vi.fn()
const executeCommand = vi.fn()
const openExternal = vi.fn()

vi.mock('vscode', () => ({
  window: {
    showInformationMessage,
  },
  commands: { executeCommand },
  env: { openExternal },
  Uri: {
    file: (s: string) => ({ toString: () => s, fsPath: s }),
    parse: (s: string) => ({ toString: () => s }),
  },
}))

vi.mock('../services/Telemetry.js', () => ({
  track: vi.fn(),
}))

/**
 * Drain microtask queue so the fire-and-forget promise fully settles.
 */
const flushAsync = (): Promise<void> =>
  new Promise((resolve) => setImmediate(() => setImmediate(() => resolve())))

describe('showPostCreateChecklist (GH #1453 / SMI-5312)', () => {
  beforeEach(() => {
    showInformationMessage.mockReset()
    executeCommand.mockReset()
    openExternal.mockReset()
    vi.resetModules()
  })

  it('opens the skill folder in OS when user picks "Open folder"', async () => {
    const { track } = await import('../services/Telemetry.js')
    showInformationMessage.mockResolvedValue('Open folder')
    const { showPostCreateChecklist } = await import('../utils/createSkill.helpers.js')

    void showPostCreateChecklist('/home/user/.claude/skills/my-skill', 'my-skill')
    await flushAsync()

    expect(executeCommand).toHaveBeenCalledWith(
      'revealFileInOS',
      expect.objectContaining({ toString: expect.any(Function) })
    )
    expect(track).toHaveBeenCalledWith('vscode_create_checklist_action', {
      action: 'open_folder',
    })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('opens the authoring docs URL when user picks "Authoring docs"', async () => {
    const { track } = await import('../services/Telemetry.js')
    showInformationMessage.mockResolvedValue('Authoring docs')
    const { showPostCreateChecklist } = await import('../utils/createSkill.helpers.js')

    void showPostCreateChecklist('/home/user/.claude/skills/my-skill', 'my-skill')
    await flushAsync()

    expect(openExternal).toHaveBeenCalledWith(
      expect.objectContaining({ toString: expect.any(Function) })
    )
    expect(track).toHaveBeenCalledWith('vscode_create_checklist_action', { action: 'docs' })
    expect(executeCommand).not.toHaveBeenCalled()
  })

  it('swallows errors from executeCommand without unhandled rejection', async () => {
    showInformationMessage.mockResolvedValue('Open folder')
    executeCommand.mockRejectedValue(new Error('Host shutting down'))
    const { showPostCreateChecklist } = await import('../utils/createSkill.helpers.js')

    // Should not throw / cause unhandled rejection
    await expect(
      showPostCreateChecklist('/home/user/.claude/skills/my-skill', 'my-skill')
    ).resolves.toBeUndefined()
  })

  it('takes no action when user dismisses the checklist toast', async () => {
    showInformationMessage.mockResolvedValue(undefined)
    const { showPostCreateChecklist } = await import('../utils/createSkill.helpers.js')

    void showPostCreateChecklist('/home/user/.claude/skills/my-skill', 'my-skill')
    await flushAsync()

    expect(executeCommand).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })
})
