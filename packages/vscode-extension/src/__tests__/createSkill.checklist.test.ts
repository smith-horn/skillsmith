/**
 * Tests for the post-create sidebar section (SMI-5346) and runValidate helper.
 *
 * Replaces the old toast-based showPostCreateChecklist assertions:
 *  - runValidate calls output.show + spawns ['validate'] + writes completion line
 *  - showNextSteps is called on create success (tested via guards test + here)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

// ── cross-spawn mock (top level — hoisted) ───────────────────────────────────
const spawnMock = vi.fn()
vi.mock('cross-spawn', () => ({ default: spawnMock }))

// ── vscode mock ───────────────────────────────────────────────────────────────
vi.mock('vscode', () => ({
  window: {
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
  env: {
    clipboard: { writeText: vi.fn() },
    openExternal: vi.fn(),
  },
  Uri: {
    file: (s: string) => ({ toString: () => s, fsPath: s }),
    parse: (s: string) => ({ toString: () => s }),
  },
}))

// ── Telemetry mock ────────────────────────────────────────────────────────────
vi.mock('../services/Telemetry.js', () => ({
  track: vi.fn(),
}))

// ─────────────────────────────────────────────────────────────────────────────

interface FakeChild extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  kill: () => void
}

function makeCliChild(exitCode: number, chunks?: string[], errorMsg?: string): FakeChild {
  const c = new EventEmitter() as FakeChild
  c.stdout = new EventEmitter()
  c.stderr = new EventEmitter()
  c.kill = vi.fn()
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

describe('runValidate (SMI-5346)', () => {
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
    fakeOutput.show.mockReset()
    vi.resetModules()
  })

  it('calls output.show(true) before spawning', async () => {
    spawnMock.mockImplementationOnce(() => makeCliChild(0))
    const { runValidate } = await import('../utils/createSkill.helpers.js')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runValidate(fakeOutput as any)
    expect(fakeOutput.show).toHaveBeenCalledWith(true)
  })

  it('spawns skillsmith with ["validate"] args (array, injection-safe)', async () => {
    spawnMock.mockImplementationOnce(() => makeCliChild(0))
    const { runValidate } = await import('../utils/createSkill.helpers.js')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runValidate(fakeOutput as any)
    expect(spawnMock).toHaveBeenCalledWith(
      'skillsmith',
      ['validate'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    )
  })

  it('writes a success line on exit 0', async () => {
    spawnMock.mockImplementationOnce(() => makeCliChild(0))
    const { runValidate } = await import('../utils/createSkill.helpers.js')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runValidate(fakeOutput as any)
    expect(fakeOutput.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('completed successfully')
    )
  })

  it('writes a failure line + hint on non-zero exit', async () => {
    spawnMock.mockImplementationOnce(() => makeCliChild(1))
    const { runValidate } = await import('../utils/createSkill.helpers.js')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runValidate(fakeOutput as any)
    const calls = fakeOutput.appendLine.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(calls.some((line) => line.includes('exited with code'))).toBe(true)
  })

  it('writes an error line on spawn error', async () => {
    spawnMock.mockImplementationOnce(() => makeCliChild(0, [], 'ENOENT: spawn failed'))
    const { runValidate } = await import('../utils/createSkill.helpers.js')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runValidate(fakeOutput as any)
    const calls = fakeOutput.appendLine.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(calls.some((line) => line.includes('[error]'))).toBe(true)
  })

  it('streams stdout chunks to the output channel', async () => {
    spawnMock.mockImplementationOnce(() => makeCliChild(0, ['validation output line\n']))
    const { runValidate } = await import('../utils/createSkill.helpers.js')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runValidate(fakeOutput as any)
    expect(fakeOutput.append).toHaveBeenCalledWith(
      expect.stringContaining('validation output line')
    )
  })

  it('on timeout: kills the child and writes ONLY the timeout line (post-kill exit is suppressed)', async () => {
    const { runValidate } = await import('../utils/createSkill.helpers.js')
    vi.useFakeTimers()
    try {
      // A child that never exits on its own — the 30s timeout must fire first.
      const child = new EventEmitter() as FakeChild
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = vi.fn()
      spawnMock.mockImplementationOnce(() => child)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pending = runValidate(fakeOutput as any)
      // Fire the 30s timeout: kill + timeout line + resolve.
      await vi.advanceTimersByTimeAsync(30_000)
      // kill() triggers `exit` on a real process — simulate it. The `settled`
      // guard must suppress a second completion line.
      child.emit('exit', null)
      await pending

      expect(child.kill).toHaveBeenCalled()
      const lines = fakeOutput.appendLine.mock.calls.map((c: unknown[]) => String(c[0]))
      expect(lines.some((l) => l.includes('timed out'))).toBe(true)
      expect(lines.some((l) => l.includes('exited with code'))).toBe(false)
      expect(lines.some((l) => l.includes('completed successfully'))).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
