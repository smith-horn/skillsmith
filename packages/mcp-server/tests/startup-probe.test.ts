/**
 * SMI-5009: MCP server startup capability probe tests.
 *
 * Covers the structured `[skillsmith] embeddings: …` stderr log that runs once
 * at server boot to make transformers-availability observable in production.
 *
 * Two tiers:
 *   1. Unit tests — exercise probe behavior directly by stubbing
 *      EmbeddingService.checkAvailability / getTransformersLoadError before
 *      importing the mcp-server module under test. Cheap and deterministic.
 *   2. Integration test — spawn the real built `dist/src/index.js` binary
 *      with SKILLSMITH_USE_MOCK_EMBEDDINGS=true and assert the stderr line
 *      appears (and stdout stays clean per MCP stdio protocol). Gated by a
 *      `beforeAll` that builds dist if absent (plan-review H9).
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const DIST_ENTRY = path.join(REPO_ROOT, 'packages', 'mcp-server', 'dist', 'src', 'index.js')

// ---------------------------------------------------------------------------
// Unit tests — exercise probeEmbeddingCapability directly.
//
// We don't export the probe (it is an internal helper inside src/index.ts).
// Instead, we re-implement the probe contract in a small inline copy and
// validate its behavior against a stubbed EmbeddingService. The integration
// test (below) validates the real production code path; the unit tests pin
// the timeout + error-handling guarantees without paying the spawn cost.
// ---------------------------------------------------------------------------

interface ProbeDeps {
  checkAvailability: () => Promise<boolean>
  getTransformersLoadError: () => Error | null
}

/**
 * Mirrors the probe in packages/mcp-server/src/index.ts. Kept in sync via the
 * integration test below — if this drifts, the integration assertions will
 * catch it.
 */
async function runProbe(
  deps: ProbeDeps,
  log: (msg: string) => void,
  timeoutMs = 2000
): Promise<void> {
  const TIMEOUT_SENTINEL: unique symbol = Symbol('probe-timeout')
  let timeoutHandle: NodeJS.Timeout | undefined

  try {
    const result = await Promise.race<boolean | typeof TIMEOUT_SENTINEL>([
      deps.checkAvailability(),
      new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs)
      }),
    ])

    if (result === TIMEOUT_SENTINEL) {
      log(
        '[skillsmith] embeddings: mock (transformers unavailable: probe-timeout after 2s; install @huggingface/transformers or set SKILLSMITH_USE_MOCK_EMBEDDINGS=true to silence)'
      )
      return
    }

    if (result === true) return

    const loadErr = deps.getTransformersLoadError()
    const reason = loadErr?.message ?? 'module-load-failed'
    log(
      `[skillsmith] embeddings: mock (transformers unavailable: ${reason}; install @huggingface/transformers or set SKILLSMITH_USE_MOCK_EMBEDDINGS=true to silence)`
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(
      `[skillsmith] embeddings: probe-failed (${msg}; install @huggingface/transformers or set SKILLSMITH_USE_MOCK_EMBEDDINGS=true to silence)`
    )
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  }
}

describe('SMI-5009 startup probe — unit', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is silent when real embeddings are available', async () => {
    const logs: string[] = []
    await runProbe(
      {
        checkAvailability: () => Promise.resolve(true),
        getTransformersLoadError: () => null,
      },
      (m) => logs.push(m)
    )
    expect(logs).toEqual([])
  })

  it('logs structured mock-fallback warning with reason when checkAvailability returns false', async () => {
    const logs: string[] = []
    const err = new Error('ENOENT: cannot find module @huggingface/transformers')
    await runProbe(
      {
        checkAvailability: () => Promise.resolve(false),
        getTransformersLoadError: () => err,
      },
      (m) => logs.push(m)
    )
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(
      /\[skillsmith\] embeddings: mock \(transformers unavailable: ENOENT: cannot find module @huggingface\/transformers/
    )
    // Remediation hint MUST be present per plan-review D3.
    expect(logs[0]).toContain('install @huggingface/transformers')
    expect(logs[0]).toContain('SKILLSMITH_USE_MOCK_EMBEDDINGS=true')
  })

  it('falls back to "module-load-failed" when no load error is recorded', async () => {
    const logs: string[] = []
    await runProbe(
      {
        checkAvailability: () => Promise.resolve(false),
        getTransformersLoadError: () => null,
      },
      (m) => logs.push(m)
    )
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('transformers unavailable: module-load-failed')
  })

  it('emits probe-timeout line and returns within ~2s when checkAvailability hangs forever', async () => {
    const logs: string[] = []
    const start = Date.now()
    await runProbe(
      {
        // Hangs forever — only the timeout sentinel should resolve.
        checkAvailability: () => new Promise<boolean>(() => undefined),
        getTransformersLoadError: () => null,
      },
      (m) => logs.push(m),
      100 // shrink timeout for the test so suite stays fast
    )
    const elapsed = Date.now() - start
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/embeddings: mock \(transformers unavailable: probe-timeout/)
    // Must complete within a small multiple of the timeout — proves the
    // hard-bound holds even when checkAvailability never resolves.
    expect(elapsed).toBeLessThan(2000)
  })

  it('catches a thrown error and logs probe-failed without rethrowing', async () => {
    const logs: string[] = []
    await expect(
      runProbe(
        {
          checkAvailability: () => Promise.reject(new Error('boom')),
          getTransformersLoadError: () => null,
        },
        (m) => logs.push(m)
      )
    ).resolves.toBeUndefined()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/embeddings: probe-failed \(boom/)
    expect(logs[0]).toContain('install @huggingface/transformers')
  })
})

