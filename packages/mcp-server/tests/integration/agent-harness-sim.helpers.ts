/**
 * SMI-5456 Wave 1 Step 6 — helpers for the L2a harness-simulation MCP client
 * (`agent-harness-sim.test.ts`). Split out per the 500-line file gate.
 *
 * Spawns the REAL built `@skillsmith/mcp-server` binary over stdio (no
 * mocks) and connects a genuine `@modelcontextprotocol/sdk` `Client` to it —
 * the same transport class a real harness uses.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/** `packages/mcp-server/tests/integration` -> repo root is 4 levels up. */
export const REPO_ROOT = join(__dirname, '..', '..', '..', '..')
export const DIST_ENTRY = join(REPO_ROOT, 'packages', 'mcp-server', 'dist', 'src', 'index.js')

/**
 * Build `@skillsmith/mcp-server` if `dist/src/index.js` is missing.
 * Mirrors `startup-probe.test.ts`'s beforeAll guard (plan-review H9: a
 * spawn-based test must never silently run against a stale/absent dist).
 *
 * SMI-5548: in a local pre-push run (SKILLSMITH_PREPUSH=1) with dist absent —
 * the normal state for a worktree, which never has a built dist/, and where
 * the build itself fails because the worktree's node_modules symlink is
 * EINVAL under Docker — this is a no-op. The caller (the suite-level
 * `describe.skipIf`) is responsible for skipping the suite in that same
 * condition; CI never sets SKILLSMITH_PREPUSH, so it always builds/throws
 * here exactly as before.
 */
export function ensureDistBuilt(): void {
  if (process.env['SKILLSMITH_PREPUSH'] === '1' && !existsSync(DIST_ENTRY)) {
    return
  }
  if (!existsSync(DIST_ENTRY)) {
    const build = spawnSync('npm', ['run', 'build', '--workspace=@skillsmith/mcp-server'], {
      stdio: 'inherit',
      cwd: REPO_ROOT,
    })
    if (build.status !== 0) {
      throw new Error('mcp-server build failed in beforeAll (agent-harness-sim.test.ts)')
    }
  }
  if (!existsSync(DIST_ENTRY)) {
    throw new Error(`Expected ${DIST_ENTRY} to exist after build`)
  }
}

/**
 * A simulated harness's `clientInfo` (sent during the real MCP `initialize`
 * handshake) plus a stable id used for marker-file `harness` hints and test
 * descriptions. Covers all seven Wave-1 targets (5 `HarnessId` + windsurf +
 * hermes, matching `McpHarnessId` in `agent-harness-targets.ts`).
 */
export interface HarnessCase {
  id: string
  clientInfo: { name: string; version: string }
}

export const HARNESS_CASES: readonly HarnessCase[] = [
  { id: 'claude-code', clientInfo: { name: 'claude-code', version: '2.1.0' } },
  { id: 'cursor', clientInfo: { name: 'cursor-vscode', version: '1.11.0' } },
  { id: 'codex', clientInfo: { name: 'codex-cli', version: '0.45.0' } },
  { id: 'copilot', clientInfo: { name: 'github-copilot-vscode', version: '1.9.0' } },
  { id: 'opencode', clientInfo: { name: 'opencode', version: '0.6.0' } },
  { id: 'hermes', clientInfo: { name: 'hermes-agent', version: '0.3.0' } },
  { id: 'windsurf', clientInfo: { name: 'windsurf', version: '1.8.0' } },
]

/**
 * A per-test isolated `HOME`. `getConfigDir()`/`getDefaultDbPath()` both
 * resolve off `os.homedir()`, which reads `$HOME` on Linux (the Docker CI/
 * dev target for this suite) — isolating it keeps the spawned server from
 * touching the real developer's `~/.skillsmith`.
 */
export function createIsolatedHome(prefix: string): { homeDir: string; cleanup: () => void } {
  const homeDir = mkdtempSync(join(tmpdir(), prefix))
  const skillsmithDir = join(homeDir, '.skillsmith')
  mkdirSync(skillsmithDir, { recursive: true })
  // Pre-seed the first-run marker so the spawned server's isFirstRun() is
  // false — skips runFirstTimeSetup()'s network-bound Tier-1 registry
  // installs (packages/mcp-server/src/onboarding/first-run.ts).
  writeFileSync(join(skillsmithDir, '.first-run-complete'), new Date().toISOString())
  return {
    homeDir,
    cleanup: () => rmSync(homeDir, { recursive: true, force: true }),
  }
}

