/**
 * Regression tests for SMI-5718 (and SMI-7168): doc-retrieval-mcp's
 * `jsonSchemaOf()` used to reach directly into zod v3-only internals
 * (`_def.shape` as a callable thunk). When the pinned zod dependency went
 * missing (SMI-5452 bind-mount npm race) and resolution fell through to a
 * different zod major, that call threw an opaque `TypeError: schema._def.shape
 * is not a function` on `tools/list` — the literal `/mcp` incident SMI-5718
 * fixes.
 *
 * SMI-7168 moved the repo to a single zod major (4.x). `jsonSchemaOf()` now
 * converts with zod's own `z.toJSONSchema` (input mode, with an override that
 * keeps `additionalProperties: false`) and keeps both fail-loud branches: a
 * schema that is not a zod 4 object schema (major drift), and a recognised
 * schema that will not convert. The exact wire output for the three real tools
 * is pinned separately in server.schema-contract.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { z as z3 } from 'zod/v3'
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
    // Constraint fields and a closed object are part of the wire contract.
    // Pin them so a future accidental narrowing (e.g. additionalProperties
    // flipping back to permissive, which zod 4's input mode does by default)
    // is caught.
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

  it('throws a diagnosable version-drift error for a schema that is not a zod 4 object schema', () => {
    // Deliberately malformed: no `_zod` internals at all. This is the shape
    // class that crashed the pre-SMI-5718 code with an opaque native TypeError.
    const malformed = { _def: {} } as never
    expect(() => jsonSchemaOf(malformed)).toThrow(/zod version drift/)
    expect(() => jsonSchemaOf(malformed)).toThrow(/not recognized as a zod v4 object schema/)
  })

  it('treats a real zod 3 schema instance as drift, not as something to convert', () => {
    // The actual incident shape after SMI-7168: a zod 3 install resolving
    // where zod 4 is declared. `zod/v3` ships a genuine zod 3 schema, which
    // carries `_def` but no `_zod`. Without the guard, z.toJSONSchema would
    // throw an unlabeled "Cannot read properties of undefined (reading 'def')".
    const v3Schema = z3.object({ query: z3.string() }) as never
    expect(() => jsonSchemaOf(v3Schema)).toThrow(/not recognized as a zod v4 object schema/)
    expect(() => jsonSchemaOf(v3Schema)).toThrow(/zod version drift/)
  })

  it('throws a diagnosable error (distinct from the not-recognized case) when a recognized schema fails conversion', () => {
    // Passes the recognition guard (a `_zod.def` of type object) but the shape
    // itself is malformed enough that z.toJSONSchema throws — exercises the
    // second fail-loud branch (the `catch`), not the not-recognized guard.
    const brokenV4Object = {
      _zod: {
        def: {
          type: 'object',
          shape: { bad: null },
        },
      },
    } as never
    // Assert the branch-distinct message (not just the shared `[doc-retrieval]`
    // tag, which the not-recognized branch's message also contains) — pins this
    // test to the `catch` branch specifically, so a future change that makes
    // the guard reject this stub instead would fail this test rather than
    // silently sliding to the already-covered not-recognized branch.
    expect(() => jsonSchemaOf(brokenV4Object)).toThrow(/failed to convert a recognized zod schema/)
  })

  it('names the cause when a genuine zod 4 schema holds a type JSON Schema cannot represent', () => {
    // A real, non-stubbed trigger for the conversion-failure branch: z.date()
    // has no JSON Schema form and z.toJSONSchema throws on it by default.
    const unrepresentable = z.object({ when: z.date() })
    expect(() => jsonSchemaOf(unrepresentable)).toThrow(/failed to convert a recognized zod schema/)
    expect(() => jsonSchemaOf(unrepresentable)).toThrow(/cannot be represented in JSON Schema/)
  })

  it('fails closed on a top-level schema that is not an object (z.string)', () => {
    // A tool's arguments are an object. A string schema must not be converted
    // into a free-form schema that silently accepts anything.
    expect(() => jsonSchemaOf(z.string() as never)).toThrow(
      /not recognized as a zod v4 object schema/
    )
    expect(() => jsonSchemaOf(z.string() as never)).toThrow(/\[doc-retrieval\] jsonSchemaOf/)
  })

  it('fails closed on a top-level union and on a wrapped object', () => {
    const union = z.union([z.object({ a: z.string() }), z.object({ b: z.number() })])
    expect(() => jsonSchemaOf(union as never)).toThrow(/not recognized as a zod v4 object schema/)
    expect(() => jsonSchemaOf(z.object({ a: z.string() }).optional() as never)).toThrow(
      /not recognized as a zod v4 object schema/
    )
  })

  it('keeps a nested object closed as well as the top level', () => {
    const out = jsonSchemaOf(z.object({ inner: z.object({ a: z.string() }) }))
    const inner = (out.properties as Record<string, Record<string, unknown>>).inner
    expect(out.additionalProperties).toBe(false)
    expect(inner.additionalProperties).toBe(false)
  })

  it('keeps every object branch of a union closed', () => {
    const out = jsonSchemaOf(
      z.object({ u: z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]) })
    )
    const branches = (out.properties as Record<string, { anyOf: Array<Record<string, unknown>> }>).u
      .anyOf
    expect(branches).toHaveLength(2)
    for (const branch of branches) expect(branch.additionalProperties).toBe(false)
  })

  it('does not reopen an object that already declared itself open', () => {
    // The override only fills a MISSING additionalProperties; it must not overwrite one that zod set.
    const out = jsonSchemaOf(z.object({ a: z.string() }).catchall(z.number()))
    expect(out.additionalProperties).toEqual({ type: 'number' })
  })

  it('both remediation messages route through the mount gate, not a bare npm mutation (SMI-6654)', () => {
    // SMI-6654 Wave 2 collapsed each two-line `docker exec ... rm -rf ...` /
    // `docker exec ... npm install` remediation pair into one gated
    // `sh -c "gate && rm -rf ... && npm install"` line (A27s shape) so this
    // file's own printed remediation text doesn't itself trip audit:standards
    // Check 72. Pin the printed command to the gate script so a future edit
    // can't silently drop it back to an ungated form.
    const malformed = { _def: {} } as never
    expect(() => jsonSchemaOf(malformed)).toThrow(/node-modules-mount-gate\.sh/)

    const brokenV4Object = {
      _zod: { def: { type: 'object', shape: { bad: null } } },
    } as never
    expect(() => jsonSchemaOf(brokenV4Object)).toThrow(/node-modules-mount-gate\.sh/)
  })
})
