/**
 * SMI-5787: integration coverage for the global uncaughtException /
 * unhandledRejection safety net (see shutdown.ts's installGlobalCrashHandlers).
 *
 * Spawns the real built `dist/src/index.js` binary — same pattern as
 * startup-probe.test.ts — with a test-only env var that forces each
 * condition 50ms after the server reports "running". Without the fix, both
 * conditions still crash the process (Node's own default behavior), but
 * leave nothing durable; the assertion here is that the crash is now
 * *logged* (stderr, mirroring the disk record) before the process exits with
 * a stable, non-zero code — not that a crash somehow stops being fatal.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { createIsolatedHome } from './integration/agent-harness-sim.helpers.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const DIST_ENTRY = path.join(REPO_ROOT, 'packages', 'mcp-server', 'dist', 'src', 'index.js')

// SMI-5548: no built dist/ in a local pre-push worktree run — see
// startup-probe.test.ts's identical gate for the full rationale.
const skipInPrePush = process.env['SKILLSMITH_PREPUSH'] === '1' && !existsSync(DIST_ENTRY)
if (skipInPrePush) {
  console.warn('[SMI-5548] skipping spawn integration in pre-push (dist absent; covered by CI)')
}

interface SpawnResult {
  stderr: string
  stdout: string
  exitCode: number | null
}

async function spawnForced(envVar: string): Promise<SpawnResult> {
  // SMI-5999: per-spawn isolated HOME, reusing agent-harness-sim.helpers.ts's
  // createIsolatedHome() (os.homedir() reads $HOME on the Linux Docker target).
  // These spawns previously shared the real `~/.skillsmith` with
  // startup-probe.test.ts's spawn: on a fresh HOME (new container / CI) two
  // concurrently-booting servers race schema init on the same skills.db and
  // the loser exits 1 with "UNIQUE constraint failed: schema_version.version"
  // before ever printing "running"; a mid-boot SIGKILL could likewise leave a
  // 0-byte skills.db that poisons every later spawn ("empty or corrupt").
  const { homeDir, cleanup: cleanupHome } = createIsolatedHome('skillsmith-crash-')

  const proc = spawn('node', [DIST_ENTRY], {
    env: {
      ...process.env,
      HOME: homeDir,
      SKILLSMITH_SKIP_SKILL_INSTALL: '1',
      SKILLSMITH_AUTO_UPDATE_CHECK: 'false',
      [envVar]: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const stderrChunks: string[] = []
  const stdoutChunks: string[] = []
  proc.stdout.on('data', (d: Buffer) => stdoutChunks.push(d.toString()))
  proc.stderr.on('data', (d: Buffer) => stderrChunks.push(d.toString()))

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    // SMI-5999: 60s budget, up from 15s — a pure timing-budget fix, not a
    // crash-handler bug. In isolation each spawn finishes in ~6-7s, but under
    // the full-package suite Vitest's worker parallelism runs this alongside
    // two heavy integration tests (agent-harness-sim ~50s,
    // security-acceptance-lost-update ~90s) whose CPU load starves the
    // spawned node process: at 15s it was SIGKILLed with stderr still EMPTY
    // (still in Node bootstrap, no real hang). That mid-boot SIGKILL can also
    // leave a 0-byte ~/.skillsmith/skills.db behind, cascading into
    // startup-probe.test.ts's "empty or corrupt" DB refusal. 60s matches
    // startup-probe.test.ts's boot budget (SMI-5056), which was bumped
    // 10s→30s→60s for the same contention class — 30s already flaked there.
    const timeout = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`server did not exit within 60s — stderr so far:\n${stderrChunks.join('')}`))
    }, 60_000)
    proc.on('exit', (code) => {
      clearTimeout(timeout)
      resolve(code)
    })
    proc.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  }).finally(() => {
    // Best-effort isolated-HOME cleanup (createIsolatedHome's cleanup() uses
    // force: true — Linux allows removing files the just-SIGKILLed process
    // may still have had open).
    cleanupHome()
  })

  return { stderr: stderrChunks.join(''), stdout: stdoutChunks.join(''), exitCode }
}

describe.skipIf(skipInPrePush)('SMI-5787 global crash handlers — integration (spawn)', () => {
  beforeAll(() => {
    if (!existsSync(DIST_ENTRY)) {
      const build = spawnSync('npm', ['run', 'build', '--workspace=@skillsmith/mcp-server'], {
        stdio: 'inherit',
        cwd: REPO_ROOT,
      })
      if (build.status !== 0) {
        throw new Error('mcp-server build failed in beforeAll')
      }
    }
    if (!existsSync(DIST_ENTRY)) {
      throw new Error(`Expected ${DIST_ENTRY} to exist after build`)
    }
  }, 120_000)

  it('logs and exits 1 on a forced uncaught exception after startup', async () => {
    const { stderr, stdout, exitCode } = await spawnForced('SKILLSMITH_TEST_FORCE_UNCAUGHT')

    // Proves the crash happened AFTER a normal startup, not instead of one.
    expect(stderr).toMatch(/Skillsmith MCP server running/)
    expect(stderr).toContain('[skillsmith] Uncaught exception — server exiting')
    expect(exitCode).toBe(1)
    // R2 invariant: never pollute the MCP stdio JSON-RPC channel.
    expect(stdout).not.toContain('[skillsmith] Uncaught exception')
    // SMI-5999: must exceed spawnForced's 60s internal budget (was 20s).
  }, 75_000)

  it('logs and exits 1 on a forced unhandled rejection after startup', async () => {
    const { stderr, stdout, exitCode } = await spawnForced(
      'SKILLSMITH_TEST_FORCE_UNHANDLED_REJECTION'
    )

    expect(stderr).toMatch(/Skillsmith MCP server running/)
    expect(stderr).toContain('[skillsmith] Unhandled promise rejection — server exiting')
    expect(exitCode).toBe(1)
    expect(stdout).not.toContain('[skillsmith] Unhandled promise rejection')
    // SMI-5999: must exceed spawnForced's 60s internal budget (was 20s).
  }, 75_000)
})
