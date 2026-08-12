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

export interface ConnectHarnessOptions {
  /** Overrides `CONNECT_HARNESS_TIMEOUT_MS` for a single call (tests only). */
  timeoutMs?: number
}

export interface ConnectHarnessTimeoutDiagnostics {
  elapsedMs: number
  pid: number | null
  /** Trailing stderr captured from the spawned process up to the timeout. */
  stderr: string
}

/**
 * SMI-6002: thrown when `connectHarness()`'s own liveness budget
 * (`CONNECT_HARNESS_TIMEOUT_MS`) is exceeded. Carries the same
 * stderr/pid/elapsed diagnostics baked into the message as structured fields,
 * so a future caller can act on them programmatically instead of re-parsing
 * the message string.
 */
export class HarnessConnectTimeoutError extends Error {
  readonly diagnostics: ConnectHarnessTimeoutDiagnostics

  constructor(message: string, diagnostics: ConnectHarnessTimeoutDiagnostics) {
    super(message)
    this.name = 'HarnessConnectTimeoutError'
    this.diagnostics = diagnostics
  }
}

/**
 * SMI-6002: per-harness `connectHarness()` liveness budget. Sized from real
 * reproduction data across two independent protocols (all 7 harnesses each
 * run, exact `npx vitest run` invocations, see the Linear issue comment / PR
 * description for the full protocol and container/load-average numbers):
 *   - full `packages/mcp-server` suite running concurrently (75 files,
 *     1204 tests): 2.0-22.2s per harness across contention levels
 *   - `agent-harness-sim.test.ts` bundled with the other two historically-
 *     heavy integration files (`crash-handler-integration.test.ts`,
 *     `security-acceptance-lost-update.test.ts`) under genuine concurrent
 *     host load (3-6 sibling worktree containers, host load average ~16-100
 *     on a 10-core host, verified via `docker stats`/`uptime` at run time),
 *     3 repeated runs, 21 samples: min 10.0s, median 36.2s, max 60.3s (the
 *     60.3s sample — harness `hermes`, run 2 — occurred during a host-load
 *     spike to ~90-100, an unusually extreme but genuinely observed
 *     multi-session level, not synthetic)
 * The original SMI-5999-session observation (3 of 7 harnesses exceeding the
 * old 30s budget, file total ~194s) sits between these two protocols'
 * observed maxima — the second protocol's 60.3s sample is the closest
 * reproduction of that historical severity obtained so far. 120s gives real
 * headroom (~2x the single most extreme observed sample, ~5.4x the
 * full-suite protocol's max) without being unbounded, a contention allowance
 * rather than a performance target: `connectHarness()` spawns a real Node
 * child process and performs a genuine MCP `initialize` handshake, both
 * sensitive to host CPU scheduling delay under load, not to any defect in
 * the code under test. 21 samples is enough to characterize min/median/max
 * but not a defensible p99, so this is a deliberately round, generous number
 * rather than a tightly-fit percentile — matching the precedent already set
 * by this same file's `crash-handler-integration.test.ts` sibling, whose own
 * spawn-based outer `beforeAll` uses the same 120_000ms budget.
 */
export const CONNECT_HARNESS_TIMEOUT_MS = 120_000

/**
 * Spawn the real built server and connect a real MCP `Client`, performing a
 * genuine `initialize` handshake with `clientInfo` — exactly what a harness
 * does. `env` is intentionally required (not defaulted) so every call site
 * makes its isolation/consent posture explicit.
 *
 * SMI-6002: races the connect attempt against `CONNECT_HARNESS_TIMEOUT_MS`
 * (or `options.timeoutMs`) instead of relying solely on Vitest's own
 * `beforeAll` hook timeout. A Vitest hook timeout alone does NOT cancel the
 * in-flight `client.connect()` call or terminate the spawned child process —
 * it just stops waiting and marks the hook failed, leaving the process (and
 * this function's promise) running unobserved in the background. Racing
 * internally lets this function itself detect the overrun, capture
 * stderr/pid diagnostics at that moment, and terminate the spawned process
 * deterministically, regardless of whether Vitest's own hook timeout ever
 * fires (the caller sizes its hook timeout with headroom over this value).
 */
export async function connectHarness(
  clientInfo: { name: string; version: string },
  env: Record<string, string>,
  options: ConnectHarnessOptions = {}
): Promise<HarnessConnection> {
  const timeoutMs = options.timeoutMs ?? CONNECT_HARNESS_TIMEOUT_MS
  const startedAt = Date.now()

  const transport = new StdioClientTransport({
    command: 'node',
    args: [DIST_ENTRY],
    env,
    stderr: 'pipe',
  })

  const stderrChunks: Buffer[] = []
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  })

  const client = new Client(clientInfo)

  const cleanupTransport = async (): Promise<void> => {
    try {
      // Idempotent and safe even if the process never finished spawning —
      // StdioClientTransport#close() no-ops when there is nothing to kill.
      await transport.close()
    } catch (cleanupError) {
      // SMI-6002 (cross-model PR review): best-effort cleanup, but a
      // silently-swallowed failure here could mask a leaked spawned
      // process — surface it diagnostically instead of dropping it. The
      // caller's real error (timeout or connect failure) still takes
      // priority and is what actually gets thrown/rejected.
      console.error(
        `[connectHarness] cleanupTransport() failed (pid=${transport.pid ?? 'unassigned'}): ` +
          `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
      )
    }
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      const elapsedMs = Date.now() - startedAt
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim()
      // Mirrors the SMI-5999 investigation's "empty stderr at kill time =
      // still in Node bootstrap under contention, not a hang" check — an
      // empty capture here is itself diagnostic, not an absence of data.
      const stderrNote =
        stderr.length > 0
          ? stderr
          : '<empty — process likely still in Node bootstrap under contention, not a hang>'
      reject(
        new HarnessConnectTimeoutError(
          `connectHarness() exceeded its ${timeoutMs}ms liveness budget for ` +
            `clientInfo=${JSON.stringify(clientInfo)} (elapsedMs=${elapsedMs}, ` +
            `pid=${transport.pid ?? 'unassigned'}). stderr at timeout: ${stderrNote}`,
          { elapsedMs, pid: transport.pid, stderr }
        )
      )
    }, timeoutMs)
  })

  const connectPromise = client.connect(transport)

  try {
    await Promise.race([connectPromise, timeoutPromise])
  } catch (error) {
    await cleanupTransport()
    // If the timeout branch won the race, connectPromise is still pending
    // and will settle later (usually a rejection once the killed process's
    // stdio closes) — swallow it so it doesn't surface as an unhandled
    // rejection after this function has already thrown.
    void connectPromise.catch(() => undefined)
    throw error
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }

  return {
    client,
    listTools: async () => client.listTools() as Promise<ToolListResultLike>,
    callTool: async (params) => client.callTool(params) as Promise<ToolCallResultLike>,
    close: () => client.close(),
  }
}
