/**
 * Unit tests for utils/createSkill.helpers.ts (SMI-5313 / GH #1454).
 *
 * Tests ensureCliAvailable, runCli (with onChunk), exists, buildCreateArgs,
 * and targetDirFor.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import * as os from 'node:os'
import * as path from 'node:path'

const showErrorMessage = vi.fn()
const showInformationMessage = vi.fn()
const clipboardWrite = vi.fn()
const openExternal = vi.fn()

vi.mock('vscode', () => ({
  window: {
    showErrorMessage,
    showInformationMessage,
  },
  env: {
    clipboard: { writeText: clipboardWrite },
    openExternal,
  },
  Uri: {
    file: (s: string) => ({ toString: () => s, fsPath: s }),
    parse: (s: string) => ({ toString: () => s }),
  },
}))

vi.mock('../services/Telemetry.js', () => ({
  track: vi.fn(),
}))

interface FakeChild extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
}

const spawnMock = vi.fn()
vi.mock('cross-spawn', () => ({ default: spawnMock }))

function makeVersionChild(behavior: 'found' | 'notfound'): FakeChild {
  const c = new EventEmitter() as FakeChild
  c.stdout = new EventEmitter()
  c.stderr = new EventEmitter()
  queueMicrotask(() => {
    if (behavior === 'notfound') {
      c.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    } else {
      c.emit('exit', 0)
    }
  })
  return c
}

function makeCliChild(exitCode: number, chunks?: string[], errorMsg?: string): FakeChild {
  const c = new EventEmitter() as FakeChild
  c.stdout = new EventEmitter()
  c.stderr = new EventEmitter()
  queueMicrotask(() => {
    if (errorMsg) {
      c.emit('error', new Error(errorMsg))
    } else {
      if (chunks) {
        for (const chunk of chunks) {
          c.stdout.emit('data', Buffer.from(chunk, 'utf8'))
        }
      }
      c.emit('exit', exitCode)
    }
  })
  return c
}

describe('ensureCliAvailable', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    showErrorMessage.mockReset()
    clipboardWrite.mockReset()
    openExternal.mockReset()
    showInformationMessage.mockReset()
    vi.resetModules()
  })

  it('returns true when skillsmith --version exits 0', async () => {
    spawnMock.mockImplementationOnce(() => makeVersionChild('found'))
    const { ensureCliAvailable } = await import('../utils/createSkill.helpers.js')

    const result = await ensureCliAvailable()

    expect(result).toBe(true)
    expect(showErrorMessage).not.toHaveBeenCalled()
  })

  it('returns false and shows modal when CLI is not found', async () => {
    spawnMock.mockImplementationOnce(() => makeVersionChild('notfound'))
    showErrorMessage.mockResolvedValue(undefined)
    const { ensureCliAvailable } = await import('../utils/createSkill.helpers.js')

    const result = await ensureCliAvailable()

    expect(result).toBe(false)
    expect(showErrorMessage).toHaveBeenCalledWith(
      'Skillsmith CLI is not installed.',
      expect.objectContaining({ modal: true }),
      'Copy install command',
      'Open docs'
    )
  })

  it('copies the install command when user picks "Copy install command"', async () => {
    spawnMock.mockImplementationOnce(() => makeVersionChild('notfound'))
    showErrorMessage.mockResolvedValue('Copy install command')
    const { ensureCliAvailable } = await import('../utils/createSkill.helpers.js')

    await ensureCliAvailable()

    expect(clipboardWrite).toHaveBeenCalledWith('npm install -g @skillsmith/cli')
  })

  it('opens docs when user picks "Open docs"', async () => {
    spawnMock.mockImplementationOnce(() => makeVersionChild('notfound'))
    showErrorMessage.mockResolvedValue('Open docs')
    const { ensureCliAvailable } = await import('../utils/createSkill.helpers.js')

    await ensureCliAvailable()

    expect(openExternal).toHaveBeenCalledWith(
      expect.objectContaining({ toString: expect.any(Function) })
    )
  })
})

describe('runCli', () => {
  const fakeOutput = {
    append: vi.fn(),
    appendLine: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  }

  beforeEach(() => {
    spawnMock.mockReset()
    fakeOutput.append.mockReset()
    fakeOutput.appendLine.mockReset()
    vi.resetModules()
  })

  it('resolves with exit code 0 on success', async () => {
    spawnMock.mockImplementationOnce(() => makeCliChild(0))
    const { runCli } = await import('../utils/createSkill.helpers.js')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const code = await runCli(['create', 'my-skill', '-y'], fakeOutput as any)

    expect(code).toBe(0)
  })

  it('resolves with exit code 2 on failure', async () => {
    spawnMock.mockImplementationOnce(() => makeCliChild(2))
    const { runCli } = await import('../utils/createSkill.helpers.js')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const code = await runCli(['create', 'bad-name', '-y'], fakeOutput as any)

    expect(code).toBe(2)
  })

  it('fires onChunk callback for each stdout chunk', async () => {
    spawnMock.mockImplementationOnce(() => makeCliChild(0, ['chunk1', 'chunk2']))
    const { runCli } = await import('../utils/createSkill.helpers.js')
    const chunks: string[] = []

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runCli(['create', 'test', '-y'], fakeOutput as any, (c) => chunks.push(c))

    expect(chunks).toContain('chunk1')
    expect(chunks).toContain('chunk2')
  })

  it('resolves with exit code 1 on spawn error', async () => {
    spawnMock.mockImplementationOnce(() => makeCliChild(0, [], 'ENOENT: spawn error'))
    const { runCli } = await import('../utils/createSkill.helpers.js')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const code = await runCli(['create', 'test', '-y'], fakeOutput as any)

    expect(code).toBe(1)
  })

  it('appends output to the OutputChannel', async () => {
    spawnMock.mockImplementationOnce(() => makeCliChild(0, ['hello from cli']))
    const { runCli } = await import('../utils/createSkill.helpers.js')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runCli(['create', 'test', '-y'], fakeOutput as any)

    expect(fakeOutput.append).toHaveBeenCalledWith(expect.stringContaining('hello from cli'))
  })
})

describe('exists', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('returns true for the OS temp dir (always exists)', async () => {
    const { exists } = await import('../utils/createSkill.helpers.js')
    const result = await exists(os.tmpdir())
    expect(result).toBe(true)
  })

  it('returns false for a non-existent path', async () => {
    const { exists } = await import('../utils/createSkill.helpers.js')
    const result = await exists(path.join(os.tmpdir(), `nonexistent-${Date.now()}`))
    expect(result).toBe(false)
  })
})

describe('buildCreateArgs', () => {
  it('returns exact CLI arg shape matching the old runWizard intent', async () => {
    const { buildCreateArgs } = await import('../utils/createSkill.helpers.js')
    const args = buildCreateArgs({
      author: 'my-author',
      name: 'my-skill',
      description: 'An example skill',
      type: 'basic',
    })

    expect(args).toEqual([
      'create',
      'my-skill',
      '-a',
      'my-author',
      '-d',
      'An example skill',
      '--type',
      'basic',
      '-y',
    ])
  })

  it('preserves intermediate type in args', async () => {
    const { buildCreateArgs } = await import('../utils/createSkill.helpers.js')
    const args = buildCreateArgs({
      author: 'a',
      name: 'n',
      description: 'd',
      type: 'intermediate',
    })
    expect(args).toContain('intermediate')
    expect(args[args.indexOf('--type') + 1]).toBe('intermediate')
  })
})

describe('targetDirFor', () => {
  it('returns path under ~/.claude/skills/<name>', async () => {
    const { targetDirFor } = await import('../utils/createSkill.helpers.js')
    const dir = targetDirFor('my-skill')
    expect(dir).toBe(path.join(os.homedir(), '.claude', 'skills', 'my-skill'))
  })
})
