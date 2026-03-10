/**
 * @fileoverview Unit tests for validateDependencies helper
 * @see SMI-3137: Wave 4 — Surface dependency intelligence
 */

import { describe, it, expect } from 'vitest'
import { validateDependencies } from './validate.helpers.js'

describe('validateDependencies', () => {
  it('returns empty array when no dependencies or MCP refs', () => {
    const errors = validateDependencies({}, 'Just a plain skill body with no MCP calls.')
    expect(errors).toEqual([])
  })

  it('warns on deprecated composes field', () => {
    const metadata = { composes: ['other-skill'] }
    const errors = validateDependencies(metadata, 'Some body content.')

    expect(errors).toHaveLength(1)
    expect(errors[0].field).toBe('composes')
    expect(errors[0].severity).toBe('warning')
    expect(errors[0].message).toContain('deprecated')
    expect(errors[0].message).toContain('dependencies.skills')
  })

  it('detects high-confidence MCP references in prose', () => {
    const body = `
# My Skill

This skill uses mcp__linear__save_issue to create issues
and mcp__linear__list_issues to query them.
`
    const errors = validateDependencies({}, body)

    expect(errors).toHaveLength(1)
    expect(errors[0].field).toBe('dependencies')
    expect(errors[0].severity).toBe('warning')
    expect(errors[0].message).toContain("'linear'")
    expect(errors[0].message).toContain('dependencies.platform.mcp_servers')
  })

  it('does not warn on MCP references inside code blocks', () => {
    const body = `
# My Skill

Here is an example:

\`\`\`bash
mcp__linear__save_issue
\`\`\`
`
    const errors = validateDependencies({}, body)

    // Code-block-only references are not high-confidence
    expect(errors).toEqual([])
  })

  it('detects multiple high-confidence MCP servers', () => {
    const body = `
Use mcp__linear__save_issue for issues.
Use mcp__slack__send_message for notifications.
`
    const errors = validateDependencies({}, body)

    expect(errors).toHaveLength(2)
    const servers = errors.map((e) => e.message)
    expect(servers.some((m) => m.includes("'linear'"))).toBe(true)
    expect(servers.some((m) => m.includes("'slack'"))).toBe(true)
  })

  it('combines composes warning with MCP ref warnings', () => {
    const metadata = { composes: ['other-skill'] }
    const body = 'Use mcp__github__create_issue for tracking.'

    const errors = validateDependencies(metadata, body)

    expect(errors).toHaveLength(2)
    expect(errors[0].field).toBe('composes')
    expect(errors[1].field).toBe('dependencies')
  })

  it('handles empty body gracefully', () => {
    const errors = validateDependencies({}, '')
    expect(errors).toEqual([])
  })

  it('handles empty metadata gracefully', () => {
    const errors = validateDependencies({}, 'No MCP refs here.')
    expect(errors).toEqual([])
  })
})
