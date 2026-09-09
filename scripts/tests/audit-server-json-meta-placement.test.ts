/**
 * Tests for the MCP Registry server.json `_meta` placement validation helper
 * used by scripts/audit-standards.mjs Check 68.
 *
 * Background: the MCP Registry schema (https://static.modelcontextprotocol.io/
 * schemas/2025-12-11/server.schema.json) only PRESERVES the reserved
 * top-level `_meta` key `io.modelcontextprotocol.registry/publisher-provided`
 * (4KB budget) on publish. Anything else under top-level `_meta` is silently
 * dropped — confirmed live: the registry's `versions/latest` for
 * `io.github.smith-horn/skillsmith` returned `_meta: {}` while
 * packages/mcp-server/server.json still had `io.skillsmith/categories` and
 * `io.skillsmith/keywords` sitting directly under top-level `_meta` instead
 * of nested under the reserved key. Check 68 closes that gap by flagging any
 * top-level `_meta` key that isn't the reserved key.
 */
import { describe, expect, it } from 'vitest'

const helpers = (await import('../audit-standards-helpers.mjs')) as {
  MCP_REGISTRY_RESERVED_META_KEY: string
  findServerJsonMetaPlacementViolations: (
    serverJson: Record<string, unknown> | null | undefined
  ) => Array<{ key: string }>
  escapeMetaKeyForMessage: (key: string) => string
}

const {
  MCP_REGISTRY_RESERVED_META_KEY,
  findServerJsonMetaPlacementViolations,
  escapeMetaKeyForMessage,
} = helpers

describe('findServerJsonMetaPlacementViolations', () => {
  it('(1) flags the pre-fix shape — custom keys at top level of _meta', () => {
    const serverJson = {
      name: 'io.github.smith-horn/skillsmith',
      _meta: {
        'io.skillsmith/categories': ['developer-tools', 'ai-agents', 'skill-management'],
        'io.skillsmith/keywords': ['claude-code', 'agent-skills', 'autonomous-agents', 'openclaw'],
      },
    }
    const violations = findServerJsonMetaPlacementViolations(serverJson)
    const keys = violations.map((v) => v.key).sort()
    expect(keys).toEqual(['io.skillsmith/categories', 'io.skillsmith/keywords'])
  })

  it('(2) passes the post-fix shape — custom keys nested under the reserved key', () => {
    const serverJson = {
      name: 'io.github.smith-horn/skillsmith',
      _meta: {
        [MCP_REGISTRY_RESERVED_META_KEY]: {
          'io.skillsmith/categories': ['developer-tools', 'ai-agents', 'skill-management'],
          'io.skillsmith/keywords': [
            'claude-code',
            'agent-skills',
            'autonomous-agents',
            'openclaw',
          ],
        },
      },
    }
    const violations = findServerJsonMetaPlacementViolations(serverJson)
    expect(violations).toHaveLength(0)
  })

  it('(3) passes when _meta is entirely absent', () => {
    const serverJson = {
      name: 'io.github.smith-horn/skillsmith',
    }
    const violations = findServerJsonMetaPlacementViolations(serverJson)
    expect(violations).toHaveLength(0)
  })

  it('(4) passes when _meta is present but empty', () => {
    const serverJson = {
      name: 'io.github.smith-horn/skillsmith',
      _meta: {},
    }
    const violations = findServerJsonMetaPlacementViolations(serverJson)
    expect(violations).toHaveLength(0)
  })

  it('(5) flags exactly one violation for a mix of reserved key + a stray custom key', () => {
    const serverJson = {
      name: 'io.github.smith-horn/skillsmith',
      _meta: {
        [MCP_REGISTRY_RESERVED_META_KEY]: {
          'io.skillsmith/categories': ['developer-tools'],
        },
        'io.skillsmith/keywords': ['claude-code'],
      },
    }
    const violations = findServerJsonMetaPlacementViolations(serverJson)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ key: 'io.skillsmith/keywords' })
  })

  it('(6) returns no violations for null/undefined/non-object input (fail-soft, not a schema validator)', () => {
    expect(findServerJsonMetaPlacementViolations(null)).toHaveLength(0)
    expect(findServerJsonMetaPlacementViolations(undefined)).toHaveLength(0)
    expect(
      findServerJsonMetaPlacementViolations('not-an-object' as unknown as Record<string, unknown>)
    ).toHaveLength(0)
  })

  it('(7) MCP_REGISTRY_RESERVED_META_KEY matches the confirmed registry reserved key', () => {
    expect(MCP_REGISTRY_RESERVED_META_KEY).toBe(
      'io.modelcontextprotocol.registry/publisher-provided'
    )
  })
})

describe('escapeMetaKeyForMessage', () => {
  it('escapes a lone single quote', () => {
    expect(escapeMetaKeyForMessage("io.skillsmith/it's-fine")).toBe("io.skillsmith/it\\'s-fine")
  })

  it('escapes a lone backslash', () => {
    expect(escapeMetaKeyForMessage('io.skillsmith\\key')).toBe('io.skillsmith\\\\key')
  })

  it('escapes backslash-then-quote unambiguously (the CodeQL incomplete-sanitization finding, PR #2783)', () => {
    // A quote-only escape would turn `\'` into `\\'` — indistinguishable from
    // an escaped backslash followed by an UNescaped quote. Escaping the
    // backslash first disambiguates: `\'` -> `\\` -> `\\'` -> (quote step)
    // -> `\\\'`, which is an escaped backslash followed by an escaped quote.
    const key = "foo\\'bar"
    expect(escapeMetaKeyForMessage(key)).toBe("foo\\\\\\'bar")
  })

  it('leaves a key with no special characters unchanged', () => {
    expect(escapeMetaKeyForMessage('io.skillsmith/categories')).toBe('io.skillsmith/categories')
  })

  it('round-trip: the escaped form, once un-escaped in the same order reversed, recovers the original', () => {
    const original = "weird\\'key\\with\\backslashes'and'quotes"
    const escaped = escapeMetaKeyForMessage(original)
    const unescaped = escaped.replace(/\\'/g, "'").replace(/\\\\/g, '\\')
    expect(unescaped).toBe(original)
  })
})
