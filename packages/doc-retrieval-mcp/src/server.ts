#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { search } from './search.js'
import { runIndexer } from './indexer.js'
import { getStatus } from './status.js'

const SearchArgs = z.object({
  query: z.string().min(1).describe('Natural-language query over the Skillsmith doc corpus'),
  k: z.number().int().min(1).max(20).optional().describe('Max results to return (default 5)'),
  min_score: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      'Minimum cosine similarity. Default 0.30. <0.25=noise, 0.25-0.40=weak, 0.40-0.60=loose, 0.60-0.80=strong, >0.80=near-duplicate'
    ),
  scope_globs: z
    .array(z.string())
    .optional()
    .describe(
      'Optional list of POSIX-style globs to restrict results (e.g. ["docs/internal/adr/**", ".claude/**"]).'
    ),
})

const ReindexArgs = z.object({
  mode: z
    .enum(['full', 'incremental'])
    .default('incremental')
    .describe('full rebuilds from scratch; incremental uses git diff since last run'),
})

const StatusArgs = z.object({}).strict()

async function handleListTools(): Promise<{ tools: unknown[] }> {
  return {
    tools: [
      {
        name: 'skill_docs_search',
        description:
          'Semantic search over the Skillsmith doc corpus (CLAUDE.md, .claude/development, .claude/skills, docs/internal). Returns top-k chunks with file:line citations. Use this INSTEAD of Read-ing whole docs to answer narrow questions.',
        inputSchema: jsonSchemaOf(SearchArgs),
      },
      {
        name: 'skill_docs_reindex',
        description:
          'Rebuild or refresh the local .ruvector/skillsmith-docs.rvf index. Fails in CI. Fails if the docs/internal submodule is uninitialized.',
        inputSchema: jsonSchemaOf(ReindexArgs),
      },
      {
        name: 'skill_docs_status',
        description:
          'Report chunk count, file count, last-indexed SHA, and last run time for the local corpus index.',
        inputSchema: jsonSchemaOf(StatusArgs),
      },
    ],
  }
}

type CallToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

async function handleCallTool(req: {
  params: { name: string; arguments?: Record<string, unknown> }
}): Promise<CallToolResult> {
  const { name, arguments: args } = req.params
  try {
    if (name === 'skill_docs_search') {
      const parsed = SearchArgs.parse(args ?? {})
      const hits = await search({
        query: parsed.query,
        k: parsed.k,
        minScore: parsed.min_score,
        scopeGlobs: parsed.scope_globs,
      })
      return toolJson({ chunks: hits })
    }
    if (name === 'skill_docs_reindex') {
      const parsed = ReindexArgs.parse(args ?? {})
      const result = await runIndexer(parsed.mode, { quiet: true })
      return toolJson(result)
    }
    if (name === 'skill_docs_status') {
      const status = await getStatus()
      return toolJson(status)
    }
    return toolError(`Unknown tool: ${name}`)
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err))
  }
}

function toolJson(obj: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] }
}

function toolError(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  }
}

function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  // Minimal hand-rolled shape — @modelcontextprotocol/sdk tools consume a subset
  // of JSON Schema, so we mirror the zod shape without pulling zod-to-json-schema.
  const shape = (
    schema as unknown as { _def: { shape?: () => Record<string, z.ZodType> } }
  )._def.shape?.()
  if (!shape) return { type: 'object', properties: {}, additionalProperties: true }
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, val] of Object.entries(shape)) {
    properties[key] = zodToJson(val)
    if (!(val as z.ZodType).isOptional()) required.push(key)
  }
  const out: Record<string, unknown> = { type: 'object', properties }
  if (required.length > 0) out.required = required
  return out
}

function zodToJson(z: z.ZodType): Record<string, unknown> {
  const def = (z as unknown as { _def: { typeName: string; description?: string } })._def
  const base: Record<string, unknown> = {}
  if (def.description) base.description = def.description
  switch (def.typeName) {
    case 'ZodString':
      return { type: 'string', ...base }
    case 'ZodNumber':
      return { type: 'number', ...base }
    case 'ZodBoolean':
      return { type: 'boolean', ...base }
    case 'ZodArray':
      return {
        type: 'array',
        items: zodToJson((z as unknown as { _def: { type: z.ZodType } })._def.type),
        ...base,
      }
    case 'ZodEnum':
      return {
        type: 'string',
        enum: (z as unknown as { _def: { values: readonly string[] } })._def.values,
        ...base,
      }
    case 'ZodOptional':
    case 'ZodDefault':
      return zodToJson((z as unknown as { _def: { innerType: z.ZodType } })._def.innerType)
    default:
      return base
  }
}

async function main(): Promise<void> {
  const server = new Server(
    { name: 'skillsmith-doc-retrieval', version: '0.0.1' },
    { capabilities: { tools: {} } }
  )
  server.setRequestHandler(ListToolsRequestSchema, handleListTools)
  server.setRequestHandler(CallToolRequestSchema, handleCallTool)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error('[doc-retrieval] fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
