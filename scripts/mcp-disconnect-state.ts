#!/usr/bin/env tsx
/**
 * SMI-5941 MCP live-disconnect detection — thin tsx CLI over the shared state module.
 *
 * Called by `scripts/session-mcp-disconnect-guard.sh` to record a disconnect,
 * and by `scripts/session-priming-query.ts` (direct import, not this CLI) to
 * read/acknowledge state for the SessionStart banner — this CLI only needs the
 * producer-side `record` subcommand plus `ack` for manual/test use.
 *
 * Subcommands (all accept `--repo-key <key>`; `record` and `ack` also take `--server <name>`):
 *   record  → `--tool <name> --error <text> [--timestamp <iso>]`; records a disconnect, prints
 *             `recorded` or `skipped` (lock-timeout — fail-soft, caller's systemMessage still fires)
 *   ack     → prints the rendered SessionStart banner line, or nothing if there's nothing to report
 *
 * Always exits 0 and degrades safely: unknown/missing repo key or server → no-op, print nothing.
 */

import { parseArgs } from 'node:util'
import {
  readAndAck,
  recordDisconnect,
  renderDisconnectBanner,
  type McpServerName,
} from '../packages/doc-retrieval-mcp/src/retrieval-log/mcp-disconnect-state.js'

function isServerName(v: unknown): v is McpServerName {
  return v === 'skillsmith' || v === 'skillsmith-doc-retrieval'
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2)
  let values: Record<string, string | undefined> = {}
  try {
    ;({ values } = parseArgs({
      args: rest,
      options: {
        'repo-key': { type: 'string' },
        server: { type: 'string' },
        tool: { type: 'string' },
        error: { type: 'string' },
        timestamp: { type: 'string' },
      },
      strict: false,
    }) as { values: Record<string, string | undefined> })
  } catch {
    return // Fall through to no-op below — safe defaults.
  }

  const repoKey = values['repo-key']
  const server = values.server
  if (!repoKey || !isServerName(server)) return

  if (command === 'record') {
    const tool = values.tool ?? ''
    const error = values.error ?? ''
    const timestamp = values.timestamp ?? new Date().toISOString()
    const persisted = recordDisconnect(repoKey, server, { tool, errorExcerpt: error, timestamp })
    process.stdout.write(persisted ? 'recorded' : 'skipped')
    return
  }

  if (command === 'ack') {
    const entry = readAndAck(repoKey, server)
    if (entry) process.stdout.write(renderDisconnectBanner(server, entry))
    return
  }

  // Unknown command — print nothing, exit 0.
}

main()
