/**
 * Tests for mapToolErrorToUserMessage (SMI-5401).
 *
 * In a separate file from skill-panel-html.test.ts because that file is
 * already at 489 lines (just under the 500-line audit:standards gate). This
 * follows the existing split pattern used for skill-panel-advisories.test.ts,
 * skill-panel-security.test.ts, etc.
 *
 * Key assertion: "Skillsmith server unavailable" appears ONLY for NotConnected
 * (i.e. a true transport outage), never for connected tool-level errors.
 */
import { describe, it, expect } from 'vitest'
import { mapToolErrorToUserMessage } from '../views/skill-panel-html.js'
import { McpToolError } from '../mcp/McpToolError.js'

describe('mapToolErrorToUserMessage (SMI-5401)', () => {
  it('NotConnected → the full "server unavailable" connection message', () => {
    const err = new McpToolError('get_skill', 'NotConnected', 'Skillsmith server unavailable')
    expect(mapToolErrorToUserMessage(err)).toBe(
      'Skillsmith server unavailable. Check that the MCP server is running.'
    )
  })

  it('SkillNotFound → "not in the registry" message', () => {
    const err = new McpToolError(
      'get_skill',
      'SkillNotFound',
      'Error: Invalid skill ID format: "ci-doctor". Use owner/repo or GitHub URL.'
    )
    expect(mapToolErrorToUserMessage(err)).toBe("This skill isn't in the registry.")
  })

  it('Unknown → returns the error\'s own .message (the real cause, not "server unavailable")', () => {
    const err = new McpToolError('get_skill', 'Unknown', 'network error')
    const msg = mapToolErrorToUserMessage(err)

    expect(msg).toBe('network error')
    // "server unavailable" must not bleed into connected tool errors (SMI-5401 bug fix).
    expect(msg).not.toContain('server unavailable')
  })

  it("TierDenied → returns the error's own .message (falls through to default branch)", () => {
    const err = new McpToolError('get_skill', 'TierDenied', 'requires the Team plan')
    expect(mapToolErrorToUserMessage(err)).toBe('requires the Team plan')
  })

  it("UnknownTool → returns the error's own .message", () => {
    const err = new McpToolError('get_skill', 'UnknownTool', 'Tool not registered')
    expect(mapToolErrorToUserMessage(err)).toBe('Tool not registered')
  })

  it("InvalidResponse → returns the error's own .message", () => {
    const err = new McpToolError('get_skill', 'InvalidResponse', 'Unexpected JSON structure')
    expect(mapToolErrorToUserMessage(err)).toBe('Unexpected JSON structure')
  })
})
