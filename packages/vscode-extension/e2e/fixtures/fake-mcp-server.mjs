#!/usr/bin/env node
/**
 * Dependency-free fake stdio MCP server for the VS Code extension E2E suite
 * (SMI-5331). The extension spawns this instead of `npx @skillsmith/mcp-server`
 * via `skillsmith.mcp.serverCommand=node` + `serverArgs=[<this file>]`.
 *
 * Protocol contract — must match src/mcp/McpClient.ts exactly or the consumer's
 * 30s request timeout hangs (slow/flaky e2e):
 *   - newline-delimited JSON-RPC 2.0 over stdin/stdout
 *   - echo `request.id` verbatim (consumer rejects responses with an unknown id,
 *     McpClient.ts handleResponse)
 *   - one '\n'-terminated JSON object per write, flushed per message
 *   - NEVER respond to a notification (no `id`), e.g. `notifications/initialized`
 *   - handshake order: initialize -> notifications/initialized -> tools/call
 *
 * Behavior is driven by request content + an optional `--scenario <name>` argv
 * (default `ok`; `isError` makes every tools/call return an isError envelope, to
 * exercise the extension's degraded-path UX). Received tool calls are appended to
 * a JSONL log (FAKE_MCP_LOG env, else a deterministic temp path) so specs can
 * assert what the extension actually sent (e.g. `confirmed: true`).
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
import { FAKE_MCP_LOG } from './fake-mcp-log-path.mjs'

const scenarioIdx = process.argv.indexOf('--scenario')
const SCENARIO = scenarioIdx !== -1 ? process.argv[scenarioIdx + 1] : 'ok'

// Fresh log per server process (one is spawned per MCP connection / VS Code
// session), so specs see only this run's calls.
try {
  mkdirSync(dirname(FAKE_MCP_LOG), { recursive: true })
  writeFileSync(FAKE_MCP_LOG, '')
} catch {
  /* best-effort; logging is diagnostic, never break the protocol */
}

function log(entry) {
  try {
    appendFileSync(FAKE_MCP_LOG, JSON.stringify(entry) + '\n')
  } catch {
    /* best-effort; never let logging break the protocol */
  }
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

// --- canned domain payloads (shapes mirror src/mcp/types.ts) ----------------
const RENAME_SUGGESTION = {
  collisionId: 'col-e2e-1',
  currentName: 'my-skill',
  suggested: 'acme/my-skill',
  reason: 'Namespace collision with another installed skill',
  entry: { identifier: 'my-skill', kind: 'skill', source_path: '~/.claude/skills/my-skill' },
}

const auditWithCollision = () => ({
  auditId: 'audit-e2e-1',
  reportPath: '',
  summary: { totalEntries: 2, totalFlags: 1, errorCount: 0, warningCount: 1, durationMs: 3 },
  exactCollisions: [],
  semanticCollisions: [],
  genericFlags: [],
  renameSuggestions: [RENAME_SUGGESTION],
  recommendedEdits: [],
})

const auditClean = () => ({
  auditId: 'audit-e2e-2',
  reportPath: '',
  summary: { totalEntries: 2, totalFlags: 0, errorCount: 0, warningCount: 0, durationMs: 2 },
  exactCollisions: [],
  semanticCollisions: [],
  genericFlags: [],
  renameSuggestions: [],
  recommendedEdits: [],
})

// Stateful: first audit surfaces the collision; after an apply + re-audit it's
// clean, so the apply spec can assert the panel re-rendered to the resolved state.
let inventoryAuditCalls = 0

function toolResult(params) {
  const name = params && params.name
  const args = (params && params.arguments) || {}
  log({ t: 'tools/call', name, args })

  if (SCENARIO === 'isError') {
    return {
      content: [{ type: 'text', text: `Error: ${name} failed (e2e isError scenario)` }],
      isError: true,
    }
  }

  switch (name) {
    case 'skill_inventory_audit': {
      inventoryAuditCalls += 1
      const payload = inventoryAuditCalls === 1 ? auditWithCollision() : auditClean()
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
    }
    case 'apply_namespace_rename':
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              preview: args.confirmed !== true,
              applied: args.confirmed === true,
              before: 'my-skill',
              after: 'acme/my-skill',
              target: 'my-skill',
            }),
          },
        ],
      }
    case 'apply_recommended_edit':
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              preview: args.confirmed !== true,
              applied: args.confirmed === true,
            }),
          },
        ],
      }
    default:
      // Benign success for tools the specs don't assert on.
      return { content: [{ type: 'text', text: JSON.stringify({ results: [], success: true }) }] }
  }
}

function handle(msg) {
  const { id, method, params } = msg
  // Notifications carry no id — never respond.
  if (id === undefined || id === null) {
    log({ t: 'notification', method })
    return
  }
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        // >= minServerVersion (0.4.9) so no update-prompt toast fires.
        serverInfo: { name: 'fake-skillsmith-mcp', version: '99.0.0' },
      },
    })
    return
  }
  if (method === 'tools/call') {
    send({ jsonrpc: '2.0', id, result: toolResult(params) })
    return
  }
  // Unknown method with an id — answer (empty) rather than hang the consumer.
  send({ jsonrpc: '2.0', id, result: {} })
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  const lines = buffer.split('\n')
  buffer = lines.pop() || ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let msg
    try {
      msg = JSON.parse(trimmed)
    } catch {
      continue
    }
    try {
      handle(msg)
    } catch (err) {
      log({ t: 'error', err: String(err) })
    }
  }
})
process.stdin.on('end', () => process.exit(0))
