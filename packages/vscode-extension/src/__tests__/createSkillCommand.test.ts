import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

/**
 * Drain the microtask/macrotask queues so the fire-and-forget
 * `void showPostCreateChecklist(...)` (two sequential awaits) fully settles
 * before assertions. Two `setImmediate` ticks make the guarantee independent
 * of how the vscode mocks resolve (microtask vs macrotask).
 */
const flushAsync = (): Promise<void> =>
  new Promise((resolve) => setImmediate(() => setImmediate(() => resolve())))

const showInputBox = vi.fn()
const showQuickPick = vi.fn()
const showInformationMessage = vi.fn()
const showErrorMessage = vi.fn()
const showWarningMessage = vi.fn()
const createOutputChannel = vi.fn(() => ({
  appendLine: vi.fn(),
  append: vi.fn(),
  show: vi.fn(),
  dispose: vi.fn(),
}))
const openTextDocument = vi.fn()
const showTextDocument = vi.fn()
const clipboardWrite = vi.fn()
const openExternal = vi.fn()
const registerCommand = vi.fn()
const executeCommand = vi.fn()

vi.mock('vscode', () => ({
  window: {
    showInputBox,
    showQuickPick,
    showInformationMessage,
    showErrorMessage,
    showWarningMessage,
    createOutputChannel,
    showTextDocument,
  },
  workspace: { openTextDocument },
  commands: { registerCommand, executeCommand },
  env: {
    clipboard: { writeText: clipboardWrite },
    openExternal,
  },
  Uri: {
    file: (s: string) => ({ toString: () => s, fsPath: s }),
    parse: (s: string) => ({ toString: () => s }),
  },
}))

interface FakeChild extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
}
const spawnMock = vi.fn()
vi.mock('cross-spawn', () => ({ default: spawnMock }))

function makeChild(behavior: 'found' | 'notfound', exitCode = 0): FakeChild {
  const c = new EventEmitter() as FakeChild
  c.stdout = new EventEmitter()
  c.stderr = new EventEmitter()
  queueMicrotask(() => {
    if (behavior === 'notfound') {
      c.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    } else {
      c.emit('exit', exitCode)
    }
  })
  return c
}

const refreshAndWait = vi.fn(async () => {})
vi.mock('../sidebar/SkillTreeDataProvider.js', () => ({
  SkillTreeDataProvider: class {
    refreshAndWait = refreshAndWait
  },
}))

vi.mock('../services/Telemetry.js', () => ({
  track: vi.fn(),
}))