/**
 * Explicit, minimal spawn env. `StdioClientTransport` only auto-inherits
 * `HOME/LOGNAME/PATH/SHELL/TERM/USER` (`getDefaultEnvironment()`) — everything
 * else must be listed here. Deliberately OMITS `SUPABASE_URL`,
 * `SUPABASE_ANON_KEY`, `POSTHOG_API_KEY`, and `SKILLSMITH_TELEMETRY_ENABLED`:
 * this is the consent-off/no-network-telemetry default every real install
 * starts from, and it is what lets the consent-gating assertions run fully
 * offline (see the file header of `agent-harness-sim.test.ts`).
 */
export function baseSpawnEnv(homeDir: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: homeDir,
    SKILLSMITH_DB_PATH: ':memory:',
    SKILLSMITH_AUTO_UPDATE_CHECK: 'false',
    SKILLSMITH_SKIP_SKILL_INSTALL: '1',
    SKILLSMITH_TOOL_PROFILE: 'agent',
  }
}

/**
 * Write a session marker file under `<homeDir>/.skillsmith/agent-markers/` —
 * the on-disk shape a harness's SessionStart hook writes
 * (`packages/core/src/telemetry/agent-marker.ts` `AgentMarkerFile`). This is
 * the PRIMARY marker channel for Wave 1 (Step-0 spike finding (e): no Tier-1
 * harness can inject `_meta` on a genuine tool call today).
 */
export function writeAgentMarkerFile(
  homeDir: string,
  opts: {
    sessionId: string
    harness: string
    agentSession?: boolean
    nudgeOrigin?: boolean
    triggerId?: string | null
    startedAt?: number
  }
): void {
  const dir = join(homeDir, '.skillsmith', 'agent-markers')
  mkdirSync(dir, { recursive: true })
  const file = {
    schema: 1,
    session_id: opts.sessionId,
    started_at: opts.startedAt ?? Date.now(),
    harness: opts.harness,
    agent_session: opts.agentSession ?? true,
    nudge_origin: opts.nudgeOrigin ?? false,
    trigger_id: opts.triggerId ?? null,
  }
  writeFileSync(join(dir, `${opts.sessionId}.json`), JSON.stringify(file))
}

/**
 * Minimal shape this suite actually consumes from a `tools/call` response.
 * The SDK's real `CallToolResult` type is a union across a legacy
 * (`toolResult`) and current (`content`) shape — narrower than what this
 * suite needs, so we only assert the fields we read.
 */
export interface ToolCallResultLike {
  isError?: boolean
  content?: unknown[]
  [key: string]: unknown
}

/** Minimal shape this suite consumes from a `tools/list` response. */
export interface ToolListResultLike {
  tools: Array<{ name: string; [key: string]: unknown }>
}

export interface HarnessConnection {
  client: Client
  listTools: () => Promise<ToolListResultLike>
  callTool: (params: {
    name: string
    arguments?: Record<string, unknown>
    _meta?: Record<string, unknown>
  }) => Promise<ToolCallResultLike>
  close: () => Promise<void>
}

/**
 * Spawn the real built server and connect a real MCP `Client`, performing a
 * genuine `initialize` handshake with `clientInfo` — exactly what a harness
 * does. `env` is intentionally required (not defaulted) so every call site
 * makes its isolation/consent posture explicit.
 */
export async function connectHarness(
  clientInfo: { name: string; version: string },
  env: Record<string, string>
): Promise<HarnessConnection> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [DIST_ENTRY],
    env,
    stderr: 'pipe',
  })
  const client = new Client(clientInfo)
  await client.connect(transport)

  return {
    client,
    listTools: async () => client.listTools() as Promise<ToolListResultLike>,
    callTool: async (params) => client.callTool(params) as Promise<ToolCallResultLike>,
    close: () => client.close(),
  }
}
