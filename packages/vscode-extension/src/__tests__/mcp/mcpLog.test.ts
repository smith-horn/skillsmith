/**
 * Unit tests for src/mcp/mcpLog.ts (SMI-5398).
 *
 * Key coverage:
 *  - logMcp and revealMcpLog are no-ops before setMcpOutputChannel (fail-soft)
 *  - logMcp appends a timestamped line after registration
 *  - revealMcpLog calls show(true) after registration
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// mcpLog.ts uses `import type * as vscode` — no runtime vscode needed.
vi.mock('vscode', () => ({}))

import { setMcpOutputChannel, logMcp, revealMcpLog } from '../../mcp/mcpLog.js'

function makeChannel() {
  return {
    appendLine: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
    append: vi.fn(),
    clear: vi.fn(),
    hide: vi.fn(),
    replace: vi.fn(),
    name: 'Skillsmith MCP',
  }
}

describe('mcpLog before registration', () => {
  it('logMcp does not throw when channel is unset', () => {
    // Module is freshly imported — channel starts undefined.
    expect(() => logMcp('hello')).not.toThrow()
  })

  it('revealMcpLog does not throw when channel is unset', () => {
    expect(() => revealMcpLog()).not.toThrow()
  })
})

describe('mcpLog after registration', () => {
  let channel: ReturnType<typeof makeChannel>

  beforeEach(() => {
    channel = makeChannel()
    setMcpOutputChannel(channel as never)
  })

  it('logMcp calls appendLine with a timestamped line', () => {
    logMcp('test message')
    expect(channel.appendLine).toHaveBeenCalledOnce()
    const [arg] = channel.appendLine.mock.calls[0] ?? []
    expect(typeof arg).toBe('string')
    // ISO timestamp present
    expect(arg).toMatch(/^\[\d{4}-\d{2}-\d{2}T/)
    expect(arg).toContain('test message')
  })

  it('revealMcpLog calls show(true)', () => {
    revealMcpLog()
    expect(channel.show).toHaveBeenCalledWith(true)
  })
})
