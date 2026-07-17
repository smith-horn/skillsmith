#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
// SMI-5718: use the SDK's own v3/v4-aware compat layer instead of hand-reaching
// into zod internals — see jsonSchemaOf() below for the incident this replaces.
import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
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

// SMI-5718: this used to be a hand-rolled converter that reached directly
// into zod v3-only internals (`_def.shape` as a callable thunk). When the
// pinned `zod@3.25.76` dependency went missing (SMI-5452 bind-mount npm
// race) and resolution fell through to a hoisted zod v4, that internal
// shape no longer existed and the call threw an opaque
// `TypeError: schema._def.shape is not a function` on `tools/list`.
// `@modelcontextprotocol/sdk` (already a dependency here) ships its own
// actively-maintained v3/v4 compat layer, used internally by its own
// `McpServer.registerTool()` — this now uses the exact same call
// convention (`normalizeObjectSchema` + `toJsonSchemaCompat`, same options)
// so this file's hand-registered tools produce schema output consistent
// with what the SDK's own high-level API would produce.
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  // `as never`: normalizeObjectSchema's generic signature triggers TS2589
  // ("Type instantiation is excessively deep and possibly infinite") against
  // zod's own recursive types when called with this file's concrete
  // SearchArgs/ReindexArgs/StatusArgs shapes (verified via `tsc --noEmit`).
  // normalizeObjectSchema duck-types its argument at runtime regardless of
  // the static type, so the cast does not weaken the runtime check below.
  const obj = normalizeObjectSchema(schema as never)
  if (!obj) {
    // normalizeObjectSchema returns undefined for anything it can't
    // recognize as a v3/v4 object schema or a raw shape — including the
    // exact zod-version-drift shape this issue is about (a schema whose
    // `_def`/`_zod` internals don't match either major). Fail loud here,
    // not just in the try/catch below, so no unrecognized-schema case
    // silently degrades to an unbounded free-form object — that silent
    // degradation is exactly the kind of masked failure this issue exists
    // to eliminate.
    throw new Error(
      '[doc-retrieval] jsonSchemaOf: schema not recognized as a zod v3/v4 object schema ' +
        '— possible zod version drift. Run:\n\n' +
        '    rm -rf packages/doc-retrieval-mcp/node_modules/zod\n' +
        '    docker compose --profile dev up -d\n' +
        '    docker exec skillsmith-dev-1 npm install\n\n' +
        '(packages/doc-retrieval-mcp pins zod@3.25.76 — this fires when a hoisted ' +
        'different-major zod resolves instead. See CLAUDE.md > Troubleshooting.)'
    )
  }
  try {
    return toJsonSchemaCompat(obj, { strictUnions: true, pipeStrategy: 'input' }) as Record<
      string,
      unknown
    >
  } catch (err) {
    // A recognized schema that still fails conversion — e.g. a
    // zod-to-json-schema internal error. Fail loud with a diagnosable
    // message instead of letting a native error propagate unlabeled.
    throw new Error(
      '[doc-retrieval] jsonSchemaOf: failed to convert a recognized zod schema to ' +
        'JSON Schema. Run:\n\n' +
        '    rm -rf packages/doc-retrieval-mcp/node_modules/zod\n' +
        '    docker compose --profile dev up -d\n' +
        '    docker exec skillsmith-dev-1 npm install\n\n' +
        '(possible zod version drift, or a zod-to-json-schema conversion bug — ' +
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
