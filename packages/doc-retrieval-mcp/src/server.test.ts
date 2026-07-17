/**
 * Regression tests for SMI-5718: doc-retrieval-mcp's `jsonSchemaOf()` used
 * to reach directly into zod v3-only internals (`_def.shape` as a callable
 * thunk). When the pinned `zod@3.25.76` dependency went missing (SMI-5452
 * bind-mount npm race) and resolution fell through to a hoisted zod v4,
 * that call threw an opaque `TypeError: schema._def.shape is not a
 * function` on `tools/list` — the literal `/mcp` incident this issue fixes.
 *
 * `jsonSchemaOf()` now delegates to `@modelcontextprotocol/sdk`'s own
 * v3/v4-aware compat layer (`normalizeObjectSchema` + `toJsonSchemaCompat`),
 * the same functions `McpServer.registerTool()` uses internally. These
 * tests were written against the *actual* runtime output of that layer
 * (probed directly, not assumed) — see plan-review changes #3/#4 in
 * docs/internal/implementation/smi-5718-doc-retrieval-mcp-schema-hardening.md
 * for why the original draft of both tests below was wrong.
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { handleListTools, jsonSchemaOf } from './server.js'

describe('handleListTools', () => {
  it('produces well-formed inputSchema for all three tools', async () => {
    const { tools } = await handleListTools()
    expect(tools).toHaveLength(3)

    const byName = Object.fromEntries(
      (tools as Array<{ name: string; inputSchema: Record<string, unknown> }>).map((t) => [
        t.name,
        t.inputSchema,
      ])
    )

    expect(Object.keys(byName)).toEqual(
      expect.arrayContaining(['skill_docs_search', 'skill_docs_reindex', 'skill_docs_status'])
    )

    // skill_docs_search: only `query` is required
    const search = byName.skill_docs_search
    expect(search.type).toBe('object')
    expect(Object.keys(search.properties as object)).toEqual(
      expect.arrayContaining(['query', 'k', 'min_score', 'scope_globs'])
    )
    expect(search.required).toEqual(['query'])

    // skill_docs_reindex: `mode` has a .default(), so nothing is required
    const reindex = byName.skill_docs_reindex
    expect(reindex.type).toBe('object')
    expect(Object.keys(reindex.properties as object)).toEqual(['mode'])
    expect(reindex.required).toBeUndefined()

    // skill_docs_status: z.object({}).strict() — no properties, nothing required
    const status = byName.skill_docs_status
    expect(status.type).toBe('object')
    expect(status.properties).toEqual({})
    expect(status.required).toBeUndefined()
  })
})

describe('jsonSchemaOf', () => {
  it('surfaces load-bearing fields (type, required, enum, describe() prose) unchanged', () => {
    const SearchArgsLike = z.object({
      query: z.string().min(1).describe('Natural-language query over the Skillsmith doc corpus'),
      k: z.number().int().min(1).max(20).optional().describe('Max results to return (default 5)'),
    })
    const out = jsonSchemaOf(SearchArgsLike)
    expect(out.type).toBe('object')
    expect(out.required).toEqual(['query'])
    const props = out.properties as Record<string, Record<string, unknown>>
    expect(props.query.type).toBe('string')
    expect(props.query.description).toBe('Natural-language query over the Skillsmith doc corpus')
    expect(props.k.description).toBe('Max results to return (default 5)')
  })

  it('additionally surfaces constraint fields the old hand-rolled converter silently dropped', () => {
    // This is an intentional, disclosed behavior change from the pre-SMI-5718
    // converter (plan-review change #4) — not a regression to guard against,
    // but a new contract to pin so a future accidental narrowing (e.g.
    // additionalProperties flipping back to permissive) is caught.
    const SearchArgsLike = z.object({
      query: z.string().min(1),
      k: z.number().int().min(1).max(20).optional(),
    })
    const out = jsonSchemaOf(SearchArgsLike)
    const props = out.properties as Record<string, Record<string, unknown>>
    expect(props.k.type).toBe('integer')
    expect(props.k.minimum).toBe(1)
    expect(props.k.maximum).toBe(20)
    expect(out.additionalProperties).toBe(false)
    expect(out.$schema).toBeDefined()
  })

  it('surfaces an enum with its default', () => {
    const ReindexArgsLike = z.object({
      mode: z.enum(['full', 'incremental']).default('incremental'),
    })
    const out = jsonSchemaOf(ReindexArgsLike)
    const props = out.properties as Record<string, Record<string, unknown>>
    expect(props.mode.type).toBe('string')
    expect(props.mode.enum).toEqual(['full', 'incremental'])
    expect(props.mode.default).toBe('incremental')
  })

  it('throws a diagnosable version-drift error for a schema unrecognized by either zod major', () => {
    // Deliberately malformed: neither a valid v3 shape thunk (no callable
    // `_def.shape`) nor a `_zod`-marked v4 instance. This is the shape class
    // that crashed the pre-SMI-5718 code with an opaque native TypeError.
    const malformed = { _def: {} } as unknown as z.ZodType
    expect(() => jsonSchemaOf(malformed)).toThrow(/zod version drift/)
    expect(() => jsonSchemaOf(malformed)).toThrow(/not recognized as a zod v3\/v4 object schema/)
  })

  it('throws a diagnosable error (distinct from the not-recognized case) when a recognized schema fails conversion', () => {
    // Passes normalizeObjectSchema's v4 recognition check (has `_zod.def`
    // with `shape`) but the shape itself is malformed enough that
    // toJsonSchemaCompat's conversion throws — exercises the second
    // fail-loud branch (the `catch` around toJsonSchemaCompat), not the
    // `!obj` branch exercised by the previous test.
    const brokenV4Object = {
      _zod: {
        def: {
          type: 'object',
          shape: { bad: null },
        },
      },
    } as unknown as z.ZodType
    // Assert the branch-distinct message (not just the shared `[doc-retrieval]`
    // tag, which the `!obj` branch's message also contains) — pins this test
    // to the `catch` branch specifically, so a future SDK change that makes
    // `normalizeObjectSchema` reject this stub instead would fail this test
    // rather than silently sliding to the already-covered `!obj` branch.
    expect(() => jsonSchemaOf(brokenV4Object)).toThrow(/failed to convert a recognized zod schema/)
  })
})
