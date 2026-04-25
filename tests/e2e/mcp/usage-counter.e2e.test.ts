/**
 * E2E: API usage counter wire-up via the @skillsmith/mcp-server stdio surface.
 *
 * SMI-4462 Step 3 — covers path #3 (MCP/stdio).
 *
 * Spawns the built MCP server binary as a subprocess, attaches a JSON-RPC
 * client over stdio (via @modelcontextprotocol/sdk), invokes the `get_skill`
 * tool, and asserts the staging `user_api_usage.get_count` increments.
 *
 * Why `get_skill` instead of `search`: the MCP search tool falls through to
 * local SQLite when the API call shape doesn't match its filters; `get_skill`
 * always reaches the API first (see packages/mcp-server/src/tools/get-skill.ts
 * line 132). Cleaner +1 expectation.
 *
 * Auth: SKILLSMITH_API_KEY env on the spawned subprocess flows through
 * `getApiKey()` → `createApiClient` → X-API-Key header, exercising the same
 * auth-middleware → tier-cache → incrementUsageCounter wiring as production.
 *
 * Tagged `@e2e-usage-counter`; under the existing `tests/e2e/**` exclude in
 * vitest.config.ts so it stays out of `npm run preflight`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  provisionTestUser,
  cleanupTestUser,
  getUsageRow,
  stagingCredentialsAbsent,
  waitForCounterIncrement,
  type ProvisionedUser,
} from '../fixtures/usage-counter-fixture.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Built MCP server binary, relative to repo root.
const MCP_SERVER_BIN = resolve(__dirname, '../../../packages/mcp-server/dist/src/index.js')

const STAGING_SKILL_ID = process.env['SKILLSMITH_E2E_SKILL_ID'] ?? 'anthropic/commit'
const STAGING_BASE_URL =
  (process.env['STAGING_SUPABASE_URL']?.replace(/\/$/, '') ?? '') + '/functions/v1'

const skipReason = stagingCredentialsAbsent()
  ? 'staging credentials absent'
  : !existsSync(MCP_SERVER_BIN)
    ? `MCP server bin missing at ${MCP_SERVER_BIN} — run \`npm run build\` first`
    : null
const skipSuite = skipReason !== null

describe.skipIf(skipSuite)('@e2e-usage-counter MCP stdio → usage counter', () => {
  let user: ProvisionedUser
  let client: Client
  let transport: StdioClientTransport

  beforeAll(async () => {
    user = await provisionTestUser({ tier: 'community' })

    transport = new StdioClientTransport({
      command: process.execPath, // node
      args: [MCP_SERVER_BIN],
      env: {
        // Inherit minimum required for module resolution + native libs.
        PATH: process.env['PATH'] ?? '',
        HOME: process.env['HOME'] ?? '',
        NODE_PATH: process.env['NODE_PATH'] ?? '',
        // Point the spawned server at staging.
        SUPABASE_URL: process.env['STAGING_SUPABASE_URL'] ?? '',
        SKILLSMITH_API_BASE_URL: STAGING_BASE_URL,
        SKILLSMITH_API_KEY: user.apiKey,
        // Disable auto-update banner / posthog noise.
        SKILLSMITH_AUTO_UPDATE_CHECK: 'false',
        POSTHOG_DISABLED: 'true',
      },
      stderr: 'pipe',
    })

    client = new Client({ name: 'smi-4462-e2e-test', version: '1.0.0' }, { capabilities: {} })
    await client.connect(transport)
  }, 60_000)

  afterAll(async () => {
    try {
      await client?.close()
    } catch {
      // already closed
    }
    if (user?.userId) {
      await cleanupTestUser(user.userId)
    }
  }, 30_000)

  it('get_skill via MCP stdio increments user_api_usage.get_count', async () => {
    const before = await getUsageRow(user.userId)

    const response = await client.callTool({
      name: 'get_skill',
      arguments: { skill_id: STAGING_SKILL_ID },
    })
    expect(response).toBeDefined()
    expect(response.isError).not.toBe(true)

    await waitForCounterIncrement(user.userId, 'get_count', before.get_count + 1)
    const after = await getUsageRow(user.userId)
    expect(after.get_count).toBe(before.get_count + 1)
  }, 45_000)
})
