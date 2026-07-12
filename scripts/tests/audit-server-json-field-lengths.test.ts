/**
 * Tests for the MCP Registry server.json field-length validation helper used
 * by scripts/audit-standards.mjs Check 53 (SMI-5651).
 *
 * Background: packages/mcp-server/server.json's `description` field grew to
 * 153 characters across several rebrand passes — the MCP Registry rejects
 * any publish where `description` exceeds 100 chars (confirmed via a live
 * 422 response: "expected length <= 100"). Nothing validated this before it
 * shipped, silently blocking every registry publish. Check 53 closes that
 * gap by validating server.json's length-limited fields against the schema
 * referenced by its own `$schema` URL
 * (https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json).
 */
import { describe, expect, it } from 'vitest'

const helpers = (await import('../audit-standards-helpers.mjs')) as {
  MCP_REGISTRY_FIELD_LIMITS: Readonly<Record<string, number>>
  findServerJsonFieldLengthViolations: (
    serverJson: Record<string, unknown> | null | undefined,
    limits?: Record<string, number>
  ) => Array<{ field: string; length: number; limit: number }>
}

const { MCP_REGISTRY_FIELD_LIMITS, findServerJsonFieldLengthViolations } = helpers

describe('findServerJsonFieldLengthViolations (SMI-5651)', () => {
  it('(1) flags the pre-fix 153-char description (the actual SMI-5651 regression)', () => {
    const overLengthDescription =
      'Discover, install, and manage agent skills via MCP — 14,000+ curated skills for any MCP-compatible agent (Claude Code, Cursor, Copilot, Codex, Windsurf).'
    expect(overLengthDescription.length).toBeGreaterThan(100)

    const serverJson = {
      name: 'io.github.smith-horn/skillsmith',
      title: 'Skillsmith',
      description: overLengthDescription,
      version: '0.7.1',
    }
    const violations = findServerJsonFieldLengthViolations(serverJson)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({
      field: 'description',
      length: overLengthDescription.length,
      limit: 100,
    })
  })

  it('(2) passes the current (post-Wave-1 fix) server.json description', () => {
    const fixedDescription =
      'Discover, install, and manage 14,000+ curated agent skills for any MCP-compatible agent.'
    expect(fixedDescription.length).toBeLessThanOrEqual(100)

    const serverJson = {
      name: 'io.github.smith-horn/skillsmith',
      title: 'Skillsmith',
      description: fixedDescription,
      version: '0.7.1',
      packages: [{ registryType: 'npm', identifier: '@skillsmith/mcp-server', version: '0.7.1' }],
    }
    const violations = findServerJsonFieldLengthViolations(serverJson)
    expect(violations).toHaveLength(0)
  })

  it('(3) flags an over-length title and name independently of description', () => {
    const serverJson = {
      name: 'x'.repeat(201),
      title: 'y'.repeat(101),
      description: 'fine',
      version: '0.1.0',
    }
    const violations = findServerJsonFieldLengthViolations(serverJson)
    const fields = violations.map((v) => v.field).sort()
    expect(fields).toEqual(['name', 'title'])
  })

  it('(4) flags an over-length packages[].version and icons[].src', () => {
    const serverJson = {
      name: 'io.github.smith-horn/skillsmith',
      title: 'Skillsmith',
      description: 'fine',
      version: '0.7.1',
      packages: [
        { registryType: 'npm', identifier: '@skillsmith/mcp-server', version: 'v'.repeat(256) },
      ],
      icons: [{ src: 'https://example.com/' + 'a'.repeat(256) + '.png' }],
    }
    const violations = findServerJsonFieldLengthViolations(serverJson)
    const fields = violations.map((v) => v.field).sort()
    expect(fields).toEqual(['icons[0].src', 'packages[0].version'])
  })

  it('(5) returns no violations for null/undefined/non-object input (fail-soft, not a schema validator)', () => {
    expect(findServerJsonFieldLengthViolations(null)).toHaveLength(0)
    expect(findServerJsonFieldLengthViolations(undefined)).toHaveLength(0)
    expect(
      findServerJsonFieldLengthViolations('not-an-object' as unknown as Record<string, unknown>)
    ).toHaveLength(0)
  })

  it('(6) MCP_REGISTRY_FIELD_LIMITS matches the confirmed registry schema limits', () => {
    expect(MCP_REGISTRY_FIELD_LIMITS).toMatchObject({
      description: 100,
      title: 100,
      name: 200,
      version: 255,
      iconSrc: 255,
    })
  })
})
