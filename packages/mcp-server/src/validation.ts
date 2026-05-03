/**
 * @fileoverview Shared Zod `safeParse` envelope helper for MCP tool-dispatch.
 * @module @skillsmith/mcp-server/validation
 *
 * SMI-4313: Prior to this helper, ~20 tool-dispatch branches called
 * `schema.parse(args)` (throwing on invalid input). The outer catch at
 * `index.ts` flattened those `ZodError`s to plain-text `isError: true`
 * content, losing the structured issue array.
 *
 * This helper returns a discriminated union so every call site can
 * short-circuit to a structured error envelope on invalid input without
 * throwing. The envelope shape is aligned with the MCP protocol's
 * `CallToolResult` (`isError: true` + JSON-serialised body with
 * `error`, `tool`, and `issues[]`).
 *
 * Reference: `packages/mcp-server/src/tools/install.ts` uses an
 * application-level `InstallResult` envelope (different shape — that one
 * lives inside a successful tool response and signals application-level
 * failure). This helper is the protocol-level complement for the 9 direct
 * dispatch sites plus `withLicenseAndQuota`.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ZodType } from 'zod'

/**
 * Discriminated result of a `safeParseOrError` call.
 *
 * - `ok: true` — parse succeeded; `data` carries the typed payload.
 * - `ok: false` — parse failed; `response` is a ready-to-return
 *   `CallToolResult` with `isError: true` and a JSON body.
 */
export type SafeParseResult<T> = { ok: true; data: T } | { ok: false; response: CallToolResult }

/**
 * Run Zod `safeParse` at an MCP tool boundary and map failures to a
 * structured `CallToolResult` envelope.
 *
 * Envelope body shape (JSON-encoded in `content[0].text`):
 * ```json
 * {
 *   "error": "ValidationError",
 *   "tool": "<canonical tool name>",
 *   "issues": [
 *     { "path": "limit", "message": "...", "code": "..." },
 *     ...
 *   ]
 * }
 * ```
 *
 * Clients that `JSON.parse(content[0].text)` recover the issue array.
 * Clients that regex over the raw text still see human-readable messages
 * embedded in `issues[].message`.
 *
 * @param schema    Zod schema to validate against.
 * @param args      Raw MCP tool arguments (unknown at this layer).
 * @param toolName  Canonical registered MCP tool name for client correlation.
 * @returns `{ ok: true, data }` on success, `{ ok: false, response }` on failure.
 */
export function safeParseOrError<T>(
  schema: ZodType<T>,
  args: unknown,
  toolName: string
): SafeParseResult<T> {
  const parsed = schema.safeParse(args)
  if (parsed.success) {
    return { ok: true, data: parsed.data }
  }

  return {
    ok: false,
    response: {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              error: 'ValidationError',
              tool: toolName,
              issues: parsed.error.issues.map((issue) => ({
                path: issue.path.join('.'),
                message: issue.message,
                code: issue.code,
              })),
            },
            null,
            2
          ),
        },
      ],
    },
  }
}