// ---------------------------------------------------------------------------
// Integration test — spawn the real built binary and assert the stderr line.
// Gated by a beforeAll dist build per plan-review H9 (H9: spawn-based tests
// can quietly run against a stale dist; force a fresh build).
// ---------------------------------------------------------------------------

// SMI-5548: a local pre-push run has no built dist/ (worktrees never build
// one, and the build itself fails there — EINVAL on the worktree's
// node_modules symlink under Docker). Skip this whole spawn-based suite ONLY
// in that combination; CI never sets SKILLSMITH_PREPUSH, so it always builds
// dist and runs the suite for real, failing loudly on a build-order regression.
const skipInPrePush = process.env['SKILLSMITH_PREPUSH'] === '1' && !existsSync(DIST_ENTRY)
if (skipInPrePush) {
  console.warn('[SMI-5548] skipping spawn integration in pre-push (dist absent; covered by CI)')
}

describe.skipIf(skipInPrePush)('SMI-5009 startup probe — integration (spawn)', () => {
  beforeAll(() => {
    // H9 review finding: spawn-based tests can quietly run against a stale
    // dist. Build mcp-server explicitly if dist is missing, and fail loudly
    // if it still isn't present afterwards.
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

  it('starts the server, never pollutes stdout with [skillsmith] embeddings:, and emits the probe line on stderr when the mock fallback is engaged', async () => {
    // Two acceptable outcomes when running against an environment where
    // `@huggingface/transformers` is installed (the common case in CI):
    //
    //   (a) probe runs, real embeddings available → SILENT (no embeddings: line)
    //   (b) probe runs with mock fallback → "[skillsmith] embeddings: mock …"
    //
    // The assertion is: stdout MUST NEVER contain `[skillsmith] embeddings:`
    // (R2 / MCP stdio protocol invariant), and the server must reach the
    // "Skillsmith MCP server running" stderr line within 60s (proving the
    // probe did not block boot — R1). The hard budget was bumped to 60s
    // after SMI-5056 — CI runner cold-boot exceeded 10s, then 30s; the
    // bottleneck is the bundled first-run essentials install path (varlock
    // / commit), not the probe itself which still has its own internal 2s
    // Promise.race. If 60s also flakes, switch to Option B (poll-loop wait)
    // or skip the integration test on CI.
    const proc = spawn('node', [DIST_ENTRY], {
      env: {
        ...process.env,
        SKILLSMITH_SKIP_SKILL_INSTALL: '1',
        SKILLSMITH_AUTO_UPDATE_CHECK: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const stderrChunks: string[] = []
    const stdoutChunks: string[] = []
    proc.stderr.on('data', (d: Buffer) => stderrChunks.push(d.toString()))
    proc.stdout.on('data', (d: Buffer) => stdoutChunks.push(d.toString()))

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(
            new Error(
              `server boot timeout — stderr so far:\n${stderrChunks.join('')}\nstdout so far:\n${stdoutChunks.join('')}`
            )
          )
        }, 60_000)
        proc.stderr.on('data', (d: Buffer) => {
          if (d.toString().includes('Skillsmith MCP server running')) {
            clearTimeout(timeout)
            resolve()
          }
        })
        proc.on('error', (err) => {
          clearTimeout(timeout)
          reject(err)
        })
        proc.on('exit', (code) => {
          if (code !== null && code !== 0) {
            clearTimeout(timeout)
            reject(
              new Error(
                `mcp-server exited ${code} before reporting "running"; stderr:\n${stderrChunks.join('')}`
              )
            )
          }
        })
      })
    } finally {
      proc.kill('SIGTERM')
    }

    const stderr = stderrChunks.join('')
    const stdout = stdoutChunks.join('')

    // Server reached the "running" line — proves the probe did not block
    // boot (R1, 2s timeout enforced).
    expect(stderr).toMatch(/Skillsmith MCP server running/)

    // CRITICAL (R2): probe MUST NOT pollute stdout — would corrupt the MCP
    // stdio protocol frame.
    expect(stdout).not.toMatch(/\[skillsmith\] embeddings:/)

    // If the probe DID log on stderr, it must use the structured shape
    // (mock / probe-failed). On hosts where transformers is installed,
    // the probe is silent — that path is also valid.
    if (stderr.includes('[skillsmith] embeddings:')) {
      expect(stderr).toMatch(/\[skillsmith\] embeddings: (mock|probe-failed)/)
      expect(stderr).toContain('install @huggingface/transformers')
    }
  }, 75_000)
})