describe('createSkillCommand (SMI-4196)', () => {
  let handler: () => Promise<void>

  beforeEach(async () => {
    showInputBox.mockReset()
    showQuickPick.mockReset()
    showInformationMessage.mockReset()
    showErrorMessage.mockReset()
    showWarningMessage.mockReset()
    openTextDocument.mockReset().mockRejectedValue(new Error('not found'))
    showTextDocument.mockReset()
    clipboardWrite.mockReset()
    openExternal.mockReset()
    registerCommand.mockReset()
    refreshAndWait.mockReset().mockResolvedValue(undefined)
    executeCommand.mockReset()
    spawnMock.mockReset()

    vi.resetModules()
    const { registerCreateSkillCommand } = await import('../commands/createSkillCommand.js')
    const { SkillTreeDataProvider } = await import('../sidebar/SkillTreeDataProvider.js')
    const provider = new SkillTreeDataProvider()
    const context = { subscriptions: [] }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerCreateSkillCommand(context as any, provider as any)
    const call = registerCommand.mock.calls[0]
    if (!call) throw new Error('create command not registered')
    handler = call[1] as () => Promise<void>
  })

  it('surfaces install instructions when CLI is missing', async () => {
    spawnMock.mockImplementationOnce(() => makeChild('notfound'))
    showErrorMessage.mockResolvedValue('Copy install command')

    await handler()

    expect(showErrorMessage).toHaveBeenCalledWith(
      'Skillsmith CLI is not installed.',
      expect.objectContaining({ modal: true }),
      'Copy install command',
      'Open docs'
    )
    expect(clipboardWrite).toHaveBeenCalledWith('npm install -g @skillsmith/cli')
    expect(showInputBox).not.toHaveBeenCalled()
  })

  it('cancels cleanly when wizard dismissed on first step', async () => {
    spawnMock.mockImplementationOnce(() => makeChild('found'))
    showInputBox.mockResolvedValueOnce(undefined)

    await handler()

    expect(showQuickPick).not.toHaveBeenCalled()
    expect(spawnMock).toHaveBeenCalledTimes(1) // only --version check
  })

  it('rejects invalid skill name via validator', async () => {
    spawnMock.mockImplementationOnce(() => makeChild('found'))
    showInputBox
      .mockResolvedValueOnce('author')
      .mockImplementationOnce(
        async (opts: { validateInput?: (v: string) => string | undefined }) => {
          expect(opts.validateInput?.('BadName')).toContain('lowercase')
          return undefined // user cancels after seeing validation
        }
      )

    await handler()

    expect(showQuickPick).not.toHaveBeenCalled()
  })

  it('spawns CLI with correct flag shape on happy path', async () => {
    spawnMock
      .mockImplementationOnce(() => makeChild('found')) // --version
      .mockImplementationOnce(() => makeChild('found', 0)) // create

    openTextDocument.mockResolvedValueOnce({ uri: {} }) // SKILL.md opens successfully
    showInputBox
      .mockResolvedValueOnce('my-author')
      .mockResolvedValueOnce('my-skill')
      .mockResolvedValueOnce('An example skill')
    showQuickPick.mockResolvedValueOnce({ label: 'basic', description: '...' })

    await handler()

    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      'skillsmith',
      ['create', 'my-skill', '-a', 'my-author', '-d', 'An example skill', '--type', 'basic', '-y'],
      expect.any(Object)
    )
    expect(refreshAndWait).toHaveBeenCalled()
    // Flush the fire-and-forget showPostCreateChecklist promise
    await flushAsync()
    expect(showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Created skill "my-skill"'),
      'Open folder',
      'Authoring docs'
    )
    expect(showWarningMessage).not.toHaveBeenCalled()
  })

  it('shows warning toast when SKILL.md cannot be opened after successful create', async () => {
    spawnMock
      .mockImplementationOnce(() => makeChild('found')) // --version
      .mockImplementationOnce(() => makeChild('found', 0)) // create

    // openTextDocument already mocked to reject in beforeEach
    showInputBox
      .mockResolvedValueOnce('my-author')
      .mockResolvedValueOnce('my-skill')
      .mockResolvedValueOnce('An example skill')
    showQuickPick.mockResolvedValueOnce({ label: 'basic', description: '...' })

    await handler()

    expect(refreshAndWait).toHaveBeenCalled()
    // Flush the fire-and-forget showPostCreateChecklist promise
    await flushAsync()
    expect(showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Created skill "my-skill"'),
      'Open folder',
      'Authoring docs'
    )
    expect(showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("couldn't open SKILL.md")
    )
  })

  it('cancels cleanly when wizard dismissed at QuickPick (step 4)', async () => {
    spawnMock.mockImplementationOnce(() => makeChild('found'))
    showInputBox
      .mockResolvedValueOnce('my-author')
      .mockResolvedValueOnce('my-skill')
      .mockResolvedValueOnce('An example skill')
    showQuickPick.mockResolvedValueOnce(undefined) // user pressed Esc

    await handler()

    expect(spawnMock).toHaveBeenCalledTimes(1) // only --version check, no CLI spawn
    expect(showErrorMessage).not.toHaveBeenCalled()
    expect(refreshAndWait).not.toHaveBeenCalled()
  })

  it('reports CLI failure exit code to the user', async () => {
    spawnMock
      .mockImplementationOnce(() => makeChild('found'))
      .mockImplementationOnce(() => makeChild('found', 2))

    showInputBox
      .mockResolvedValueOnce('author')
      .mockResolvedValueOnce('name')
      .mockResolvedValueOnce('desc')
    showQuickPick.mockResolvedValueOnce({ label: 'basic', description: '...' })

    await handler()

    expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('exit 2'))
    expect(refreshAndWait).not.toHaveBeenCalled()
  })

  describe('post-create authoring checklist (GH #1453 / SMI-5312)', () => {
    function setupHappyPath() {
      spawnMock
        .mockImplementationOnce(() => makeChild('found'))
        .mockImplementationOnce(() => makeChild('found', 0))
      openTextDocument.mockResolvedValueOnce({ uri: {} })
      showInputBox
        .mockResolvedValueOnce('my-author')
        .mockResolvedValueOnce('my-skill')
        .mockResolvedValueOnce('An example skill')
      showQuickPick.mockResolvedValueOnce({ label: 'basic', description: '...' })
    }

    it('shows checklist toast with correct message and both button labels after successful create', async () => {
      setupHappyPath()
      showInformationMessage.mockResolvedValue(undefined) // user dismisses

      await handler()
      await flushAsync()

      expect(showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('Created skill "my-skill"'),
        'Open folder',
        'Authoring docs'
      )
    })

    it('opens the skill folder in OS when user picks "Open folder"', async () => {
      const { track } = await import('../services/Telemetry.js')
      setupHappyPath()
      showInformationMessage.mockResolvedValue('Open folder')

      await handler()
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
      setupHappyPath()
      showInformationMessage.mockResolvedValue('Authoring docs')

      await handler()
      await flushAsync()

      expect(openExternal).toHaveBeenCalledWith(
        expect.objectContaining({ toString: expect.any(Function) })
      )
      expect(track).toHaveBeenCalledWith('vscode_create_checklist_action', { action: 'docs' })
      expect(executeCommand).not.toHaveBeenCalled()
    })

    it('takes no action when user dismisses the checklist toast', async () => {
      setupHappyPath()
      showInformationMessage.mockResolvedValue(undefined)

      await handler()
      await flushAsync()

      expect(executeCommand).not.toHaveBeenCalled()
      expect(openExternal).not.toHaveBeenCalled()
    })
  })
})
