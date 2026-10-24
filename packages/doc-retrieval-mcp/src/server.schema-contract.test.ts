/**
 * SMI-7168 Wave 0: wire-contract baseline for doc-retrieval-mcp's `tools/list`.
 *
 * `__fixtures__/tool-input-schemas.zod3.json` holds the three `inputSchema`
 * objects exactly as `handleListTools()` emitted them on zod 3.25.76 (via the
 * SDK's `zod-to-json-schema` path), BEFORE the zod 4 migration. This test
 * compares the live output against that fixture with `toEqual`, which is
 * key-order-insensitive but value-exact: zero allowlisted differences.
 *
 * The property being pinned is what MCP clients receive, not how the schema is
 * produced. The case that motivated it: zod 4's `z.toJSONSchema` in `input`
 * mode omits `additionalProperties: false` unless told otherwise, so a
 * converter swap silently turns a closed object into an open one.
 */
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { handleListTools } from './server.js'

type ListedTool = { name: string; inputSchema: Record<string, unknown> }

const fixture = JSON.parse(
  readFileSync(new URL('./__fixtures__/tool-input-schemas.zod3.json', import.meta.url), 'utf8')
) as Record<string, Record<string, unknown>>

describe('doc-retrieval tools/list wire contract (zod 3 baseline)', () => {
  it('lists exactly the baselined tools', async () => {
    const { tools } = (await handleListTools()) as { tools: ListedTool[] }
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(fixture).sort())
  })

  it.each(Object.keys(fixture))('%s inputSchema equals the zod 3 baseline', async (name) => {
    const { tools } = (await handleListTools()) as { tools: ListedTool[] }
    const tool = tools.find((t) => t.name === name)
    expect(tool).toBeDefined()
    expect(tool?.inputSchema).toEqual(fixture[name])
  })

  it('closed-object property holds on every tool (additionalProperties === false)', async () => {
    const { tools } = (await handleListTools()) as { tools: ListedTool[] }
    for (const tool of tools) {
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false)
    }
  })
})
