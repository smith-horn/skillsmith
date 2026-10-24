#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { pathToFileURL } from 'node:url'
import { probeEmbeddingCapability } from '@skillsmith/core/embeddings/probe'
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
      'Minimum cosine similarity (post distance→similarity transform). Default 0.35. <0.20=noise, 0.20-0.35=weak, 0.35-0.55=loose, 0.55-0.75=strong, >0.75=near-duplicate'
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

export async function handleListTools(): Promise<{ tools: unknown[] }> {
  return {
    tools: [
      {
        name: 'skill_docs_search',
        description:
          "PREFERRED first step for any question about the Skillsmith repo's internal docs " +
          '(CLAUDE.md, .claude/development, docs/internal — ADRs, retros, plans, ' +
          'standards, implementation guides). Returns cited chunks with file:line — much cheaper ' +
          'than Read+Grep over the same corpus. Examples: "git-crypt worktree workflow", ' +
          '"file-length limits", "plan-review anti-patterns", "SMI-4434 decisions". ' +
          'Use Read/Grep/Glob ONLY when you need actual source code or non-indexed files.',
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

// SMI-5718 replaced a hand-rolled converter that reached into zod v3-only
// internals (`_def.shape` as a callable thunk). When the pinned zod went
// missing (SMI-5452 bind-mount npm race) and resolution fell through to a
// different zod major, that internal shape no longer existed and `tools/list`
// threw an opaque `TypeError: schema._def.shape is not a function`.
//
// SMI-7168: the repo now runs a single zod major (4.x), so this converts with
// zod's own `z.toJSONSchema` instead of the MCP SDK's v3/v4 compat layer. Two
// options carry the wire contract (pinned by server.schema-contract.test.ts):
//   - `io: 'input'` describes what a CLIENT sends. `io: 'output'` would mark a
//     defaulted field (`mode`) as required, which is false for callers.
//   - zod 4 omits `additionalProperties` in input mode, where zod 3 emitted
//     `false`. The override restores it for every object that did not set it,
//     so a closed argument object stays closed on the wire.
// The two fail-loud branches below stay: an unrecognised schema (a zod 3
// instance, i.e. major drift) and a recognised schema that will not convert
// must never degrade to an unbounded free-form object.
function isZodObjectSchema(schema: unknown): boolean {
  const internals = (schema as { _zod?: { def?: { type?: unknown } } } | null | undefined)?._zod
  return internals?.def?.type === 'object'
}

type JsonSchemaOverride = NonNullable<NonNullable<Parameters<typeof z.toJSONSchema>[1]>['override']>

const closeObjects: JsonSchemaOverride = (ctx) => {
  if (
    ctx.zodSchema._zod.def.type === 'object' &&
    ctx.jsonSchema.additionalProperties === undefined
  ) {
    ctx.jsonSchema.additionalProperties = false
  }
}

const REMEDIATION =
  'Run:\n\n' +
  '    From the MAIN checkout, not this worktree if you are in one:\n' +
  '    docker compose --profile dev up -d\n' +
  '    docker exec skillsmith-dev-1 sh -c "sh scripts/lib/node-modules-mount-gate.sh && rm -rf /app/packages/doc-retrieval-mcp/node_modules/zod && npm install"\n\n'

// The parameter is narrowed to object schemas: tool arguments are always an object, and the
// runtime guard below enforces it for callers that cast around the type.
export function jsonSchemaOf(schema: z.ZodObject): Record<string, unknown> {
  if (!isZodObjectSchema(schema)) {
    throw new Error(
      '[doc-retrieval] jsonSchemaOf: schema not recognized as a zod v4 object schema ' +
        '— possible zod version drift. ' +
        REMEDIATION +
        '(packages/doc-retrieval-mcp declares zod 4.x — this fires when a zod 3 install ' +
        'resolves instead. See CLAUDE.md > Troubleshooting.)'
    )
  }
  try {
    return z.toJSONSchema(schema, {
      target: 'draft-7',
      io: 'input',
      override: closeObjects,
    }) as Record<string, unknown>
  } catch (err) {
    throw new Error(
      '[doc-retrieval] jsonSchemaOf: failed to convert a recognized zod schema to ' +
        'JSON Schema. ' +
        REMEDIATION +
        '(possible zod version drift, or a type JSON Schema cannot represent — ' +
        `original error: ${err instanceof Error ? err.message : String(err)})`
    )
  }
}

async function main(): Promise<void> {
  const server = new Server(
    { name: 'skillsmith-doc-retrieval', version: '0.0.1' },
    { capabilities: { tools: {} } }
  )
  server.setRequestHandler(ListToolsRequestSchema, handleListTools)
  server.setRequestHandler(CallToolRequestSchema, handleCallTool)
  // SMI-5039: eager probe BEFORE server.connect so the module-load cache is
  // warm and the first skill_docs_search call doesn't race cold transformers
  // init. The probe is hard-bounded at 2 s and can never throw — see
  // @skillsmith/core/embeddings/probe for contract guarantees. Stderr-only;
  // MCP stdio protocol invariant (R2) preserved.
  await probeEmbeddingCapability()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

// SMI-5718: entry-point guard — only run main() when this file is the
// process's actual entry point (`node dist/src/server.js`), not when it's
// imported (e.g. by server.test.ts to exercise handleListTools/jsonSchemaOf
// without opening a real stdio transport). @skillsmith/mcp-server's
// index.ts predates this guard and calls main() unconditionally too, but
// nothing there imports it as a module either — this file needs the guard
// specifically because its regression tests (below) import it directly.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error('[doc-retrieval] fatal:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
