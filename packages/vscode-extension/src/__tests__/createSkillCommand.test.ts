import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

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
  commands: { registerCommand },
  env: {
    clipboard: { writeText: clipboardWrite },
    openExternal,
  },
  Uri: {
    file: (s: string) => ({ toString: () => s }),
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
    expect(showInformationMessage).toHaveBeenCalledWith('Created skill "my-skill".')
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
    expect(showInformationMessage).toHaveBeenCalledWith('Created skill "my-skill".')
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
})
