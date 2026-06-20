/**
 * SMI-5327: regression guard for the Zod strip boundary.
 *
 * ApiSearchResultSchema is a `z.object` (strip-by-default). `license` is surfaced
 * by skills-get / skills-search (SMI-5320) but is silently dropped before the MCP
 * `search` / `get_skill` tools can read it unless declared in the schema — which
 * would make the license display a permanent "Unknown". This test fails the moment
 * `license` is removed from the schema. Mirrors schemas.compatibility.test.ts.
 */

import { describe, it, expect } from 'vitest'
import { ApiSearchResultSchema } from './schemas.js'

describe('ApiSearchResultSchema — license passthrough (SMI-5327)', () => {
  it('retains an SPDX license string through parse (not stripped)', () => {
    const parsed = ApiSearchResultSchema.parse({
      id: 'acme/skill',
      name: 'skill',
      description: 'desc',
      author: 'acme',
      quality_score: 0.9,
      trust_tier: 'verified',
      tags: ['testing'],
      license: 'MIT',
    })
    expect(parsed.license).toBe('MIT')
  })

  it('retains an explicit null license through parse (null = unknown, not dropped)', () => {
    const parsed = ApiSearchResultSchema.parse({
      id: 'acme/skill',
      name: 'skill',
      description: 'desc',
      author: 'acme',
      quality_score: 0.9,
      trust_tier: 'verified',
      tags: ['testing'],
      license: null,
    })
    expect(parsed.license).toBeNull()
  })

  it('is optional — absent license parses without error', () => {
    const parsed = ApiSearchResultSchema.parse({
      id: 'acme/skill',
      name: 'skill',
      description: null,
      author: null,
      quality_score: null,
      tags: [],
    })
    expect(parsed.license).toBeUndefined()
  })
})
