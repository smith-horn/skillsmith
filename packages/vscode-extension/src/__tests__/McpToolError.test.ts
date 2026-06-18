import { describe, it, expect } from 'vitest'
import { McpToolError } from '../mcp/McpToolError.js'

describe('McpToolError (SMI-5288)', () => {
  it('sets name, code, and toolName', () => {
    const err = new McpToolError('search', 'TierDenied', 'requires the Team plan')
    expect(err.name).toBe('McpToolError')
    expect(err.code).toBe('TierDenied')
    expect(err.toolName).toBe('search')
    expect(err.message).toBe('requires the Team plan')
  })

  it('is an instance of Error', () => {
    const err = new McpToolError('get_skill', 'NotConnected', 'MCP client not connected')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(McpToolError)
  })
})
