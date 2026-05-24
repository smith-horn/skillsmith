/**
 * SMI-5178: regression guard for the Zod strip boundary.
 *
 * ApiSearchResultSchema is a `z.object` (strip-by-default). Any field skills-search
 * hydrates but the schema does not declare is silently dropped before the MCP
 * `search` tool can read it — which would make the compatibility filter / the
 * restrictive cross-tool default a permanent no-op. This test fails the moment
 * `compatibility` is removed from the schema.
 */

import { describe, it, expect } from 'vitest'
import { ApiSearchResultSchema } from './schemas.js'

describe('ApiSearchResultSchema — compatibility passthrough (SMI-5178)', () => {
  it('retains a compatibility array through parse (not stripped)', () => {
    const parsed = ApiSearchResultSchema.parse({
      id: 'acme/skill',
      name: 'skill',
      description: 'desc',
      author: 'acme',
      quality_score: 0.9,
      trust_tier: 'verified',
      tags: ['testing'],
      compatibility: ['claude-code', 'copilot'],
    })
    expect(parsed.compatibility).toEqual(['claude-code', 'copilot'])
  })

  it('is optional — absent compatibility parses without error', () => {
    const parsed = ApiSearchResultSchema.parse({
      id: 'acme/skill',
      name: 'skill',
      description: null,
      author: null,
      quality_score: null,
      tags: [],
    })
    expect(parsed.compatibility).toBeUndefined()
  })
})
